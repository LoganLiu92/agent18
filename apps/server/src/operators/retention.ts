import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { SupportOperation } from './support.js';
const days = z.number().int().min(1).max(3650).nullable();
export function registerOperatorRetention(app: FastifyInstance, run: SupportOperation) {
  const path = '/operator/projects/:key/retention';
  app.get(path, (req) =>
    run(req, 'source.configure', async (c, p) => ({
      policy: (
        await c.query(
          'SELECT conversation_days,ticket_days,attachment_days,evidence_days,audit_days,updated_at FROM control.retention_policies WHERE organization_id=$1 AND project_id=$2',
          [p.organizationId, p.projectId],
        )
      ).rows[0] ?? {
        conversation_days: null,
        ticket_days: null,
        attachment_days: null,
        evidence_days: null,
        audit_days: null,
      },
      execution: 'owner-maintenance-cli',
    })),
  );
  app.post(path, (req) => {
    const input = z
      .object({
        conversation_days: days,
        ticket_days: days,
        attachment_days: days,
        evidence_days: days,
        audit_days: z.number().int().min(30).max(3650).nullable(),
      })
      .strict()
      .parse(req.body);
    return run(req, 'source.configure', async (c, p, actor) => {
      await c.query(
        'INSERT INTO control.retention_policies(organization_id,project_id,conversation_days,ticket_days,attachment_days,evidence_days,audit_days,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,project_id) DO UPDATE SET conversation_days=excluded.conversation_days,ticket_days=excluded.ticket_days,attachment_days=excluded.attachment_days,evidence_days=excluded.evidence_days,audit_days=excluded.audit_days,updated_by=excluded.updated_by,updated_at=now()',
        [
          p.organizationId,
          p.projectId,
          input.conversation_days,
          input.ticket_days,
          input.attachment_days,
          input.evidence_days,
          input.audit_days,
          actor.account.id,
        ],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'privacy.retention.configure',$3,$4)",
        [randomUUID(), actor.account.id, p.projectId, req.id],
      );
      return { updated: true };
    });
  });
}
