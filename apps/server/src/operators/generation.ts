import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import {
  KnowledgeError,
  categories,
  validateGenerationInput,
  validateGenerationOutput,
} from '@agent18/knowledge';
import type { KnowledgeOperation } from './sources.js';

export function registerOperatorGeneration(app: FastifyInstance, run: KnowledgeOperation) {
  const base = '/operator/projects/:key/knowledge';
  app.post(base + '/topics/:id/generate', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        version: z.number().int().positive(),
        categories: z.array(z.enum(categories)).min(1).max(6),
        evidenceIds: z.array(z.string().uuid()).min(1).max(12),
      })
      .strict()
      .parse(req.body);
    if (
      new Set(body.categories).size !== body.categories.length ||
      new Set(body.evidenceIds).size !== body.evidenceIds.length
    )
      throw new AppError('INVALID_REQUEST', 400);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const topic = (await c.query('SELECT * FROM knowledge.topics WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!topic) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (topic.version !== body.version) throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      if (topic.state !== 'confirmed') throw new AppError('KNOWLEDGE_TOPIC_NOT_CONFIRMED', 409);
      if (body.categories.some((v) => !topic.required_categories.includes(v)))
        throw new AppError('INVALID_REQUEST', 400);
      const pending = (
        await c.query(
          "SELECT id FROM control.knowledge_generation_jobs WHERE topic_id=$1 AND state IN ('queued','running')",
          [id],
        )
      ).rows[0];
      if (pending) return { id: pending.id, existing: true };
      const evidence = (
        await c.query(
          `SELECT e.id,e.snapshot_id AS "snapshotId",p.source_id AS "sourceId",e.path,e.start_line AS "startLine",e.end_line AS "endLine",p.source_revision AS revision,e.content_hash AS "contentHash",f.body,te.relation,te.note
        FROM knowledge.topic_evidence te JOIN knowledge.source_evidence e ON e.id=te.evidence_id
        JOIN knowledge.source_snapshots p ON p.id=e.snapshot_id
        JOIN knowledge.source_fragments f ON f.build_id=e.snapshot_id AND f.path=e.path AND f.start_line=e.start_line AND f.end_line=e.end_line AND f.content_hash=e.content_hash
        WHERE te.topic_id=$1 AND te.confirmed AND e.id=ANY($2::uuid[]) ORDER BY e.id`,
          [id, body.evidenceIds],
        )
      ).rows;
      if (evidence.length !== body.evidenceIds.length)
        throw new AppError('GENERATION_EVIDENCE_UNAVAILABLE', 409);
      const input = validatedInput({
        topic: {
          id,
          version: topic.version,
          title: topic.title,
          domain: topic.domain,
          description: topic.description,
        },
        categories: body.categories,
        evidence,
      });
      const job = randomUUID();
      await c.query(
        'INSERT INTO control.knowledge_generation_jobs(id,organization_id,project_id,topic_id,actor_id,input) VALUES($1,$2,$3,$4,$5,$6)',
        [job, ...scope, id, actor.account.id, JSON.stringify(input)],
      );
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'knowledge.generation.queued', job, req.id],
      );
      return { id: job, existing: false };
    });
  });
  app.get(base + '/topics/:id/generations', (req) =>
    run(req, 'source.read', async (c) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { offset } = z
        .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
        .parse(req.query);
      if (!(await c.query('SELECT id FROM knowledge.topics WHERE id=$1', [id])).rowCount)
        throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const rows = (
        await c.query(
          `SELECT id,state,error_code,created_at,started_at,completed_at,input->'topic' AS topic,input->'categories' AS categories,coalesce(jsonb_array_length(result->'output'->'articles'),0) AS article_count,(SELECT count(*)::int FROM knowledge.documents d WHERE d.generation_job_id=control.knowledge_generation_jobs.id) AS imported_count FROM control.knowledge_generation_jobs WHERE topic_id=$1 ORDER BY created_at DESC,id LIMIT 21 OFFSET $2`,
          [id, offset],
        )
      ).rows;
      return { jobs: rows.slice(0, 20), nextOffset: rows.length > 20 ? offset + 20 : null };
    }),
  );
  app.get(base + '/generations/:id', (req) =>
    run(req, 'source.read', async (c) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const row = (
        await c.query(
          'SELECT id,state,error_code,input,result,created_at,completed_at FROM control.knowledge_generation_jobs WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!row) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const imported = (
        await c.query('SELECT id,generation_index FROM knowledge.documents WHERE generation_job_id=$1', [id])
      ).rows;
      return { ...row, imported };
    }),
  );
  app.post(base + '/generations/:id/cancel', (req) =>
    run(req, 'knowledge.edit', async (c, _scope, actor) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const updated = await c.query(
        "UPDATE control.knowledge_generation_jobs SET state='cancelled',completed_at=now() WHERE id=$1 AND state IN ('queued','running') RETURNING id",
        [id],
      );
      if (!updated.rowCount) throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'knowledge.generation.cancelled', id, req.id],
      );
      return { id };
    }),
  );
  app.post(base + '/generations/:id/import', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { index } = z
      .object({ index: z.number().int().min(0).max(5) })
      .strict()
      .parse(req.body);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const job = (
        await c.query('SELECT * FROM control.knowledge_generation_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!job) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (job.state !== 'succeeded') throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
      const existing = (
        await c.query(
          'SELECT id FROM knowledge.documents WHERE generation_job_id=$1 AND generation_index=$2',
          [id, index],
        )
      ).rows[0];
      if (existing) return { id: existing.id, existing: true };
      const input = validateGenerationInput(job.input),
        output = validateGenerationOutput(job.result?.output, input),
        article = output.articles[index];
      if (!article) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const topic = (await c.query('SELECT * FROM knowledge.topics WHERE id=$1 FOR UPDATE', [job.topic_id]))
        .rows[0];
      if (!topic || topic.state !== 'confirmed' || topic.version !== input.topic.version)
        throw new AppError('GENERATION_TOPIC_CHANGED', 409);
      const doc = randomUUID(),
        content = {
          title: article.title,
          body: article.body,
          category: article.category,
          audience: 'internal',
        };
      const evidence = input.evidence
        .filter((e) => article.evidenceIds.includes(e.id))
        .map(({ body: _body, relation: _relation, note: _note, ...ref }) => ref);
      await c.query(
        `INSERT INTO knowledge.documents(id,organization_id,project_id,title,body,category,audience,updated_by,evidence,generation_job_id,generation_index) VALUES($1,$2,$3,$4,$5,$6,'internal',$7,$8,$9,$10)`,
        [
          doc,
          ...scope,
          article.title,
          article.body,
          article.category,
          actor.account.id,
          JSON.stringify(evidence),
          id,
          index,
        ],
      );
      await c.query(
        'INSERT INTO knowledge.document_history(id,document_id,organization_id,project_id,version,action,snapshot,actor_id) VALUES($1,$2,$3,$4,1,$5,$6,$7)',
        [randomUUID(), doc, ...scope, 'generated', JSON.stringify(content), actor.account.id],
      );
      await c.query(
        'INSERT INTO knowledge.topic_documents(topic_id,document_id,organization_id,project_id,linked_by) VALUES($1,$2,$3,$4,$5)',
        [topic.id, doc, ...scope, actor.account.id],
      );
      // Import changes coverage, not the reviewed topic definition or its evidence version.
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'knowledge.generation.imported', doc, req.id],
      );
      return { id: doc, existing: false };
    });
  });
}

function validatedInput(value: unknown) {
  try {
    return validateGenerationInput(value);
  } catch (error) {
    if (error instanceof KnowledgeError)
      throw new AppError(error.code, error.code === 'KNOWLEDGE_EVIDENCE_HASH_MISMATCH' ? 409 : 400);
    throw error;
  }
}
