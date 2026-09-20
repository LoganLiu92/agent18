import { publishDocument } from './document-publication.js';
import { registerDiscovery } from './discovery.js';
import { registerPublicationSets } from './publication-sets.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import { categories, containsSecret } from '@agent18/knowledge';
import type { OperatorService, OperatorSession } from './service.js';
import type { OperatorPermission } from './permissions.js';
import { registerOperatorSources } from './sources.js';
import { registerOperatorTopics } from './topics.js';
import { registerOperatorEvaluation } from './evaluation.js';
import { registerOperatorConflicts } from './conflicts.js';
import { registerOperatorFreshness } from './freshness.js';
import { registerOperatorDerivation } from './derivation.js';
import { registerOperatorGeneration } from './generation.js';
import { registerOperatorEvidence } from './evidence.js';

const params = z.object({ key: z.string().min(1), id: z.string().uuid().optional() });
const content = z
  .object({
    title: z.string().trim().min(2).max(200),
    body: z.string().trim().min(10).max(60000),
    category: z.enum(categories),
    audience: z.enum(['internal', 'customer']),
  })
  .strict();
const mutation = z
  .object({
    version: z.number().int().positive(),
    action: z.enum(['save', 'submit', 'return', 'approve', 'publish', 'revoke', 'restore']),
    content: content.optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
    fromVersion: z.number().int().positive().optional(),
  })
  .strict();

export function registerOperatorKnowledge(
  app: FastifyInstance,
  service: OperatorService,
  session: (req: FastifyRequest) => OperatorSession,
) {
  async function run<T>(
    req: FastifyRequest,
    permission: OperatorPermission,
    fn: (c: PoolClient, scope: [string, string], actor: OperatorSession) => Promise<T>,
  ) {
    const { key } = params.parse(req.params),
      actor = session(req);
    return service.withPermission(actor, key, permission, async (c, p) => {
      await c.query(
        "SELECT set_config('agent18.organization_id',$1,true),set_config('agent18.project_id',$2,true),set_config('agent18.operator_session',$3,true),set_config('statement_timeout','5000',true)",
        [p.organizationId, p.projectId, actor.tokenHash],
      );
      return fn(c, [p.organizationId, p.projectId], actor);
    });
  }
  registerOperatorSources(app, run);
  registerOperatorTopics(app, run);
  registerDiscovery(app, run);
  registerPublicationSets(app, run);
  registerOperatorEvidence(app, run);
  registerOperatorGeneration(app, run);
  registerOperatorDerivation(app, run);
  registerOperatorFreshness(app, run);
  registerOperatorConflicts(app, run);
  registerOperatorEvaluation(app, run);
  app.get('/operator/projects/:key/workspace', (req) =>
    service.withPermission(session(req), params.parse(req.params).key, 'project.read', async (_c, p) => ({
      key: p.key,
      name: p.displayName ?? p.key,
      knowledge: p.knowledge,
      integrations: [
        {
          key: 'knowledge',
          name: '知识检索',
          configured: p.knowledge === 'indexed',
          detail: p.knowledge === 'indexed' ? '使用已发布的项目知识' : '当前使用演示资料',
        },
        {
          key: 'identity',
          name: '网站客户身份',
          configured: p.jwks.keys.length > 0,
          detail: '客户身份与后台工作人员账号分离',
        },
        {
          key: 'queries',
          name: '业务查询 API',
          configured: !!p.businessQueries,
          detail: '只读查询通过已审核的业务接口执行',
        },
        {
          key: 'actions',
          name: '业务办理 API',
          configured: !!p.businessBridge,
          detail: '业务操作保留提案、审批与执行边界',
        },
        {
          key: 'observability',
          name: '日志与指标',
          configured: !!p.operations,
          detail: 'Loki / Prometheus 按项目配置；配置存在不代表连接健康',
        },
      ],
    })),
  );
  app.get('/operator/projects/:key/knowledge', (req) =>
    run(req, 'source.read', async (c) => {
      const sources = (
        await c.query(`SELECT s.id,s.source_key AS key,s.name,s.audience,s.enabled,s.active_build_id,
      b.revision,b.created_at AS observed_at,b.mode,
      (SELECT count(*)::int FROM knowledge.articles a WHERE a.build_id=s.active_build_id) AS articles,
      (SELECT state FROM knowledge.builds lb WHERE lb.source_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_state
      FROM knowledge.sources s LEFT JOIN knowledge.builds b ON b.id=s.active_build_id ORDER BY s.name,s.id LIMIT 201`)
      ).rows;
      const articles = (
        await c.query(`SELECT a.id,a.title,a.category,a.revision,a.created_at,s.name AS source_name,s.audience
      FROM knowledge.articles a JOIN knowledge.sources s ON s.id=a.source_id AND s.active_build_id=a.build_id
      WHERE s.enabled ORDER BY a.title,a.id LIMIT 501`)
      ).rows;
      const documents = (
        await c.query(
          `SELECT id,title,category,audience,version,state,published_build_id,updated_at FROM knowledge.documents ORDER BY updated_at DESC,id LIMIT 201`,
        )
      ).rows;
      const counts = (
        await c.query(`SELECT (SELECT count(*)::int FROM knowledge.sources) AS sources,
      (SELECT count(*)::int FROM knowledge.articles a JOIN knowledge.sources s ON s.id=a.source_id AND s.active_build_id=a.build_id WHERE s.enabled) AS articles,
      (SELECT count(*)::int FROM knowledge.documents WHERE state='in_review') AS reviews,
      (SELECT count(*)::int FROM knowledge.documents WHERE state='draft') AS drafts`)
      ).rows[0];
      return {
        sources: sources.slice(0, 200),
        articles: articles.slice(0, 500),
        documents: documents.slice(0, 200),
        counts,
        truncated: sources.length > 200 || articles.length > 500 || documents.length > 200,
      };
    }),
  );
  app.get('/operator/projects/:key/knowledge/articles/:id', (req) =>
    run(req, 'source.read', async (c) => {
      const id = params.parse(req.params).id;
      const row = (
        await c.query(
          `SELECT a.id,a.title,a.body,a.category,a.revision,a.refs,a.created_at,s.name AS source_name,s.audience,
      b.mode,b.report->'provenance' AS provenance
      FROM knowledge.articles a JOIN knowledge.sources s ON s.id=a.source_id AND s.active_build_id=a.build_id
      JOIN knowledge.builds b ON b.id=a.build_id WHERE a.id=$1 AND s.enabled`,
          [id],
        )
      ).rows[0];
      if (!row) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      return row;
    }),
  );
  app.get('/operator/projects/:key/knowledge/documents/:id', (req) =>
    run(req, 'source.read', async (c) => {
      const id = params.parse(req.params).id;
      const row = (await c.query('SELECT * FROM knowledge.documents WHERE id=$1', [id])).rows[0];
      if (!row) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const history = (
        await c.query(
          `SELECT h.version,h.action,h.reason,h.restored_from,h.created_at,a.display_name AS actor FROM knowledge.document_history h JOIN control.operator_accounts a ON a.id=h.actor_id WHERE document_id=$1 ORDER BY h.created_at DESC,h.id DESC LIMIT 100`,
          [id],
        )
      ).rows;
      const derivation = row.derived_from_document_id
        ? (
            await c.query('SELECT id,title,version,state FROM knowledge.documents WHERE id=$1', [
              row.derived_from_document_id,
            ])
          ).rows[0]
        : null;
      return {
        ...row,
        history,
        derivation,
        derivationChanged: !!derivation && derivation.version !== row.derived_from_version,
      };
    }),
  );
  app.get('/operator/projects/:key/knowledge/documents/:id/revisions/:version', (req) =>
    run(req, 'source.read', async (c) => {
      const { id, version } = z
        .object({ id: z.string().uuid(), version: z.coerce.number().int().positive() })
        .parse(req.params);
      const row = (
        await c.query(
          `SELECT h.version,h.action,h.reason,h.restored_from,h.snapshot,h.created_at,a.display_name AS actor
      FROM knowledge.document_history h JOIN control.operator_accounts a ON a.id=h.actor_id WHERE h.document_id=$1 AND h.version=$2`,
          [id, version],
        )
      ).rows[0];
      if (!row) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      return row;
    }),
  );
  app.post('/operator/projects/:key/knowledge/documents', { bodyLimit: 260000 }, (req) => {
    const draft = content.parse(req.body);
    if (containsSecret(draft.title + '\n' + draft.body)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const id = randomUUID();
      await c.query(
        'INSERT INTO knowledge.documents(id,organization_id,project_id,title,body,category,audience,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, ...scope, draft.title, draft.body, draft.category, draft.audience, actor.account.id],
      );
      await record(c, id, scope, actor, 1, 'created', draft, req.id);
      return { id };
    });
  });
  app.post('/operator/projects/:key/knowledge/documents/:id', { bodyLimit: 260000 }, (req) => {
    const input = mutation.parse(req.body),
      id = params.parse(req.params).id!;
    if (
      (input.action === 'return') !== (input.reason !== undefined) ||
      (input.action === 'restore') !== (input.fromVersion !== undefined)
    )
      throw new AppError('INVALID_REQUEST', 400);
    const permission: OperatorPermission = ['save', 'submit', 'restore'].includes(input.action)
      ? 'knowledge.edit'
      : input.action === 'publish' || input.action === 'revoke'
        ? 'knowledge.publish'
        : 'knowledge.review';
    return run(req, permission, async (c, scope, actor) => {
      const doc = (await c.query('SELECT * FROM knowledge.documents WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!doc) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (doc.version !== input.version) throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      let state = doc.state,
        version = doc.version + 1,
        published = doc.published_build_id;
      let next = content.parse({
        title: doc.title,
        body: doc.body,
        category: doc.category,
        audience: doc.audience,
      });
      if (input.action === 'save') {
        next = content.parse(input.content);
        if (containsSecret(next.title + '\n' + next.body))
          throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
        if (next.audience !== doc.audience) throw new AppError('KNOWLEDGE_AUDIENCE_IMMUTABLE', 409);
        state = 'draft';
      } else if (input.content) throw new AppError('INVALID_REQUEST', 400);
      if (input.action === 'restore') {
        const previous = (
          await c.query(
            'SELECT snapshot FROM knowledge.document_history WHERE document_id=$1 AND version=$2',
            [id, input.fromVersion],
          )
        ).rows[0];
        if (!previous) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
        next = content.parse(previous.snapshot);
        if (next.audience !== doc.audience) throw new AppError('KNOWLEDGE_AUDIENCE_IMMUTABLE', 409);
        if (containsSecret(next.title + '\n' + next.body))
          throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
        state = 'draft';
      }
      if (input.action === 'submit') {
        if (state !== 'draft') throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
        state = 'in_review';
      }
      if (input.action === 'return') {
        if (state !== 'in_review' && state !== 'approved')
          throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
        state = 'draft';
      }
      if (input.action === 'approve') {
        if (state !== 'in_review') throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
        state = 'approved';
      }
      if (input.action === 'publish') {
        if (state !== 'approved') throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
        published = await publishDocument(c, id, scope, actor.account.id, version, next, doc.evidence);
        state = 'published';
      }
      if (input.action === 'revoke') {
        if (!published) throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
        await c.query('UPDATE knowledge.sources SET enabled=false WHERE id=$1', [id]);
        published = null;
        state = 'draft';
      }
      await c.query(
        `UPDATE knowledge.documents SET title=$2,body=$3,category=$4,audience=$5,state=$6,version=$7,published_build_id=$8,updated_by=$9,updated_at=now() WHERE id=$1`,
        [
          id,
          next.title,
          next.body,
          next.category,
          next.audience,
          state,
          version,
          published,
          actor.account.id,
        ],
      );
      if (input.action === 'approve')
        await c.query(
          'UPDATE knowledge.documents d SET case_review_ack_version=coalesce((SELECT max(case_version) FROM knowledge.case_review_signals r WHERE r.case_id=d.origin_case_id),0) WHERE d.id=$1',
          [id],
        );
      await record(c, id, scope, actor, version, input.action, next, req.id, input.reason, input.fromVersion);
      return { id, version, state };
    });
  });
}
async function record(
  c: PoolClient,
  id: string,
  scope: [string, string],
  actor: OperatorSession,
  version: number,
  action: string,
  snapshot: unknown,
  requestId: string,
  reason?: string,
  restoredFrom?: number,
) {
  await c.query(
    'INSERT INTO knowledge.document_history(id,document_id,organization_id,project_id,version,action,snapshot,actor_id,reason,restored_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      randomUUID(),
      id,
      ...scope,
      version,
      action,
      JSON.stringify(snapshot),
      actor.account.id,
      reason ?? null,
      restoredFrom ?? null,
    ],
  );
  await c.query(
    'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), actor.account.id, 'knowledge.' + action, id, requestId],
  );
}
