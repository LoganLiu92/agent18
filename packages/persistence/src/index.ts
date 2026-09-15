import pg from 'pg';
import type { PoolClient } from 'pg';
import type { Scope, SupportCase } from '@agent18/contracts';
import { AppError } from '@agent18/domain';
export const { Pool } = pg;
export type Database = pg.Pool;
export async function scoped<T>(
  pool: Database,
  scope: Scope,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('agent18.organization_id',$1,true), set_config('agent18.project_id',$2,true), set_config('agent18.tenant_id',$3,true), set_config('agent18.subject',$4,true), set_config('statement_timeout','5000',true)",
      [scope.organizationId, scope.projectId, scope.tenantId, scope.subject],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export const scopeValues = (scope: Scope): [string, string, string, string] => [
  scope.organizationId,
  scope.projectId,
  scope.tenantId,
  scope.subject,
];
export async function requireTenant(client: PoolClient): Promise<void> {
  if (!(await client.query('SELECT 1 FROM core.tenants LIMIT 1')).rowCount)
    throw new AppError('UNKNOWN_TENANT', 403);
}
export function caseView(row: pg.QueryResultRow): SupportCase {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    context: row.context,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export type AuditRecord = {
  caseId?: string;
  requestId: string;
  action: string;
  decision: 'ALLOW' | 'DENY';
  reason: string;
};
export async function audit(pool: Database, scope: Scope, record: AuditRecord): Promise<void> {
  try {
    await scoped(pool, scope, async (client) => {
      await auditInTransaction(client, scope, record);
    });
  } catch {
    throw new AppError('AUDIT_UNAVAILABLE', 503);
  }
}
export async function auditInTransaction(
  client: PoolClient,
  scope: Scope,
  record: AuditRecord,
): Promise<void> {
  await client.query(
    'INSERT INTO core.audit (id,organization_id,project_id,tenant_id,subject,case_id,request_id,action,decision,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      crypto.randomUUID(),
      ...scopeValues(scope),
      record.caseId ?? null,
      record.requestId,
      record.action,
      record.decision,
      record.reason,
    ],
  );
}
