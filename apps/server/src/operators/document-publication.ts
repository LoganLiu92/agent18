import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tokens } from '@agent18/knowledge';
import { AppError } from '@agent18/domain';
export async function publishDocument(
  c: PoolClient,
  id: string,
  scope: [string, string],
  actorId: string,
  version: number,
  next: { title: string; body: string; category: string; audience: string },
  evidence: unknown,
) {
  if (next.audience === 'customer') {
    const questions = (
      await c.query(
        "SELECT id,version,expected_answer FROM knowledge.eval_questions WHERE enabled AND severity='high' AND $1=ANY(expected_sources)",
        [id],
      )
    ).rows;
    const contentHash = createHash('sha256')
      .update(JSON.stringify({ title: next.title, body: next.body, category: next.category }))
      .digest('hex');
    for (const q of questions) {
      const evaluation = (
        await c.query(
          `SELECT r.id,x.result FROM knowledge.eval_runs r CROSS JOIN LATERAL jsonb_array_elements(r.results) x(result) WHERE x.result->>'questionId'=$1 AND (x.result->>'version')::int=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
          [q.id, q.version],
        )
      ).rows[0];
      const result = evaluation?.result;
      const fresh = result?.candidateInputs?.some(
        (d: { id: string; contentHash: string }) => d.id === id && d.contentHash === contentHash,
      );
      if (!fresh || result.candidatePassed !== true)
        throw new AppError('KNOWLEDGE_EVAL_RELEASE_BLOCKED', 409);
      const review = (
        await c.query(
          'SELECT verdict FROM knowledge.eval_reviews WHERE run_id=$1 AND question_id=$2 AND candidate ORDER BY created_at DESC,id DESC LIMIT 1',
          [evaluation.id, q.id],
        )
      ).rows[0];
      if (review?.verdict === 'incorrect' || (q.expected_answer && review?.verdict !== 'correct'))
        throw new AppError('KNOWLEDGE_EVAL_REVIEW_REQUIRED', 409);
    }
  }
  const build = randomUUID(),
    revision = 'staff-v' + version;
  await c.query(
    `INSERT INTO knowledge.sources(id,organization_id,project_id,source_key,name,audience) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,audience=excluded.audience`,
    [id, ...scope, 'staff-' + id, next.title, next.audience],
  );
  await c.query(
    `INSERT INTO knowledge.builds(id,source_id,organization_id,project_id,revision,fingerprint,mode,state,report) VALUES($1,$2,$3,$4,$5,$6,'manual','ready',$7)`,
    [
      build,
      id,
      ...scope,
      revision,
      createHash('sha256').update(JSON.stringify(next)).digest('hex'),
      JSON.stringify({
        editorial: { documentId: id, version, publishedBy: actorId },
        deployment: { status: 'unknown' },
      }),
    ],
  );
  await c.query(
    `INSERT INTO knowledge.articles(id,build_id,source_id,organization_id,project_id,title,body,category,tokens,refs,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$11,$10)`,
    [
      randomUUID(),
      build,
      id,
      ...scope,
      next.title,
      next.body,
      next.category,
      tokens(next.title + ' ' + next.body),
      revision,
      JSON.stringify(evidence),
    ],
  );
  await c.query('UPDATE knowledge.sources SET active_build_id=$1,enabled=true WHERE id=$2', [build, id]);
  return build;
}
