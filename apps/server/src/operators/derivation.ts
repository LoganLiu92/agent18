import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import { containsSecret, categories } from '@agent18/knowledge';
import type { KnowledgeOperation } from './sources.js';
export function registerOperatorDerivation(app: FastifyInstance, run: KnowledgeOperation) {
  app.post('/operator/projects/:key/knowledge/documents/:id/customer-draft', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const input = z
      .object({
        version: z.number().int().positive(),
        title: z.string().trim().min(2).max(200),
        body: z.string().trim().min(10).max(60000),
        category: z.enum(categories),
      })
      .strict()
      .parse(req.body);
    if (containsSecret(input.title + '\n' + input.body)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const parent = (await c.query('SELECT * FROM knowledge.documents WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!parent) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (parent.version !== input.version) throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      if (parent.audience !== 'internal' || !['approved', 'published'].includes(parent.state))
        throw new AppError('KNOWLEDGE_STATE_CONFLICT', 409);
      const existing = (
        await c.query(
          'SELECT id FROM knowledge.documents WHERE derived_from_document_id=$1 AND derived_from_version=$2',
          [id, input.version],
        )
      ).rows[0];
      if (existing) return { id: existing.id, existing: true };
      const doc = randomUUID(),
        content = { title: input.title, body: input.body, category: input.category, audience: 'customer' };
      await c.query(
        `INSERT INTO knowledge.documents(id,organization_id,project_id,title,body,category,audience,updated_by,evidence,derived_from_document_id,derived_from_version) VALUES($1,$2,$3,$4,$5,$6,'customer',$7,$8,$9,$10)`,
        [
          doc,
          ...scope,
          input.title,
          input.body,
          input.category,
          actor.account.id,
          JSON.stringify(parent.evidence),
          id,
          input.version,
        ],
      );
      await c.query(
        'INSERT INTO knowledge.document_history(id,document_id,organization_id,project_id,version,action,snapshot,actor_id) VALUES($1,$2,$3,$4,1,$5,$6,$7)',
        [randomUUID(), doc, ...scope, 'customer-derived', JSON.stringify(content), actor.account.id],
      );
      await c.query(
        `INSERT INTO knowledge.topic_documents(topic_id,document_id,organization_id,project_id,linked_by) SELECT topic_id,$2,organization_id,project_id,$3 FROM knowledge.topic_documents WHERE document_id=$1`,
        [id, doc, actor.account.id],
      );
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'knowledge.customer-derived', doc, req.id],
      );
      return { id: doc, existing: false };
    });
  });
}
