import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { privacyReplaySql, type Tombstone } from './privacy.js';
const kinds = [
  ['conversation', 'conversation_days'],
  ['ticket', 'ticket_days'],
  ['attachment', 'attachment_days'],
  ['runtime_evidence', 'evidence_days'],
  ['audit', 'audit_days'],
] as const;
/** Uses the one-shot migration credential. Never called with a customer or model-supplied SQL statement. */
export async function runRetention(db: Pool, apply = false) {
  const c = await db.connect(),
    result: { projectId: string; kind: string; selected: number; applied: boolean }[] = [];
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(181920)');
    const policies = (
      await c.query('SELECT * FROM control.retention_policies ORDER BY organization_id,project_id')
    ).rows;
    for (const policy of policies)
      for (const [kind, column] of kinds) {
        const days = policy[column];
        if (days == null) continue;
        const table =
          kind === 'conversation' ? 'core.conversations' : kind === 'audit' ? 'core.audit' : 'core.cases';
        const age = kind === 'audit' ? 'r.created_at' : 'r.updated_at';
        const conditions =
          kind === 'conversation'
            ? `AND r.deleted_at IS NULL`
            : kind === 'audit'
              ? ''
              : `AND r.deleted_at IS NULL AND r.ticket_status IN ('resolved','closed') AND NOT EXISTS(SELECT 1 FROM core.runs x WHERE x.case_id=r.id AND x.state IN ('pending','running')) AND NOT EXISTS(SELECT 1 FROM control.observation_jobs j WHERE j.case_id=r.id AND j.state IN ('pending','running'))`;
        const rows = (
          await c.query(
            `SELECT r.id,r.organization_id,r.project_id,r.tenant_id,r.subject FROM ${table} r WHERE r.organization_id=$1 AND r.project_id=$2 AND ${age}<now()-$3*interval '1 day' ${conditions} AND NOT EXISTS(SELECT 1 FROM control.privacy_tombstones t WHERE t.resource_id=r.id AND t.resource_type=$4) ORDER BY ${age},r.id LIMIT 200 FOR UPDATE OF r`,
            [policy.organization_id, policy.project_id, days, kind],
          )
        ).rows;
        if (apply && rows.length) {
          const tombstones: Tombstone[] = rows.map((r) => ({
            id: randomUUID(),
            organization_id: r.organization_id,
            project_id: r.project_id,
            tenant_id: r.tenant_id,
            subject: r.subject,
            resource_type: kind,
            resource_id: r.id,
            created_at: new Date().toISOString(),
          }));
          await c.query(privacyReplaySql(tombstones));
        }
        result.push({ projectId: policy.project_id, kind, selected: rows.length, applied: apply });
      }
    if (apply)
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,NULL,'privacy.retention.apply',NULL,'retention-maintenance')",
        [randomUUID()],
      );
    await c.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { apply, limitPerKind: 200, results: result };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
