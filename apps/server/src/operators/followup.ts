import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent18/domain';
import type { SupportOperation } from './support.js';
export function registerOperatorFollowup(app: FastifyInstance, run: SupportOperation) {
  const base = '/operator/projects/:key';
  app.get(base + '/support/settings', (req) =>
    run(req, 'source.configure', async (c, p) => ({
      settings: (
        await c.query(
          'SELECT enabled,targets,calendar,response_targets AS "responseTargets" FROM control.support_settings WHERE organization_id=$1 AND project_id=$2',
          [p.organizationId, p.projectId],
        )
      ).rows[0] ?? {
        enabled: false,
        responseTargets: { low: 480, normal: 240, high: 60, urgent: 15 },
        calendar: null,
        targets: { low: 4320, normal: 1440, high: 240, urgent: 60 },
      },
      calendar: 'Per-ticket calendar snapshot; waiting states pause the clock',
    })),
  );
  app.post(base + '/support/settings', (req) => {
    const minutes = z.number().int().min(1).max(525600);
    const input = z
      .object({
        calendar: z
          .object({
            timezone: z
              .string()
              .max(80)
              .refine((v) => {
                try {
                  new Intl.DateTimeFormat('en', { timeZone: v });
                  return true;
                } catch {
                  return false;
                }
              }),
            weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
            start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
            end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
            holidays: z
              .array(
                z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/)
                  .refine((v) => {
                    const d = new Date(v);
                    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
                  }),
              )
              .max(366),
          })
          .strict()
          .refine((v) => v.start < v.end && new Set(v.weekdays).size === v.weekdays.length)
          .nullable()
          .default(null),
        enabled: z.boolean(),
        responseTargets: z
          .object({ low: minutes, normal: minutes, high: minutes, urgent: minutes })
          .strict()
          .default({ low: 480, normal: 240, high: 60, urgent: 15 }),
        targets: z.object({ low: minutes, normal: minutes, high: minutes, urgent: minutes }).strict(),
      })
      .strict()
      .parse(req.body);
    return run(req, 'source.configure', async (c, p, actor) => {
      await c.query(
        'INSERT INTO control.support_settings(organization_id,project_id,enabled,targets,updated_by,calendar,response_targets) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,project_id) DO UPDATE SET enabled=excluded.enabled,targets=excluded.targets,response_targets=excluded.response_targets,calendar=excluded.calendar,updated_by=excluded.updated_by,updated_at=now()',
        [
          p.organizationId,
          p.projectId,
          input.enabled,
          JSON.stringify(input.targets),
          actor.account.id,
          input.calendar ? JSON.stringify(input.calendar) : null,
          JSON.stringify(input.responseTargets),
        ],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'ticket.sla.configure',$3,$4)",
        [randomUUID(), actor.account.id, p.projectId, req.id],
      );
      return { updated: true };
    });
  });
  app.get(base + '/support/notifications', (req) =>
    run(req, 'ticket.read', async (c, _p, actor) => ({
      notifications: (
        await c.query(
          'SELECT c.id,c.title,c.ticket_version,c.ticket_status,c.updated_at FROM core.cases c LEFT JOIN control.ticket_notification_reads n ON n.case_id=c.id AND n.operator_id=$1 WHERE c.assignee_id=$1 AND c.deleted_at IS NULL AND c.ticket_version>coalesce(n.version,0) ORDER BY c.updated_at DESC LIMIT 100',
          [actor.account.id],
        )
      ).rows,
    })),
  );
  app.post(base + '/support/notifications/:id/read', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      input = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    return run(req, 'ticket.read', async (c, _p, actor) => {
      const ticket = (
        await c.query(
          'SELECT ticket_version FROM core.cases WHERE id=$1 AND assignee_id=$2 AND deleted_at IS NULL',
          [id, actor.account.id],
        )
      ).rows[0];
      if (!ticket) throw new AppError('NOT_FOUND', 404);
      if (input.version > ticket.ticket_version) throw new AppError('TICKET_VERSION_CONFLICT', 409);
      await c.query(
        'INSERT INTO control.ticket_notification_reads(operator_id,case_id,version) VALUES($1,$2,$3) ON CONFLICT(operator_id,case_id) DO UPDATE SET version=greatest(ticket_notification_reads.version,excluded.version),read_at=now()',
        [actor.account.id, id, input.version],
      );
      return { read: true };
    });
  });
}
