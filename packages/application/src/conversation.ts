import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import { scoped, scopeValues, auditInTransaction, caseView, type Database } from '@agent18/persistence';
import type { Scope, CaseMessage } from '@agent18/contracts';
export const messageInput = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
export async function caseMessages(db: Database, scope: Scope, caseId: string): Promise<CaseMessage[]> {
  return scoped(db, scope, async (c) => {
    if (!(await c.query('SELECT 1 FROM core.cases WHERE id=$1', [caseId])).rowCount)
      throw new AppError('NOT_FOUND', 404);
    return (
      await c.query(
        'SELECT id,author_kind,body,created_at FROM (SELECT * FROM core.case_messages WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100) m ORDER BY created_at,id',
        [caseId],
      )
    ).rows.map((r) => ({
      id: r.id,
      author: r.author_kind,
      body: r.body,
      createdAt: r.created_at.toISOString(),
    }));
  });
}
export async function addCaseMessage(
  db: Database,
  scope: Scope,
  caseId: string,
  author: 'customer' | 'support',
  raw: unknown,
  key: string,
  requestId: string,
) {
  const { body } = messageInput.parse(raw);
  return scoped(db, scope, async (c) => {
    if (!(await c.query('SELECT 1 FROM core.cases WHERE id=$1 FOR UPDATE', [caseId])).rowCount)
      throw new AppError('NOT_FOUND', 404);
    const existing = (
      await c.query(
        'SELECT body FROM core.case_messages WHERE case_id=$1 AND author_kind=$2 AND request_key=$3',
        [caseId, author, key],
      )
    ).rows[0];
    if (existing) {
      if (existing.body !== body) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
      return { replayed: true };
    }
    await c.query(
      'INSERT INTO core.case_messages(id,case_id,organization_id,project_id,tenant_id,subject,author_kind,body,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [randomUUID(), caseId, ...scopeValues(scope), author, body, key],
    );
    await c.query('UPDATE core.cases SET updated_at=now() WHERE id=$1', [caseId]);
    await auditInTransaction(c, scope, {
      caseId,
      requestId,
      action: 'case.message',
      decision: 'ALLOW',
      reason: author === 'support' ? 'LOCAL_OWNER_REPLY' : 'CUSTOMER_FOLLOW_UP',
    });
    return { replayed: false };
  });
}
export async function changeCaseStatus(
  db: Database,
  scope: Scope,
  caseId: string,
  status: 'resolved' | 'needs_human',
  requestId: string,
) {
  return scoped(db, scope, async (c) => {
    const row = (
      await c.query('UPDATE core.cases SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [
        caseId,
        status,
      ])
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', 404);
    await auditInTransaction(c, scope, {
      caseId,
      requestId,
      action: 'case.status',
      decision: 'ALLOW',
      reason: status === 'resolved' ? 'CUSTOMER_RESOLVED' : 'CUSTOMER_REOPENED',
    });
    return { case: caseView(row) };
  });
}
