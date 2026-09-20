import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent18/domain';
import { containsSecret } from '@agent18/knowledge';
import { canonical } from '@agent18/provider-contracts';
import type { KnowledgeOperation } from './sources.js';
import { publishDocument } from './document-publication.js';
export function registerPublicationSets(app: FastifyInstance, run: KnowledgeOperation) {
  const base = '/operator/projects/:key/knowledge/publication-sets';
  app.get(base, (req) =>
    run(req, 'source.read', async (c) => ({
      sets: (
        await c.query(
          'SELECT id,title,members,created_at FROM knowledge.publication_sets ORDER BY created_at DESC LIMIT 50',
        )
      ).rows,
      approved: (
        await c.query(
          "SELECT id,title,audience,version FROM knowledge.documents WHERE state='approved' ORDER BY updated_at DESC LIMIT 200",
        )
      ).rows,
    })),
  );
  app.post(base, (req) => {
    const input = z
      .object({
        title: z.string().trim().min(2).max(120),
        requestKey: z.string().uuid(),
        documents: z
          .array(z.object({ id: z.string().uuid(), version: z.number().int().positive() }).strict())
          .min(1)
          .max(30)
          .refine((v) => new Set(v.map((x) => x.id)).size === v.length),
      })
      .strict()
      .parse(req.body);
    if (containsSecret(input.title)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.publish', async (c, scope, actor) => {
      const hash = createHash('sha256')
        .update(
          canonical({ ...input, documents: [...input.documents].sort((a, b) => a.id.localeCompare(b.id)) }),
        )
        .digest('hex');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,183102))', [
        scope.join(':') + input.requestKey,
      ]);
      const previous = (
        await c.query('SELECT id,input_hash FROM knowledge.publication_sets WHERE request_key=$1', [
          input.requestKey,
        ])
      ).rows[0];
      if (previous) {
        if (previous.input_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return { id: previous.id, replayed: true };
      }
      const rows = (
        await c.query('SELECT * FROM knowledge.documents WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
          input.documents.map((v) => v.id),
        ])
      ).rows;
      if (rows.length !== input.documents.length) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      for (const d of rows) {
        if (d.version !== input.documents.find((v) => v.id === d.id)!.version)
          throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
        if (d.state !== 'approved') throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
      }
      const members = [];
      for (const d of rows) {
        const version = d.version + 1,
          next = { title: d.title, body: d.body, category: d.category, audience: d.audience },
          build = await publishDocument(c, d.id, scope, actor.account.id, version, next, d.evidence);
        await c.query(
          "UPDATE knowledge.documents SET state='published',version=$2,published_build_id=$3,updated_by=$4,updated_at=now() WHERE id=$1",
          [d.id, version, build, actor.account.id],
        );
        await c.query(
          "INSERT INTO knowledge.document_history(id,document_id,organization_id,project_id,version,action,snapshot,actor_id) VALUES($1,$2,$3,$4,$5,'publish',$6,$7)",
          [randomUUID(), d.id, ...scope, version, JSON.stringify(next), actor.account.id],
        );
        members.push({
          documentId: d.id,
          title: d.title,
          audience: d.audience,
          version,
          buildId: build,
          previousBuildId: d.published_build_id,
        });
      }
      const id = randomUUID();
      await c.query(
        'INSERT INTO knowledge.publication_sets(id,organization_id,project_id,actor_id,title,request_key,input_hash,members) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, ...scope, actor.account.id, input.title, input.requestKey, hash, JSON.stringify(members)],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'knowledge.publication-set.publish',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id, members, replayed: false };
    });
  });
  app.post(base + '/:id/revoke', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      { reason } = z
        .object({ reason: z.string().trim().min(5).max(500) })
        .strict()
        .parse(req.body);
    if (containsSecret(reason)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.publish', async (c, scope, actor) => {
      const set = (await c.query('SELECT members FROM knowledge.publication_sets WHERE id=$1', [id])).rows[0];
      if (!set) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      const members = set.members as { documentId: string; buildId: string }[],
        rows = (
          await c.query('SELECT * FROM knowledge.documents WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
            members.map((m) => m.documentId),
          ])
        ).rows;
      if (
        rows.length !== members.length ||
        rows.some((d) => d.published_build_id !== members.find((m) => m.documentId === d.id)!.buildId)
      )
        throw new AppError('KNOWLEDGE_PUBLICATION_CHANGED', 409);
      for (const d of rows) {
        await c.query('UPDATE knowledge.sources SET enabled=false WHERE id=$1', [d.id]);
        await c.query(
          "UPDATE knowledge.documents SET state='draft',version=version+1,published_build_id=NULL,updated_by=$2,updated_at=now() WHERE id=$1",
          [d.id, actor.account.id],
        );
        await c.query(
          "INSERT INTO knowledge.document_history(id,document_id,organization_id,project_id,version,action,snapshot,actor_id,reason) VALUES($1,$2,$3,$4,$5,'revoke',$6,$7,$8)",
          [
            randomUUID(),
            d.id,
            ...scope,
            d.version + 1,
            JSON.stringify({ title: d.title, body: d.body, category: d.category, audience: d.audience }),
            actor.account.id,
            reason,
          ],
        );
      }
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'knowledge.publication-set.revoke',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { revoked: true };
    });
  });
}
