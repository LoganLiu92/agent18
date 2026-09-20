import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent18/domain';
import { containsSecret, tokens, rankedArticles } from '@agent18/knowledge';
import type { KnowledgeOperation } from './sources.js';
const question = z.string().trim().min(2).max(1000);
export function registerOperatorEvaluation(app: FastifyInstance, run: KnowledgeOperation) {
  const base = '/operator/projects/:key/knowledge/evaluation';
  app.get(base, (req) =>
    run(req, 'source.read', async (c) => ({
      questions: (
        await c.query(
          'SELECT id,question,expected_sources,expected_answer,forbidden_sources,expect_no_answer,severity,version FROM knowledge.eval_questions WHERE enabled ORDER BY updated_at DESC LIMIT 100',
        )
      ).rows,
      runs: (
        await c.query(
          'SELECT id,results,created_at FROM knowledge.eval_runs ORDER BY created_at DESC LIMIT 20',
        )
      ).rows,
      reviews: (await c.query('SELECT * FROM knowledge.eval_reviews ORDER BY created_at DESC LIMIT 500'))
        .rows,
      candidates: (
        await c.query(
          "SELECT id,title,version,state FROM knowledge.documents WHERE audience='customer' AND state IN('draft','in_review','approved') ORDER BY updated_at DESC LIMIT 200",
        )
      ).rows,
      sources: (
        await c.query(
          "SELECT id,name FROM knowledge.sources WHERE enabled AND audience='customer' AND cardinality(tenant_ids)=0 AND active_build_id IS NOT NULL ORDER BY name LIMIT 200",
        )
      ).rows,
    })),
  );
  app.post(base + '/search', (req) => {
    const input = z.object({ question }).strict().parse(req.body);
    if (containsSecret(input.question)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'source.read', async (c) => ({
      mode: 'public-customer-retrieval',
      citations: (await rankedArticles(c, tokens(input.question).slice(0, 100), 5, true)).map((r) => ({
        id: r.id,
        sourceId: r.source_id,
        title: r.title,
        excerpt: r.body.slice(0, 2000),
        publication: r.build_id,
        score: r.score,
      })),
    }));
  });
  app.post(base + '/questions', (req) => {
    const input = z
      .object({
        question,
        expectedSources: z.array(z.string().uuid()).max(5),
        expectedAnswer: z.string().trim().max(4000).default(''),
        forbiddenSources: z.array(z.string().uuid()).max(20).default([]),
        expectNoAnswer: z.boolean().default(false),
        severity: z.enum(['normal', 'high']).default('normal'),
      })
      .strict()
      .parse(req.body);
    if (containsSecret(JSON.stringify(input))) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    if (
      (!input.expectNoAnswer && !input.expectedSources.length) ||
      (input.expectNoAnswer && input.expectedSources.length) ||
      input.expectedSources.some((id) => input.forbiddenSources.includes(id)) ||
      new Set(input.forbiddenSources).size !== input.forbiddenSources.length
    )
      throw new AppError('INVALID_REQUEST', 400);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      if (
        +(await c.query('SELECT count(*) FROM knowledge.eval_questions WHERE enabled')).rows[0].count >= 100
      )
        throw new AppError('KNOWLEDGE_EVAL_LIMIT', 409);
      const sources = (
        await c.query(
          "SELECT id FROM knowledge.sources WHERE id=ANY($1::uuid[]) AND enabled AND audience='customer' AND cardinality(tenant_ids)=0 AND active_build_id IS NOT NULL UNION SELECT id FROM knowledge.documents WHERE id=ANY($1::uuid[]) AND audience='customer'",
          [input.expectedSources],
        )
      ).rows;
      if (sources.length !== input.expectedSources.length)
        throw new AppError('KNOWLEDGE_EVAL_SOURCE_INVALID', 400);
      const forbidden = (
        await c.query(
          'SELECT id FROM knowledge.sources WHERE id=ANY($1::uuid[]) UNION SELECT id FROM knowledge.documents WHERE id=ANY($1::uuid[])',
          [input.forbiddenSources],
        )
      ).rows;
      if (forbidden.length !== input.forbiddenSources.length)
        throw new AppError('KNOWLEDGE_EVAL_SOURCE_INVALID', 400);
      const id = randomUUID();
      await c.query(
        'INSERT INTO knowledge.eval_questions(id,organization_id,project_id,question,expected_sources,updated_by,expected_answer,forbidden_sources,expect_no_answer,severity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          ...scope,
          input.question,
          input.expectedSources,
          actor.account.id,
          input.expectedAnswer,
          input.forbiddenSources,
          input.expectNoAnswer,
          input.severity,
        ],
      );
      return { id };
    });
  });
  app.post(base + '/questions/:id/archive', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      input = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    return run(req, 'knowledge.edit', async (c, _scope, actor) => {
      if (
        !(
          await c.query(
            'UPDATE knowledge.eval_questions SET enabled=false,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1 AND version=$2 AND enabled RETURNING id',
            [id, input.version, actor.account.id],
          )
        ).rowCount
      )
        throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      return { archived: true };
    });
  });
  app.post(base + '/reviews', (req) => {
    const input = z
      .object({
        runId: z.string().uuid(),
        questionId: z.string().uuid(),
        candidate: z.boolean().default(false),
        verdict: z.enum(['correct', 'incorrect', 'unknown']),
        note: z.string().trim().min(5).max(2000),
      })
      .strict()
      .parse(req.body);
    if (containsSecret(input.note)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.review', async (c, scope, actor) => {
      const result = (await c.query('SELECT results FROM knowledge.eval_runs WHERE id=$1', [input.runId]))
        .rows[0];
      const question = result?.results.find((q: { questionId: string }) => q.questionId === input.questionId);
      if (!question || (input.candidate && question.candidatePassed === undefined))
        throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const id = randomUUID();
      await c.query(
        'INSERT INTO knowledge.eval_reviews(id,organization_id,project_id,run_id,question_id,candidate,verdict,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          id,
          ...scope,
          input.runId,
          input.questionId,
          input.candidate,
          input.verdict,
          input.note,
          actor.account.id,
        ],
      );
      return { id };
    });
  });
  app.post(base + '/run', (req) => {
    const input = z
      .object({
        questionIds: z.array(z.string().uuid()).min(1).max(30),
        candidateDocuments: z
          .array(z.object({ id: z.string().uuid(), version: z.number().int().positive() }).strict())
          .max(20)
          .default([])
          .refine((v) => new Set(v.map((d) => d.id)).size === v.length),
      })
      .strict()
      .parse(req.body);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const questions = (
        await c.query(
          'SELECT id,question,expected_sources,expected_answer,forbidden_sources,expect_no_answer,severity,version FROM knowledge.eval_questions WHERE enabled AND id=ANY($1::uuid[]) ORDER BY id',
          [input.questionIds],
        )
      ).rows;
      if (questions.length !== input.questionIds.length) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const drafts = (
        await c.query(
          "SELECT id,title,body,category,version,updated_at FROM knowledge.documents WHERE id=ANY($1::uuid[]) AND audience='customer' ORDER BY id FOR SHARE",
          [input.candidateDocuments.map((d) => d.id)],
        )
      ).rows;
      if (drafts.length !== input.candidateDocuments.length) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (drafts.some((d) => d.version !== input.candidateDocuments.find((x) => x.id === d.id)!.version))
        throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      const candidateRows = drafts.map((d) => ({
        id: d.id,
        source_id: d.id,
        build_id: 'draft-v' + d.version,
        title: d.title,
        body: d.body,
        category: d.category,
        tokens: tokens(d.title + ' ' + d.body),
        created_at: d.updated_at.toISOString(),
      }));
      const results = [];
      for (const q of questions) {
        const rows = await rankedArticles(c, tokens(q.question).slice(0, 100), 5, true);
        const comparison = candidateRows.length
          ? await rankedArticles(c, tokens(q.question).slice(0, 100), 5, true, candidateRows)
          : undefined;
        results.push({
          ...(comparison
            ? {
                candidatePassed: passes(q, comparison),
                candidateCitations: comparison.map((r) => ({
                  id: r.id,
                  title: r.title,
                  sourceId: r.source_id,
                  publication: r.build_id,
                })),
                candidateInputs: candidateRows.map((d) => ({
                  id: d.id,
                  version: d.build_id,
                  contentHash: createHash('sha256')
                    .update(JSON.stringify({ title: d.title, body: d.body, category: d.category }))
                    .digest('hex'),
                })),
              }
            : {}),
          questionId: q.id,
          version: q.version,
          question: q.question,
          expectedSources: q.expected_sources,
          expectedAnswer: q.expected_answer,
          forbiddenSources: q.forbidden_sources,
          expectNoAnswer: q.expect_no_answer,
          severity: q.severity,
          semanticReview: 'pending',
          passed: passes(q, rows),
          citations: rows.map((r) => ({
            id: r.id,
            title: r.title,
            sourceId: r.source_id,
            publication: r.build_id,
          })),
        });
      }
      const id = randomUUID();
      await c.query(
        'INSERT INTO knowledge.eval_runs(id,organization_id,project_id,actor_id,results) VALUES($1,$2,$3,$4,$5)',
        [id, ...scope, actor.account.id, JSON.stringify(results)],
      );
      return { id, results };
    });
  });
}

function passes(
  q: { expected_sources: string[]; forbidden_sources: string[]; expect_no_answer: boolean },
  rows: { source_id: string }[],
) {
  const found = new Set(rows.map((r) => r.source_id));
  return (
    (q.expect_no_answer ? rows.length === 0 : q.expected_sources.every((id) => found.has(id))) &&
    !q.forbidden_sources.some((id) => found.has(id))
  );
}
