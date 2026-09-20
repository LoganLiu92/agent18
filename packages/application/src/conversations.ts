import { canonical } from '@agent18/provider-contracts';
import { randomUUID } from 'node:crypto';
import { scoped, scopeValues, auditInTransaction, requireTenant, type Database } from '@agent18/persistence';
import { AppError } from '@agent18/domain';
import { containsSecret } from '@agent18/knowledge';
import {
  conversationInput,
  conversationMessageInput,
  type Scope,
  type Conversation,
  type ConversationDetail,
} from '@agent18/contracts';
import type { QueryResultRow } from 'pg';
const view = (r: QueryResultRow): Conversation => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
export class ConversationService {
  constructor(private db: Database) {}
  async list(scope: Scope, offset = 0) {
    return scoped(this.db, scope, async (c) => {
      const rows = (
        await c.query(
          'SELECT * FROM core.conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 51 OFFSET $1',
          [offset],
        )
      ).rows;
      return {
        conversations: rows.slice(0, 50).map(view),
        nextOffset: rows.length > 50 ? offset + 50 : null,
      };
    });
  }
  async create(scope: Scope, raw: unknown, key: string) {
    const input = conversationInput.parse(raw);
    if (containsSecret(input.title)) throw new AppError('CONVERSATION_SECRET_DETECTED', 400);
    return scoped(this.db, scope, async (c) => {
      await requireTenant(c);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,181921))', [
        JSON.stringify(scopeValues(scope)),
      ]);
      const existing = await c.query('SELECT id FROM core.conversations WHERE request_key=$1', [key]);
      if (
        !existing.rowCount &&
        +(await c.query('SELECT count(*) FROM core.conversations WHERE deleted_at IS NULL')).rows[0].count >=
          1000
      )
        throw new AppError('CONVERSATION_STORAGE_LIMIT', 409);
      const created = await c.query(
        'INSERT INTO core.conversations(id,organization_id,project_id,tenant_id,subject,title,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,project_id,tenant_id,subject,request_key) DO NOTHING RETURNING *',
        [randomUUID(), ...scopeValues(scope), input.title, key],
      );
      const row =
        created.rows[0] ??
        (await c.query('SELECT * FROM core.conversations WHERE request_key=$1', [key])).rows[0];
      if (!row || row.title !== input.title || row.deleted_at)
        throw new AppError('IDEMPOTENCY_CONFLICT', 409);
      return { conversation: view(row), replayed: !created.rowCount };
    });
  }
  async detail(scope: Scope, id: string, after = 0): Promise<ConversationDetail> {
    return scoped(this.db, scope, async (c) => {
      const row = (await c.query('SELECT * FROM core.conversations WHERE id=$1 AND deleted_at IS NULL', [id]))
        .rows[0];
      if (!row) throw new AppError('NOT_FOUND', 404);
      const rows = (
        await c.query(
          'SELECT * FROM core.conversation_messages WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 101',
          [id, after],
        )
      ).rows;
      const linked = (
        await c.query(
          'SELECT c.id,c.title,c.status FROM core.conversation_cases l JOIN core.cases c ON c.id=l.case_id WHERE l.conversation_id=$1 AND c.deleted_at IS NULL ORDER BY l.created_at LIMIT 100',
          [id],
        )
      ).rows;
      return {
        conversation: view(row),
        messages: rows.slice(0, 100).map((r) => ({
          id: r.id,
          sequence: r.sequence,
          role: r.role,
          body: r.body,
          origin: r.origin,
          references: r.result_refs,
          createdAt: r.created_at.toISOString(),
        })),
        nextAfter: rows.length > 100 ? rows[99]!.sequence : null,
        cases: linked as ConversationDetail['cases'],
      };
    });
  }
  async append(scope: Scope, id: string, raw: unknown, key: string) {
    const input = conversationMessageInput.parse(raw);
    if (containsSecret(JSON.stringify(input))) throw new AppError('CONVERSATION_SECRET_DETECTED', 400);
    return scoped(this.db, scope, async (c) => {
      const row = (
        await c.query('SELECT * FROM core.conversations WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
      ).rows[0];
      if (!row) throw new AppError('NOT_FOUND', 404);
      const previous = (
        await c.query(
          'SELECT id,sequence,role,body,result_refs FROM core.conversation_messages WHERE conversation_id=$1 AND request_key=$2',
          [id, key],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.role !== input.role ||
          previous.body !== input.body ||
          canonical(previous.result_refs) !== canonical(input.references)
        )
          throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return { id: previous.id, sequence: previous.sequence, replayed: true };
      }
      if (row.next_sequence > 500) throw new AppError('CONVERSATION_LIMIT', 409);
      const message = randomUUID();
      await c.query(
        'INSERT INTO core.conversation_messages(id,conversation_id,organization_id,project_id,tenant_id,subject,sequence,role,body,request_key,result_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          message,
          id,
          ...scopeValues(scope),
          row.next_sequence,
          input.role,
          input.body,
          key,
          JSON.stringify(input.references),
        ],
      );
      await c.query(
        'UPDATE core.conversations SET next_sequence=next_sequence+1,updated_at=now() WHERE id=$1',
        [id],
      );
      return { id: message, sequence: row.next_sequence, replayed: false };
    });
  }
  async link(scope: Scope, id: string, caseId: string) {
    return scoped(this.db, scope, async (c) => {
      if (
        !(
          await c.query('SELECT id FROM core.conversations WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
            id,
          ])
        ).rowCount ||
        !(await c.query('SELECT id FROM core.cases WHERE id=$1 AND deleted_at IS NULL', [caseId])).rowCount
      )
        throw new AppError('NOT_FOUND', 404);
      await c.query(
        'INSERT INTO core.conversation_cases(conversation_id,case_id,organization_id,project_id,tenant_id,subject) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [id, caseId, ...scopeValues(scope)],
      );
      return { linked: true };
    });
  }
  async remove(scope: Scope, id: string, requestId: string) {
    return scoped(this.db, scope, async (c) => {
      const row = (await c.query('SELECT id FROM core.conversations WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new AppError('NOT_FOUND', 404);
      await c.query(
        "UPDATE core.conversations SET title='已删除',deleted_at=coalesce(deleted_at,now()),updated_at=now() WHERE id=$1",
        [id],
      );
      await c.query(
        "UPDATE core.conversation_messages SET body='',result_refs='[]' WHERE conversation_id=$1",
        [id],
      );
      await c.query('DELETE FROM core.conversation_cases WHERE conversation_id=$1', [id]);
      await c.query(
        "INSERT INTO control.privacy_tombstones(id,organization_id,project_id,tenant_id,subject,resource_type,resource_id) VALUES($1,$2,$3,$4,$5,'conversation',$6) ON CONFLICT DO NOTHING",
        [randomUUID(), ...scopeValues(scope), id],
      );
      await auditInTransaction(c, scope, {
        requestId,
        action: 'conversation.delete',
        decision: 'ALLOW',
        reason: 'BODY_REMOVED_TICKETS_RETAINED',
      });
      return { deleted: true };
    });
  }
}
