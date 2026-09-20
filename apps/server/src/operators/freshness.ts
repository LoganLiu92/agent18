import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import type { KnowledgeOperation } from './sources.js';
const reference = z.object({
  sourceId: z.string().uuid(),
  path: z.string(),
  revision: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export function registerOperatorFreshness(app: FastifyInstance, run: KnowledgeOperation) {
  app.get('/operator/projects/:key/knowledge/documents/:id/freshness', (req) =>
    run(req, 'source.read', async (c) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const doc = (await c.query('SELECT evidence FROM knowledge.documents WHERE id=$1', [id])).rows[0];
      if (!doc) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const refs: any[] = Array.isArray(doc.evidence) ? doc.evidence : [];
      const evidence = [];
      for (const value of refs.slice(0, 200)) {
        const parsed = reference.safeParse(value);
        if (!parsed.success) {
          evidence.push({
            path: typeof value?.path === 'string' ? value.path : '未知来源',
            status: 'unknown',
          });
          continue;
        }
        const ref = parsed.data;
        const latest = (
          await c.query(
            `SELECT p.id,p.source_revision,p.observed_at,s.name,s.enabled,
    EXISTS(SELECT 1 FROM knowledge.source_fragments f WHERE f.build_id=p.id) AS has_fragments,
    EXISTS(SELECT 1 FROM knowledge.source_fragments f WHERE f.build_id=p.id AND f.path=$2 AND f.content_hash=$3) AS matches
    FROM knowledge.source_snapshots p JOIN knowledge.sources s ON s.id=p.source_id JOIN knowledge.builds b ON b.id=p.id
    WHERE p.source_id=$1 AND b.state='ready' ORDER BY b.created_at DESC,b.id DESC LIMIT 1`,
            [ref.sourceId, ref.path, ref.contentHash],
          )
        ).rows[0];
        evidence.push({
          path: ref.path,
          originalRevision: ref.revision,
          latestRevision: latest?.source_revision ?? null,
          observedAt: latest?.observed_at ?? null,
          sourceEnabled: latest?.enabled ?? null,
          status: !latest?.has_fragments ? 'unknown' : latest.matches ? 'unchanged' : 'changed',
        });
      }
      return {
        evidence,
        truncated: refs.length > 200,
        changed: evidence.filter((e) => e.status === 'changed').length,
        unknown: evidence.filter((e) => e.status === 'unknown').length,
        deployment: await (async () => {
          const query = z
            .object({
              environment: z.enum(['production', 'staging', 'development']).default('production'),
              at: z
                .string()
                .datetime()
                .default(() => new Date().toISOString()),
            })
            .parse(req.query);
          const ids = [
            ...new Set(
              refs
                .map((v) => reference.safeParse(v))
                .filter((v) => v.success)
                .map((v) => v.data!.sourceId),
            ),
          ];
          if (!ids.length) return { status: 'unknown', records: [] };
          const records = (
            await c.query(
              'SELECT * FROM (SELECT DISTINCT ON(service) service,environment,source_id,commit_hash,deployed_at,attestation,revoked_at FROM control.deployment_records WHERE environment=$2 AND deployed_at<=$3 ORDER BY service,deployed_at DESC) latest WHERE source_id=ANY($1::uuid[])',
              [ids, query.environment, query.at],
            )
          ).rows;
          return {
            status: records.length ? 'recorded' : 'unknown',
            environment: query.environment,
            at: query.at,
            records: records.map((r) => ({
              ...r,
              matchesDocument:
                !r.revoked_at && refs.some((v) => v.sourceId === r.source_id && v.revision === r.commit_hash),
            })),
          };
        })(),
      };
    }),
  );
}
