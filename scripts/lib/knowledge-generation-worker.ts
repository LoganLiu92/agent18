import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Database } from '@agent18/persistence';
import {
  KnowledgeError,
  hash,
  topicGenerationPrompt,
  validateGenerationInput,
  validateGenerationOutput,
  type JsonModel,
} from '@agent18/knowledge';
export async function processGenerationJob(
  db: Database,
  config: { projects: Pick<Config['projects'][number], 'organizationId' | 'projectId' | 'key'>[] },
  options: { model?: JsonModel; signal?: AbortSignal },
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  await db.query(
    "UPDATE control.knowledge_generation_jobs SET state='failed',error_code='WORKER_INTERRUPTED',completed_at=now() WHERE state='running' AND lease_until<now()",
  );
  const lease = randomUUID();
  const job = (
    await db.query(
      `UPDATE control.knowledge_generation_jobs SET state='running',started_at=now(),lease_id=$1,lease_until=now()+interval '6 minutes'
    WHERE id=(SELECT id FROM control.knowledge_generation_jobs WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
      [lease],
    )
  ).rows[0];
  if (!job) return false;
  const abort = new AbortController(),
    stop = () => abort.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) abort.abort();
  const timeout = setTimeout(stop, 5 * 60_000);
  let checking = false;
  async function authorized() {
    const row = (
      await db.query(
        `SELECT state,control.knowledge_generation_actor_enabled(actor_id,organization_id,project_id) AS allowed FROM control.knowledge_generation_jobs WHERE id=$1 AND lease_id=$2`,
        [job.id, lease],
      )
    ).rows[0];
    return row?.state === 'running' && row.allowed;
  }
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void authorized()
      .then((ok) => {
        if (!ok) abort.abort();
      })
      .catch(stop)
      .finally(() => {
        checking = false;
      });
  }, 1000);
  try {
    if (
      !config.projects.some((p) => p.organizationId === job.organization_id && p.projectId === job.project_id)
    )
      throw new KnowledgeError('PROJECT_NOT_FOUND');
    if (!(await authorized())) throw new KnowledgeError('GENERATION_ACTOR_REVOKED');
    if (!options.model) throw new KnowledgeError('MODEL_NOT_CONFIGURED');
    const input = validateGenerationInput(job.input);
    abort.signal.throwIfAborted();
    const response = await options.model.complete(
      topicGenerationPrompt,
      { ...input, audience: 'internal' },
      abort.signal,
    );
    abort.signal.throwIfAborted();
    const output = validateGenerationOutput(response.value, input);
    // Serialize the final check with employee role changes; cancellation also locks this job row.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(181819)');
      await client.query(
        `UPDATE control.knowledge_generation_jobs SET state='succeeded',result=$3,completed_at=now()
        WHERE id=$1 AND lease_id=$2 AND state='running' AND control.knowledge_generation_actor_enabled(actor_id,organization_id,project_id)`,
        [
          job.id,
          lease,
          JSON.stringify({
            output,
            model: { identity: options.model.identity, name: options.model.name ?? null },
            promptHash: hash(topicGenerationPrompt),
            calls: 1,
            tokens: response.tokens,
          }),
        ],
      );
      await client.query(
        "UPDATE control.knowledge_generation_jobs SET state='failed',error_code='GENERATION_ACTOR_REVOKED',completed_at=now() WHERE id=$1 AND lease_id=$2 AND state='running'",
        [job.id, lease],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const code =
      error instanceof KnowledgeError
        ? error.code
        : abort.signal.aborted
          ? 'GENERATION_CANCELLED'
          : 'GENERATION_FAILED';
    await db.query(
      "UPDATE control.knowledge_generation_jobs SET state='failed',error_code=$3,completed_at=now() WHERE id=$1 AND lease_id=$2 AND state='running'",
      [job.id, lease, code],
    );
  } finally {
    clearTimeout(timeout);
    clearInterval(timer);
    options.signal?.removeEventListener('abort', stop);
  }
  return true;
}
