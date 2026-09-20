import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import { categories, containsSecret } from '@agent18/knowledge';
import type { KnowledgeOperation } from './sources.js';

const content = z
  .object({
    domain: z.string().trim().min(1).max(100),
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000),
    state: z.enum(['candidate', 'confirmed', 'excluded']),
    requiredCategories: z
      .array(z.enum(categories))
      .min(1)
      .max(categories.length)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
const mutation = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('evidence-link'),
      version: z.number().int().positive(),
      evidenceId: z.string().uuid(),
      relation: z.enum(['context', 'supports', 'contradicts']),
      note: z.string().trim().min(2).max(1000),
      confirmed: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('evidence-unlink'),
      version: z.number().int().positive(),
      evidenceId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('evidence-review'),
      version: z.number().int().positive(),
      evidenceId: z.string().uuid(),
      confirmed: z.boolean(),
      relation: z.enum(['context', 'supports', 'contradicts']),
      note: z.string().trim().min(2).max(1000),
    })
    .strict(),
  z.object({ action: z.literal('save'), version: z.number().int().positive(), content }).strict(),
  z
    .object({
      action: z.enum(['link', 'unlink']),
      version: z.number().int().positive(),
      documentId: z.string().uuid(),
    })
    .strict(),
]);
function safeContent(value: z.infer<typeof content>) {
  if (containsSecret(JSON.stringify(value))) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
  return value;
}
export function registerOperatorTopics(app: FastifyInstance, run: KnowledgeOperation) {
  const base = '/operator/projects/:key/knowledge/topics';
  app.get(base, (req) =>
    run(req, 'source.read', async (c) => {
      const { offset } = z
        .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
        .parse(req.query);
      const rows = (
        await c.query(
          `SELECT t.*,
      (SELECT count(*)::int FROM knowledge.topic_documents td WHERE td.topic_id=t.id) AS document_count
      FROM knowledge.topics t ORDER BY t.domain,t.title,t.id LIMIT 51 OFFSET $1`,
          [offset],
        )
      ).rows;
      return { topics: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
    }),
  );
  app.get(base + '/:id', (req) =>
    run(req, 'source.read', async (c) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const topic = (await c.query('SELECT * FROM knowledge.topics WHERE id=$1', [id])).rows[0];
      if (!topic) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const documents = (
        await c.query(
          `SELECT d.id,d.title,d.category,d.audience,d.state,d.version,
      jsonb_array_length(d.evidence) AS evidence_count,
      a.category AS published_category,s.audience AS published_audience,a.id AS published_article_id
      FROM knowledge.topic_documents td JOIN knowledge.documents d ON d.id=td.document_id
      LEFT JOIN knowledge.sources s ON s.id=d.id AND s.enabled AND s.active_build_id=d.published_build_id
      LEFT JOIN knowledge.articles a ON a.build_id=s.active_build_id
      WHERE td.topic_id=$1 ORDER BY d.title,d.id LIMIT 201`,
          [id],
        )
      ).rows;
      // Derive coverage from the active publication, never the current draft category or audience.
      const evidence = (
        await c.query(
          `SELECT te.evidence_id AS id,te.relation,te.note,te.confirmed,te.created_at,
        e.path,e.start_line,e.end_line,e.content_hash,e.provenance_state,p.id AS snapshot_id,p.source_revision,p.observed_at,
        s.name AS source_name,s.enabled AS source_enabled,a.display_name AS linked_by
        FROM knowledge.topic_evidence te JOIN knowledge.source_evidence e ON e.id=te.evidence_id
        JOIN knowledge.source_snapshots p ON p.id=e.snapshot_id JOIN knowledge.sources s ON s.id=p.source_id
        JOIN control.operator_accounts a ON a.id=te.linked_by WHERE te.topic_id=$1 ORDER BY te.created_at DESC,te.evidence_id LIMIT 201`,
          [id],
        )
      ).rows;
      const coverage = (
        await c.query(
          `SELECT DISTINCT a.category,s.audience
      FROM knowledge.topic_documents td JOIN knowledge.documents d ON d.id=td.document_id
      JOIN knowledge.sources s ON s.id=d.id AND s.enabled AND s.active_build_id=d.published_build_id
      JOIN knowledge.articles a ON a.build_id=s.active_build_id WHERE td.topic_id=$1`,
          [id],
        )
      ).rows;
      return {
        ...topic,
        documents: documents.slice(0, 200),
        documentsTruncated: documents.length > 200,
        evidence: evidence.slice(0, 200),
        evidenceTruncated: evidence.length > 200,
        coverage: topic.required_categories.map((category: string) => ({
          category,
          internal: coverage.some((r) => r.category === category && r.audience === 'internal'),
          customer: coverage.some((r) => r.category === category && r.audience === 'customer'),
        })),
      };
    }),
  );
  app.post(base, (req) => {
    const input = safeContent(content.parse(req.body));
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO knowledge.topics(id,organization_id,project_id,domain,title,description,state,required_categories,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          ...scope,
          input.domain,
          input.title,
          input.description,
          input.state,
          input.requiredCategories,
          actor.account.id,
        ],
      );
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'knowledge.topic.created', id, req.id],
      );
      return { id };
    });
  });
  app.post(base + '/:id', (req) => {
    const input = mutation.parse(req.body),
      { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const topic = (await c.query('SELECT * FROM knowledge.topics WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!topic) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (topic.merged_into) throw new AppError('KNOWLEDGE_TOPIC_MERGED', 409);
      if (topic.version !== input.version) throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      if (input.action === 'save') {
        const value = safeContent(input.content);
        await c.query(
          `UPDATE knowledge.topics SET domain=$2,title=$3,description=$4,state=$5,required_categories=$6 WHERE id=$1`,
          [id, value.domain, value.title, value.description, value.state, value.requiredCategories],
        );
      } else if (input.action === 'evidence-review') {
        if (containsSecret(input.note)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
        if (
          !(
            await c.query(
              'UPDATE knowledge.topic_evidence SET confirmed=$3,relation=$4,note=$5,linked_by=$6 WHERE topic_id=$1 AND evidence_id=$2 RETURNING evidence_id',
              [id, input.evidenceId, input.confirmed, input.relation, input.note, actor.account.id],
            )
          ).rowCount
        )
          throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      } else if (input.action === 'evidence-link' || input.action === 'evidence-unlink') {
        if (
          !(await c.query('SELECT id FROM knowledge.source_evidence WHERE id=$1', [input.evidenceId]))
            .rowCount
        )
          throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
        if (input.action === 'evidence-link') {
          if (containsSecret(input.note)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
          if (
            (
              await c.query('SELECT 1 FROM knowledge.topic_evidence WHERE topic_id=$1 AND evidence_id=$2', [
                id,
                input.evidenceId,
              ])
            ).rowCount
          )
            throw new AppError('KNOWLEDGE_EVIDENCE_LINK_EXISTS', 409);
          await c.query(
            `INSERT INTO knowledge.topic_evidence(topic_id,evidence_id,organization_id,project_id,relation,note,confirmed,linked_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, input.evidenceId, ...scope, input.relation, input.note, input.confirmed, actor.account.id],
          );
        } else
          await c.query('DELETE FROM knowledge.topic_evidence WHERE topic_id=$1 AND evidence_id=$2', [
            id,
            input.evidenceId,
          ]);
      } else {
        if (!(await c.query('SELECT id FROM knowledge.documents WHERE id=$1', [input.documentId])).rowCount)
          throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
        if (input.action === 'link') {
          await c.query(
            `INSERT INTO knowledge.topic_documents(topic_id,document_id,organization_id,project_id,linked_by)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [id, input.documentId, ...scope, actor.account.id],
          );
        } else
          await c.query('DELETE FROM knowledge.topic_documents WHERE topic_id=$1 AND document_id=$2', [
            id,
            input.documentId,
          ]);
      }
      await c.query(
        'UPDATE knowledge.topics SET version=version+1,updated_by=$2,updated_at=now() WHERE id=$1',
        [id, actor.account.id],
      );
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'knowledge.topic.' + input.action, id, req.id],
      );
      return { id, version: topic.version + 1 };
    });
  });
}
