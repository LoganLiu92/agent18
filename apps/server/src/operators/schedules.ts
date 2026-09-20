import { analyticsMetric, analyticsHash } from '../../../../packages/application/src/analytics.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import { containsSecret } from '@agent18/knowledge';
import type { FastifyInstance } from 'fastify';
import type { SupportOperation } from './support.js';
import { reportScheduleSchema, nextReportDue } from '../../../../packages/application/src/report-schedule.js';
export function registerReportSchedules(app: FastifyInstance, run: SupportOperation) {
  const base = '/operator/projects/:key/insights';
  app.get(base + '/schedules', (req) =>
    run(req, 'ticket.read', async (c, p, actor) => ({
      schedules: (
        await c.query(
          `SELECT id,title,definition,enabled,version,next_due,last_reason,created_at FROM control.report_schedules WHERE NOT archived AND organization_id=$1 AND project_id=$2 AND operator_id=$3 AND control.report_actor_allowed(operator_id,organization_id,project_id,all_tenants,tenant_ids) ORDER BY created_at DESC LIMIT 100`,
          [p.organizationId, p.projectId, actor.account.id],
        )
      ).rows,
    })),
  );
  app.post(base + '/schedules', (req) => {
    const input = z
      .object({ title: z.string().trim().min(2).max(120), definition: reportScheduleSchema })
      .strict()
      .parse(req.body);
    if (containsSecret(input.title)) throw new AppError('INSIGHT_SECRET_DETECTED', 400);
    return run(req, 'ticket.read', async (c, p, actor) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,182001))', [
        actor.account.id + ':' + p.projectId,
      ]);
      if (
        +(
          await c.query(
            'SELECT count(*) FROM control.report_schedules WHERE NOT archived AND operator_id=$1 AND project_id=$2',
            [actor.account.id, p.projectId],
          )
        ).rows[0].count >= 100
      )
        throw new AppError('REPORT_SCHEDULE_LIMIT', 409);
      const grant = (
        await c.query(
          'SELECT all_tenants,tenant_ids FROM control.operator_tenant_grants WHERE operator_id=$1 AND organization_id=$2 AND project_id=$3',
          [actor.account.id, p.organizationId, p.projectId],
        )
      ).rows[0];
      const all = input.definition.tenant ? false : (grant?.all_tenants ?? false),
        tenants = input.definition.tenant ? [input.definition.tenant] : (grant?.tenant_ids ?? []);
      if (
        !(
          await c.query('SELECT control.report_actor_allowed($1,$2,$3,$4,$5) AS allowed', [
            actor.account.id,
            p.organizationId,
            p.projectId,
            all,
            tenants,
          ])
        ).rows[0].allowed
      )
        throw new AppError('INSIGHT_SCOPE_REQUIRED', 403);
      if (input.definition.kind === 'analytics_report')
        analyticsMetric(p.analytics, {
          metricId: input.definition.metricId!,
          tenant: input.definition.tenant,
          days: input.definition.days,
          dimensions: input.definition.dimensions,
        });
      const id = randomUUID();
      await c.query(
        'INSERT INTO control.report_schedules(id,organization_id,project_id,operator_id,title,definition,tenant_ids,all_tenants,next_due) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          id,
          p.organizationId,
          p.projectId,
          actor.account.id,
          input.title,
          JSON.stringify({
            ...input.definition,
            ...(input.definition.kind === 'analytics_report'
              ? { configHash: analyticsHash(p.analytics!) }
              : {}),
          }),
          tenants,
          all,
          nextReportDue(new Date(), input.definition),
        ],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'insight.schedule.create',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id };
    });
  });
  app.post(base + '/schedules/:id', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      input = z
        .object({ version: z.number().int().positive(), enabled: z.boolean() })
        .strict()
        .parse(req.body);
    return run(req, 'ticket.read', async (c, p, actor) => {
      const row = (
        await c.query(
          'SELECT * FROM control.report_schedules WHERE NOT archived AND id=$1 AND organization_id=$2 AND project_id=$3 AND operator_id=$4 FOR UPDATE',
          [id, p.organizationId, p.projectId, actor.account.id],
        )
      ).rows[0];
      if (!row) throw new AppError('NOT_FOUND', 404);
      if (row.version !== input.version) throw new AppError('REPORT_VERSION_CONFLICT', 409);
      if (
        input.enabled &&
        !(
          await c.query('SELECT control.report_actor_allowed($1,$2,$3,$4,$5) AS allowed', [
            actor.account.id,
            p.organizationId,
            p.projectId,
            row.all_tenants,
            row.tenant_ids,
          ])
        ).rows[0].allowed
      )
        throw new AppError('INSIGHT_SCOPE_REQUIRED', 403);
      await c.query(
        'UPDATE control.report_schedules SET enabled=$2,version=version+1,next_due=$3,last_reason=NULL,updated_at=now() WHERE id=$1',
        [
          id,
          input.enabled,
          nextReportDue(
            new Date(),
            reportScheduleSchema.parse(
              Object.fromEntries(Object.entries(row.definition).filter(([k]) => k !== 'configHash')),
            ),
          ),
        ],
      );
      if (!input.enabled)
        await c.query(
          "UPDATE control.automation_jobs SET state='cancelled',reason='SCHEDULE_PAUSED',completed_at=now() WHERE schedule_id=$1 AND state IN ('pending','running')",
          [id],
        );
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [
          randomUUID(),
          actor.account.id,
          input.enabled ? 'insight.schedule.resume' : 'insight.schedule.pause',
          id,
          req.id,
        ],
      );
      return { version: row.version + 1 };
    });
  });
  app.post(base + '/schedules/:id/run', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      { requestKey } = z.object({ requestKey: z.string().uuid() }).strict().parse(req.body);
    return run(req, 'ticket.read', async (c, p, actor) => {
      const row = (
        await c.query(
          'SELECT * FROM control.report_schedules WHERE NOT archived AND id=$1 AND organization_id=$2 AND project_id=$3 AND operator_id=$4 FOR UPDATE',
          [id, p.organizationId, p.projectId, actor.account.id],
        )
      ).rows[0];
      if (!row) throw new AppError('NOT_FOUND', 404);
      if (!row.enabled) throw new AppError('REPORT_SCHEDULE_PAUSED', 409);
      if (
        !(
          await c.query('SELECT control.report_actor_allowed($1,$2,$3,$4,$5) AS allowed', [
            actor.account.id,
            p.organizationId,
            p.projectId,
            row.all_tenants,
            row.tenant_ids,
          ])
        ).rows[0].allowed
      )
        throw new AppError('INSIGHT_SCOPE_REQUIRED', 403);
      const key = 'manual:' + id + ':' + requestKey,
        existing = (
          await c.query(
            'SELECT id FROM control.automation_jobs WHERE organization_id=$1 AND project_id=$2 AND dedup_key=$3',
            [p.organizationId, p.projectId, key],
          )
        ).rows[0];
      if (existing) return existing;
      if (
        +(
          await c.query(
            "SELECT count(*) FROM control.automation_jobs WHERE schedule_id=$1 AND created_at>now()-interval '1 hour'",
            [id],
          )
        ).rows[0].count >= 10
      )
        throw new AppError('REPORT_RUN_LIMIT', 429);
      const job = randomUUID();
      await c.query(
        'INSERT INTO control.automation_jobs(id,organization_id,project_id,operator_id,schedule_id,kind,dedup_key,definition,tenant_ids,all_tenants) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          job,
          p.organizationId,
          p.projectId,
          actor.account.id,
          id,
          row.definition.kind,
          key,
          JSON.stringify({ ...row.definition, title: row.title }),
          row.tenant_ids,
          row.all_tenants,
        ],
      );
      return { id: job };
    });
  });
  app.post(base + '/schedules/:id/archive', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    return run(req, 'ticket.read', async (c, p, actor) => {
      const row = (
        await c.query(
          'SELECT version,archived FROM control.report_schedules WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND operator_id=$4 FOR UPDATE',
          [id, p.organizationId, p.projectId, actor.account.id],
        )
      ).rows[0];
      if (!row) throw new AppError('NOT_FOUND', 404);
      if (row.archived) return { archived: true };
      if (row.version !== version) throw new AppError('REPORT_VERSION_CONFLICT', 409);
      await c.query(
        'UPDATE control.report_schedules SET archived=true,enabled=false,version=version+1,updated_at=now() WHERE id=$1',
        [id],
      );
      await c.query(
        "UPDATE control.automation_jobs SET state='cancelled',reason='SCHEDULE_ARCHIVED',completed_at=now() WHERE schedule_id=$1 AND state IN ('pending','running')",
        [id],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'insight.schedule.archive',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { archived: true };
    });
  });
  app.get(base + '/jobs', (req) =>
    run(req, 'ticket.read', async (c, p, actor) => ({
      jobs: (
        await c.query(
          `SELECT id,schedule_id,kind,state,attempts,reason,report_id,created_at,completed_at FROM control.automation_jobs WHERE organization_id=$1 AND project_id=$2 AND operator_id=$3 AND control.report_actor_allowed(operator_id,organization_id,project_id,all_tenants,tenant_ids) ORDER BY created_at DESC LIMIT 100`,
          [p.organizationId, p.projectId, actor.account.id],
        )
      ).rows,
    })),
  );
}
