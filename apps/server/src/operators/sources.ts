import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sourceSchema, containsSecret } from '@agent18/knowledge';
import { AppError } from '@agent18/domain';
import type { OperatorPermission } from './permissions.js';
import type { OperatorSession } from './service.js';
export type KnowledgeOperation = <T>(
  req: FastifyRequest,
  permission: OperatorPermission,
  fn: (c: PoolClient, scope: [string, string], actor: OperatorSession) => Promise<T>,
) => Promise<T>;
const connectionInput = z.object({ source: sourceSchema, mode: z.enum(['extractive', 'model']) }).strict();
const sourceId = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
function validateConnection(input: z.infer<typeof connectionInput>) {
  if (
    input.source.audience !== 'internal' ||
    input.source.tenantIds.length ||
    input.source.id.startsWith('staff-')
  )
    throw new AppError('INVALID_REQUEST', 400);
  if (containsSecret(JSON.stringify(input))) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
  if (input.source.kind === 'git') {
    let url: URL;
    try {
      url = new URL(input.source.location);
    } catch {
      throw new AppError('KNOWLEDGE_SOURCE_URL_INVALID', 400);
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== '443')
    )
      throw new AppError('KNOWLEDGE_SOURCE_URL_INVALID', 400);
  }
}
export function registerOperatorSources(app: FastifyInstance, run: KnowledgeOperation) {
  const base = '/operator/projects/:key/knowledge';
  app.get(base + '/connections', (req) =>
    run(req, 'source.read', async (c) => {
      const { offset } = z
        .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
        .parse(req.query);
      const rows = (
        await c.query(
          `SELECT c.id,c.source_key,c.name,c.spec->>'kind' AS kind,c.mode,c.version,c.created_at,j.id AS job_id,j.state,j.build_id,j.error_code,j.started_at,j.completed_at
        FROM knowledge.connections c LEFT JOIN LATERAL(SELECT * FROM control.knowledge_jobs WHERE connection_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) j ON true ORDER BY c.created_at DESC,c.id LIMIT 51 OFFSET $1`,
          [offset],
        )
      ).rows;
      return { connections: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
    }),
  );
  app.get(base + '/connections/:id', (req) =>
    run(req, 'source.configure', async (c) => {
      const row = (
        await c.query('SELECT id,spec AS source,mode,version FROM knowledge.connections WHERE id=$1', [
          sourceId(req),
        ])
      ).rows[0];
      if (!row) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      return row;
    }),
  );
  app.post(base + '/connections', (req) => {
    const input = connectionInput.parse(req.body);
    validateConnection(input);
    return run(req, 'source.configure', async (c, scope, actor) => {
      if (
        (await c.query('SELECT id FROM knowledge.connections WHERE source_key=$1', [input.source.id]))
          .rowCount ||
        (await c.query('SELECT id FROM knowledge.sources WHERE source_key=$1', [input.source.id])).rowCount
      )
        throw new AppError('KNOWLEDGE_SOURCE_EXISTS', 409);
      const id = randomUUID(),
        job = randomUUID();
      await c.query(
        'INSERT INTO knowledge.connections(id,organization_id,project_id,source_key,name,spec,mode,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          ...scope,
          input.source.id,
          input.source.name,
          JSON.stringify(input.source),
          input.mode,
          actor.account.id,
        ],
      );
      await c.query(
        `INSERT INTO control.knowledge_jobs(id,connection_id,organization_id,project_id,actor_id,connection_version,source_input) SELECT $1,id,$3,$4,$5,version,jsonb_build_object('source',spec,'mode',mode) FROM knowledge.connections WHERE id=$2`,
        [job, id, ...scope, actor.account.id],
      );
      await audit(c, actor, 'knowledge.source.connect', id, req.id);
      return { id, jobId: job, state: 'queued' };
    });
  });
  app.post(base + '/connections/:id', (req) => {
    const input = connectionInput.extend({ version: z.number().int().positive() }).parse(req.body);
    validateConnection(input);
    return run(req, 'source.configure', async (c, scope, actor) => {
      const id = sourceId(req),
        old = (await c.query('SELECT * FROM knowledge.connections WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!old) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (old.version !== input.version) throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      if (old.source_key !== input.source.id || old.spec.kind !== input.source.kind)
        throw new AppError('SOURCE_IDENTITY_IMMUTABLE', 409);
      if (
        (
          await c.query(
            "SELECT id FROM control.knowledge_jobs WHERE connection_id=$1 AND state IN ('queued','running')",
            [id],
          )
        ).rowCount
      )
        throw new AppError('SOURCE_JOB_ACTIVE', 409);
      await c.query(
        'UPDATE knowledge.connections SET name=$2,spec=$3,mode=$4,version=version+1,updated_at=now() WHERE id=$1',
        [id, input.source.name, JSON.stringify(input.source), input.mode],
      );
      const job = randomUUID();
      await c.query(
        `INSERT INTO control.knowledge_jobs(id,connection_id,organization_id,project_id,actor_id,connection_version,source_input) SELECT $1,id,$3,$4,$5,version,jsonb_build_object('source',spec,'mode',mode) FROM knowledge.connections WHERE id=$2`,
        [job, id, ...scope, actor.account.id],
      );
      await audit(c, actor, 'knowledge.source.update', id, req.id);
      return { id, version: old.version + 1, jobId: job, state: 'queued' };
    });
  });
  app.post(base + '/connections/:id/scan', (req) => {
    z.object({}).strict().parse(req.body);
    return run(req, 'source.configure', async (c, scope, actor) => {
      const id = sourceId(req);
      if (!(await c.query('SELECT id FROM knowledge.connections WHERE id=$1 FOR UPDATE', [id])).rowCount)
        throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const pending = (
        await c.query(
          "SELECT id,state FROM control.knowledge_jobs WHERE connection_id=$1 AND state IN ('queued','running')",
          [id],
        )
      ).rows[0];
      if (pending) return { jobId: pending.id, state: pending.state };
      const job = randomUUID();
      await c.query(
        `INSERT INTO control.knowledge_jobs(id,connection_id,organization_id,project_id,actor_id,connection_version,source_input) SELECT $1,id,$3,$4,$5,version,jsonb_build_object('source',spec,'mode',mode) FROM knowledge.connections WHERE id=$2`,
        [job, id, ...scope, actor.account.id],
      );
      await audit(c, actor, 'knowledge.source.scan', id, req.id);
      return { jobId: job, state: 'queued' };
    });
  });
  app.post(base + '/jobs/:id/cancel', (req) => {
    z.object({}).strict().parse(req.body);
    return run(req, 'source.configure', async (c, _scope, actor) => {
      const id = sourceId(req),
        result = await c.query(
          "UPDATE control.knowledge_jobs SET state='cancelled',completed_at=now() WHERE id=$1 AND state IN ('queued','running') RETURNING id",
          [id],
        );
      if (!result.rowCount) throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
      await audit(c, actor, 'knowledge.source.cancel', id, req.id);
      return { state: 'cancelled' };
    });
  });
  app.get(base + '/builds/:id', (req) =>
    run(req, 'source.read', async (c) => {
      const { offset } = z
        .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
        .parse(req.query);
      const id = sourceId(req),
        build = (
          await c.query(
            `SELECT b.id,b.revision,b.state,b.mode,b.created_at,b.report->'files' AS files,b.report->'skipped' AS skipped,b.report->'articles' AS article_count,s.name FROM knowledge.builds b JOIN knowledge.sources s ON s.id=b.source_id WHERE b.id=$1`,
            [id],
          )
        ).rows[0];
      if (!build) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const rows = (
        await c.query(
          'SELECT id,title,body,category,refs,revision FROM knowledge.articles WHERE build_id=$1 ORDER BY title,id LIMIT 101 OFFSET $2',
          [id, offset],
        )
      ).rows;
      return {
        ...build,
        articles: rows.slice(0, 100),
        truncated: rows.length > 100,
        nextOffset: rows.length > 100 ? offset + 100 : null,
      };
    }),
  );
  app.post(base + '/articles/:id/draft', (req) => {
    z.object({}).strict().parse(req.body);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const id = sourceId(req),
        old = (await c.query('SELECT id FROM knowledge.documents WHERE origin_article_id=$1', [id])).rows[0];
      if (old) return { id: old.id };
      const article = (
        await c.query(
          "SELECT a.* FROM knowledge.articles a JOIN knowledge.builds b ON b.id=a.build_id WHERE a.id=$1 AND b.state='ready'",
          [id],
        )
      ).rows[0];
      if (!article) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (containsSecret(article.title + '\n' + article.body))
        throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
      const document = randomUUID(),
        snapshot = {
          title: article.title,
          body: article.body,
          category: article.category,
          audience: 'internal',
        };
      await c.query(
        `INSERT INTO knowledge.documents(id,organization_id,project_id,title,body,category,audience,updated_by,evidence,origin_article_id) VALUES($1,$2,$3,$4,$5,$6,'internal',$7,$8,$9)`,
        [
          document,
          ...scope,
          article.title,
          article.body,
          article.category,
          actor.account.id,
          JSON.stringify(article.refs),
          id,
        ],
      );
      await c.query(
        `INSERT INTO knowledge.document_history(id,document_id,organization_id,project_id,version,action,snapshot,actor_id) VALUES($1,$2,$3,$4,1,'import',$5,$6)`,
        [randomUUID(), document, ...scope, JSON.stringify(snapshot), actor.account.id],
      );
      await audit(c, actor, 'knowledge.import', document, req.id);
      return { id: document };
    });
  });
}
async function audit(c: PoolClient, actor: OperatorSession, action: string, id: string, requestId: string) {
  await c.query(
    'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), actor.account.id, action, id, requestId],
  );
}
