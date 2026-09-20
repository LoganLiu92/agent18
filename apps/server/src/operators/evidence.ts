import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hash } from '@agent18/knowledge';
import { AppError } from '@agent18/domain';
import type { KnowledgeOperation } from './sources.js';

const page = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) });
export function registerOperatorEvidence(app: FastifyInstance, run: KnowledgeOperation) {
  app.get('/operator/projects/:key/knowledge/evidence/:id/content', (req) =>
    run(req, 'source.read', async (c) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const row = (
        await c.query(
          `SELECT e.id,e.path,e.start_line,e.end_line,e.content_hash,p.source_revision,f.body
        FROM knowledge.source_evidence e JOIN knowledge.source_snapshots p ON p.id=e.snapshot_id
        LEFT JOIN knowledge.source_fragments f ON f.build_id=e.snapshot_id AND f.path=e.path AND f.start_line=e.start_line AND f.end_line=e.end_line AND f.content_hash=e.content_hash
        WHERE e.id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (row.body == null) return { ...row, body: null, status: 'unavailable' };
      if (hash(row.body) !== row.content_hash) throw new AppError('KNOWLEDGE_EVIDENCE_HASH_MISMATCH', 409);
      return { ...row, status: 'verified' };
    }),
  );
  const base = '/operator/projects/:key/knowledge/snapshots';
  app.get(base, (req) =>
    run(req, 'source.read', async (c) => {
      const { offset } = page.parse(req.query);
      const rows = (
        await c.query(
          `SELECT p.id,p.source_revision,p.observed_at,p.provenance_state,s.name,
      (SELECT count(*)::int FROM knowledge.source_evidence e WHERE e.snapshot_id=p.id) AS evidence_count
      FROM knowledge.source_snapshots p JOIN knowledge.sources s ON s.id=p.source_id
      JOIN knowledge.builds b ON b.id=p.id ORDER BY b.created_at DESC,p.id LIMIT 51 OFFSET $1`,
          [offset],
        )
      ).rows;
      return { snapshots: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
    }),
  );
  app.get(base + '/:id', (req) =>
    run(req, 'source.read', async (c) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
        { offset } = page.parse(req.query);
      const snapshot = (
        await c.query(
          `SELECT p.*,s.name,s.enabled AS source_enabled,s.active_build_id,b.mode,
      (SELECT coalesce(sum(CASE WHEN jsonb_typeof(a.refs)='array' THEN jsonb_array_length(a.refs) ELSE 0 END),0)::int FROM knowledge.articles a WHERE a.build_id=p.id) AS reference_count,
      (SELECT count(*)::int FROM knowledge.source_evidence e WHERE e.snapshot_id=p.id) AS evidence_count
      FROM knowledge.source_snapshots p JOIN knowledge.sources s ON s.id=p.source_id JOIN knowledge.builds b ON b.id=p.id WHERE p.id=$1`,
          [id],
        )
      ).rows[0];
      if (!snapshot) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const rows = (
        await c.query(
          `SELECT e.id,e.path,e.start_line,e.end_line,e.content_hash,e.provenance_state,e.article_id,a.title AS article_title
      FROM knowledge.source_evidence e JOIN knowledge.articles a ON a.id=e.article_id
      WHERE e.snapshot_id=$1 ORDER BY e.article_id,e.ordinal LIMIT 51 OFFSET $2`,
          [id, offset],
        )
      ).rows;
      return {
        ...snapshot,
        deployment: { status: 'unknown', revision: null },
        evidence: rows.slice(0, 50),
        nextOffset: rows.length > 50 ? offset + 50 : null,
      };
    }),
  );
}
