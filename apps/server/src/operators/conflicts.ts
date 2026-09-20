import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent18/domain';
import { containsSecret, detectRuleConflicts } from '@agent18/knowledge';
import type { KnowledgeOperation } from './sources.js';
const claim = z
  .object({
    kind: z.enum(['document', 'source']),
    id: z.string().uuid(),
    version: z.string().min(1).max(128),
    value: z.string().trim().min(1).max(1000),
  })
  .strict();
export function registerOperatorConflicts(app: FastifyInstance, run: KnowledgeOperation) {
  const base = '/operator/projects/:key/knowledge/conflicts';
  app.get(base, (req) =>
    run(req, 'source.read', async (c) => {
      const q = z
        .object({
          state: z.enum(['all', 'open', 'resolved', 'dismissed']).default('open'),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .parse(req.query);
      const rows = (
        await c.query(
          "SELECT c.*,t.title AS topic_title FROM knowledge.conflicts c JOIN knowledge.topics t ON t.id=c.topic_id WHERE ($1='all' OR c.state=$1) ORDER BY c.updated_at DESC,c.id LIMIT 51 OFFSET $2",
          [q.state, q.offset],
        )
      ).rows;
      return { conflicts: rows.slice(0, 50), nextOffset: rows.length > 50 ? q.offset + 50 : null };
    }),
  );
  app.post(base + '/scan', (req) => {
    const { topicId } = z.object({ topicId: z.string().uuid() }).strict().parse(req.body);
    return run(req, 'knowledge.edit', async (c) => {
      if (
        !(await c.query("SELECT id FROM knowledge.topics WHERE id=$1 AND state='confirmed'", [topicId]))
          .rowCount
      )
        throw new AppError('KNOWLEDGE_TOPIC_NOT_CONFIRMED', 409);
      const records = (
        await c.query(
          `SELECT 'document' AS kind,d.id,d.version::text AS version,left(d.body,20000) AS body FROM knowledge.documents d JOIN knowledge.topic_documents t ON t.document_id=d.id WHERE t.topic_id=$1
      UNION ALL SELECT 'source',e.id,p.source_revision,left(f.body,20000) FROM knowledge.topic_evidence t JOIN knowledge.source_evidence e ON e.id=t.evidence_id JOIN knowledge.source_snapshots p ON p.id=e.snapshot_id JOIN knowledge.source_fragments f ON f.build_id=p.id AND f.path=e.path AND f.start_line=e.start_line AND f.end_line=e.end_line AND f.content_hash=e.content_hash WHERE t.topic_id=$1 AND t.confirmed ORDER BY kind,id LIMIT 101`,
          [topicId],
        )
      ).rows;
      return {
        method: 'explicit-numeric-assignment-v1',
        candidates: detectRuleConflicts(records),
        truncated: records.length > 100,
        requiresScopeReview: true,
      };
    });
  });
  app.post(base, (req) => {
    const input = z
      .object({
        topicId: z.string().uuid(),
        ruleKey: z.string().trim().min(2).max(120),
        comparisonScope: z.string().trim().min(5).max(500),
        claims: z.array(claim).min(2).max(5),
      })
      .strict()
      .parse(req.body);
    if (containsSecret(JSON.stringify(input))) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      if (
        !(await c.query("SELECT id FROM knowledge.topics WHERE id=$1 AND state='confirmed'", [input.topicId]))
          .rowCount
      )
        throw new AppError('KNOWLEDGE_TOPIC_NOT_CONFIRMED', 409);
      if (new Set(input.claims.map((x) => x.kind + ':' + x.id)).size !== input.claims.length)
        throw new AppError('INVALID_REQUEST', 400);
      for (const item of input.claims) {
        const record =
          item.kind === 'document'
            ? (
                await c.query(
                  'SELECT d.version::text AS revision FROM knowledge.documents d JOIN knowledge.topic_documents t ON t.document_id=d.id WHERE d.id=$1 AND t.topic_id=$2',
                  [item.id, input.topicId],
                )
              ).rows[0]
            : (
                await c.query(
                  'SELECT s.source_revision AS revision FROM knowledge.source_evidence e JOIN knowledge.source_snapshots s ON s.id=e.snapshot_id JOIN knowledge.topic_evidence t ON t.evidence_id=e.id WHERE e.id=$1 AND t.topic_id=$2 AND t.confirmed',
                  [item.id, input.topicId],
                )
              ).rows[0];
        if (!record || record.revision !== item.version)
          throw new AppError('KNOWLEDGE_EVIDENCE_CHANGED', 409);
      }
      const id = randomUUID();
      await c.query(
        'INSERT INTO knowledge.conflicts(id,organization_id,project_id,topic_id,rule_key,comparison_scope,claims,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          ...scope,
          input.topicId,
          input.ruleKey,
          input.comparisonScope,
          JSON.stringify(input.claims),
          actor.account.id,
        ],
      );
      await c.query(
        "INSERT INTO knowledge.conflict_events(id,conflict_id,organization_id,project_id,version,action,reason,actor_id) VALUES($1,$2,$3,$4,1,'created','待人工核对相同业务规则与适用范围',$5)",
        [randomUUID(), id, ...scope, actor.account.id],
      );
      return { id };
    });
  });
  app.post(base + '/:id', (req) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        state: z.enum(['open', 'resolved', 'dismissed']),
        reason: z.string().trim().min(10).max(4000),
      })
      .strict()
      .parse(req.body);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (containsSecret(input.reason)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.review', async (c, scope, actor) => {
      const row = (await c.query('SELECT * FROM knowledge.conflicts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (row.version !== input.version || row.state === input.state)
        throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      await c.query(
        'UPDATE knowledge.conflicts SET state=$2,resolution=$3,resolved_by=$4,version=version+1,updated_at=now() WHERE id=$1',
        [id, input.state, input.reason, actor.account.id],
      );
      await c.query(
        'INSERT INTO knowledge.conflict_events(id,conflict_id,organization_id,project_id,version,action,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), id, ...scope, row.version + 1, input.state, input.reason, actor.account.id],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'knowledge.conflict.review',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id, version: row.version + 1 };
    });
  });
  app.get(base + '/:id/events', (req) =>
    run(req, 'source.read', async (c) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      if (!(await c.query('SELECT id FROM knowledge.conflicts WHERE id=$1', [id])).rowCount)
        throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      return {
        events: (
          await c.query(
            'SELECT e.version,e.action,e.reason,e.created_at,a.display_name AS actor FROM knowledge.conflict_events e JOIN control.operator_accounts a ON a.id=e.actor_id WHERE conflict_id=$1 ORDER BY e.created_at DESC LIMIT 100',
            [id],
          )
        ).rows,
      };
    }),
  );
  app.get('/operator/projects/:key/knowledge/impact', (req) =>
    run(req, 'source.read', async (c) => {
      const { offset } = z
        .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
        .parse(req.query);
      const rows = (
        await c.query(
          `SELECT d.id,d.title,d.version,d.state,d.origin_case_id,EXISTS(SELECT 1 FROM knowledge.case_review_signals r WHERE r.case_id=d.origin_case_id AND r.case_version>greatest(d.origin_case_version,d.case_review_ack_version)) AS case_review_required,
   (SELECT jsonb_agg(jsonb_build_object('path',ref->>'path','revision',ref->>'revision','latestRevision',latest.source_revision,'status',CASE WHEN latest.id IS NULL OR NOT EXISTS(SELECT 1 FROM knowledge.source_fragments f WHERE f.build_id=latest.id) THEN 'unknown' WHEN EXISTS(SELECT 1 FROM knowledge.source_fragments f WHERE f.build_id=latest.id AND f.path=ref->>'path' AND f.content_hash=ref->>'contentHash') THEN 'unchanged' ELSE 'changed' END))
    FROM jsonb_array_elements(d.evidence) ref LEFT JOIN LATERAL(SELECT s.id,s.source_revision FROM knowledge.source_snapshots s JOIN knowledge.builds b ON b.id=s.id WHERE s.source_id::text=ref->>'sourceId' AND b.state='ready' ORDER BY b.created_at DESC,b.id DESC LIMIT 1) latest ON true) AS evidence,
   ARRAY(SELECT t.title FROM knowledge.topic_documents td JOIN knowledge.topics t ON t.id=td.topic_id WHERE td.document_id=d.id) AS topics
   FROM knowledge.documents d WHERE jsonb_array_length(d.evidence)>0 OR d.origin_case_id IS NOT NULL ORDER BY d.updated_at DESC,d.id LIMIT 51 OFFSET $1`,
          [offset],
        )
      ).rows;
      return {
        documents: rows.slice(0, 50),
        nextOffset: rows.length > 50 ? offset + 50 : null,
        deploymentStatus: 'unknown',
      };
    }),
  );
}
