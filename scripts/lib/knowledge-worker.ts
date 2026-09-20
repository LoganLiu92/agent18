import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { scoped, type Database } from '@agent18/persistence';
import { KnowledgeIndexer, KnowledgeError, sourceSchema, type JsonModel } from '@agent18/knowledge';
import type { Config } from '../config.js';
export type KnowledgeWorkerOptions = {
  roots: string[];
  gitHosts: string[];
  cacheDirectory: string;
  model?: JsonModel;
  signal?: AbortSignal;
};
export async function processKnowledgeJob(
  db: Database,
  config: { projects: Pick<Config['projects'][number], 'organizationId' | 'projectId' | 'key'>[] },
  options: KnowledgeWorkerOptions,
): Promise<boolean> {
  // A lost worker leaves a visible failed task; retries require a fresh operator action.
  await db.query(
    "UPDATE control.knowledge_jobs SET state='failed',error_code='WORKER_INTERRUPTED',completed_at=now() WHERE state='running' AND lease_until<now()",
  );
  const lease = randomUUID();
  const job = (
    await db.query(
      `UPDATE control.knowledge_jobs SET state='running',started_at=now(),lease_id=$1,lease_until=now()+interval '35 minutes'
    WHERE id=(SELECT id FROM control.knowledge_jobs WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
      [lease],
    )
  ).rows[0];
  if (!job) return false;
  const abort = new AbortController();
  const stop = () => abort.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) abort.abort();
  let timer: ReturnType<typeof setInterval> | undefined,
    checking = false;
  async function authorized() {
    const row = (
      await db.query(
        `SELECT state,control.knowledge_job_actor_enabled(actor_id) AS allowed FROM control.knowledge_jobs WHERE id=$1 AND lease_id=$2`,
        [job.id, lease],
      )
    ).rows[0];
    return row?.state === 'running' && row.allowed;
  }
  try {
    const project = config.projects.find(
      (p) => p.organizationId === job.organization_id && p.projectId === job.project_id,
    );
    if (!project) throw new KnowledgeError('PROJECT_NOT_FOUND');
    if (!(await authorized())) throw new KnowledgeError('SOURCE_ACTOR_REVOKED');
    const scope = { ...project, tenantId: 'operator', subject: 'knowledge-job:' + job.id };
    const connection = await scoped(
      db,
      scope,
      async (c) =>
        (await c.query('SELECT spec,mode FROM knowledge.connections WHERE id=$1', [job.connection_id]))
          .rows[0],
    );
    if (!connection) throw new KnowledgeError('SOURCE_NOT_FOUND');
    const frozen = job.source_input as { source: unknown; mode: 'extractive' | 'model' } | null;
    const source = sourceSchema.parse(frozen?.source ?? connection.spec);
    if (frozen) connection.mode = frozen.mode;
    if (source.kind === 'directory') {
      if (!isAbsolute(source.location)) throw new KnowledgeError('SOURCE_ROOT_NOT_ALLOWED');
      const location = await realpath(source.location),
        roots = await Promise.all(options.roots.map((r) => realpath(r)));
      if (
        !roots.some((root) => {
          const path = relative(root, location);
          return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
        })
      )
        throw new KnowledgeError('SOURCE_ROOT_NOT_ALLOWED');
      source.location = location;
    } else {
      const url = new URL(source.location);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.port && url.port !== '443') ||
        !options.gitHosts.includes(url.hostname)
      )
        throw new KnowledgeError('SOURCE_HOST_NOT_ALLOWED');
    }
    abort.signal.throwIfAborted();
    timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void authorized()
        .then((ok) => {
          if (!ok) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          checking = false;
        });
    }, 1500);
    const timeout = setTimeout(() => abort.abort(), 30 * 60_000);
    let result: Awaited<ReturnType<KnowledgeIndexer['sync']>>;
    try {
      result = await new KnowledgeIndexer(db, scope, options.cacheDirectory, options.model).sync(
        source,
        { mode: connection.mode, maxModelCalls: 100 },
        abort.signal,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!(await authorized())) throw new KnowledgeError('SOURCE_ACTOR_REVOKED');
    await db.query(
      "UPDATE control.knowledge_jobs SET state='succeeded',build_id=$3,completed_at=now() WHERE id=$1 AND lease_id=$2 AND state='running'",
      [job.id, lease, result.buildId],
    );
  } catch (error) {
    const code =
      error instanceof KnowledgeError
        ? error.code
        : abort.signal.aborted
          ? 'BUILD_CANCELLED'
          : 'SOURCE_SCAN_FAILED';
    await db.query(
      "UPDATE control.knowledge_jobs SET state='failed',error_code=$3,completed_at=now() WHERE id=$1 AND lease_id=$2 AND state='running'",
      [job.id, lease, code],
    );
  } finally {
    if (timer) clearInterval(timer);
    options.signal?.removeEventListener('abort', stop);
  }
  return true;
}
