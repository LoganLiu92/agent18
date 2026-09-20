import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import { scoped, scopeValues, auditInTransaction, caseView, type Database } from '@agent18/persistence';
import type { Scope, CaseMessage } from '@agent18/contracts';
export const messageInput = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
export async function caseMessages(db: Database, scope: Scope, caseId: string): Promise<CaseMessage[]> {
  return scoped(db, scope, async (c) => {
    if (!(await c.query('SELECT 1 FROM core.cases WHERE id=$1 AND deleted_at IS NULL', [caseId])).rowCount)
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
    if (
      !(await c.query('SELECT 1 FROM core.cases WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [caseId]))
        .rowCount
    )
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
    await c.query('UPDATE core.cases SET updated_at=now() WHERE id=$1 AND deleted_at IS NULL', [caseId]);
    await c.query(
      'INSERT INTO core.ticket_events(id,case_id,organization_id,project_id,tenant_id,subject,action,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        caseId,
        ...scopeValues(scope),
        author === 'customer' ? 'customer.message' : 'owner.message',
        '{}',
      ],
    );
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
    const before = (
      await c.query('SELECT ticket_status FROM core.cases WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
        caseId,
      ])
    ).rows[0];
    const row = (
      await c.query(
        'UPDATE core.cases SET status=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *',
        [caseId, status],
      )
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', 404);
    await c.query(
      "INSERT INTO core.ticket_events(id,case_id,organization_id,project_id,tenant_id,subject,action,detail) VALUES($1,$2,$3,$4,$5,$6,'customer.status',$7)",
      [
        randomUUID(),
        caseId,
        ...scopeValues(scope),
        JSON.stringify({
          from: before?.ticket_status,
          to: row.ticket_status,
          reason: status === 'resolved' ? '客户确认解决' : '客户重新打开',
        }),
      ],
    );
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

export async function deleteCaseCapture(db: Database, scope: Scope, caseId: string, requestId: string) {
  return scoped(db, scope, async (c) => {
    if (
      !(await c.query('SELECT id FROM core.cases WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [caseId]))
        .rowCount
    )
      throw new AppError('NOT_FOUND', 404);
    await c.query(
      "UPDATE control.observation_jobs SET state='cancelled',reason='ATTACHMENT_DELETED',lease_until=NULL WHERE case_id=$1 AND organization_id=$2 AND project_id=$3 AND state IN ('pending','running')",
      [caseId, scope.organizationId, scope.projectId],
    );
    await c.query(
      'DELETE FROM core.observation_reports WHERE job_id IN (SELECT id FROM control.observation_jobs WHERE case_id=$1)',
      [caseId],
    );
    await c.query('DELETE FROM core.case_captures WHERE case_id=$1', [caseId]);
    await c.query(
      "INSERT INTO control.privacy_tombstones(id,organization_id,project_id,tenant_id,subject,resource_type,resource_id) VALUES($1,$2,$3,$4,$5,'attachment',$6) ON CONFLICT DO NOTHING",
      [randomUUID(), ...scopeValues(scope), caseId],
    );
    await auditInTransaction(c, scope, {
      caseId,
      requestId,
      action: 'case.capture.delete',
      decision: 'ALLOW',
      reason: 'ATTACHMENT_AND_DERIVED_REPORTS_REMOVED',
    });
    return { deleted: true };
  });
}
