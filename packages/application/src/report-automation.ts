import { calculateAnalytics, analyticsHash } from './analytics.js';
import type { AnalyticsConfig } from '@agent18/contracts';
import { randomUUID } from 'node:crypto';
import type { Database } from '@agent18/persistence';
import { AppError } from '@agent18/domain';
import { calculateSupportInsight, supportDefinitionVersion } from './support-insights.js';
import { reportScheduleSchema, nextReportDue, localDay } from './report-schedule.js';
export class ReportAutomation {
  constructor(
    private db: Database,
    private projects: { organizationId: string; projectId: string; analytics?: AnalyticsConfig }[],
  ) {}
  async tick() {
    const c = await this.db.connect();
    let job: Record<string, any> | undefined;
    const lease = randomUUID();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('statement_timeout','5000',true)");
      const due = (
        await c.query(
          'SELECT * FROM control.report_schedules WHERE enabled AND next_due<=now() ORDER BY next_due,id LIMIT 20 FOR UPDATE SKIP LOCKED',
        )
      ).rows;
      for (const schedule of due) {
        const configured = this.projects.some(
          (p) => p.organizationId === schedule.organization_id && p.projectId === schedule.project_id,
        );
        const allowed =
          configured &&
          (
            await c.query('SELECT control.report_actor_allowed($1,$2,$3,$4,$5) AS allowed', [
              schedule.operator_id,
              schedule.organization_id,
              schedule.project_id,
              schedule.all_tenants,
              schedule.tenant_ids,
            ])
          ).rows[0].allowed;
        if (!allowed) {
          await c.query(
            "UPDATE control.report_schedules SET enabled=false,version=version+1,last_reason='PERMISSION_REVOKED' WHERE id=$1",
            [schedule.id],
          );
          continue;
        }
        const definition = reportScheduleSchema.parse(
            Object.fromEntries(Object.entries(schedule.definition).filter(([k]) => k !== 'configHash')),
          ),
          key = 'scheduled:' + schedule.id + ':' + schedule.next_due.toISOString();
        await c.query(
          'INSERT INTO control.automation_jobs(id,organization_id,project_id,operator_id,schedule_id,kind,dedup_key,definition,tenant_ids,all_tenants) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organization_id,project_id,dedup_key) DO NOTHING',
          [
            randomUUID(),
            schedule.organization_id,
            schedule.project_id,
            schedule.operator_id,
            schedule.id,
            definition.kind,
            key,
            JSON.stringify({ ...schedule.definition, title: schedule.title }),
            schedule.tenant_ids,
            schedule.all_tenants,
          ],
        );
        // Coalesce downtime into one run instead of replaying an unbounded backlog.
        await c.query('UPDATE control.report_schedules SET next_due=$2,updated_at=now() WHERE id=$1', [
          schedule.id,
          nextReportDue(new Date(), definition, localDay(schedule.next_due, definition.timezone)),
        ]);
      }
      await c.query(
        "UPDATE control.automation_jobs SET state='failed',reason='ATTEMPTS_EXHAUSTED',completed_at=now() WHERE state='running' AND lease_until<now() AND attempts>=3",
      );
      job = (
        await c.query(
          `UPDATE control.automation_jobs SET state='running',lease_id=$1,lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE id=(SELECT id FROM control.automation_jobs WHERE (state='pending' AND next_attempt<=now()) OR (state='running' AND lease_until<now() AND attempts<3) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
          [lease],
        )
      ).rows[0];
      await c.query('COMMIT');
      if (!job) return { processed: false };
      if (
        !this.projects.some(
          (p) => p.organizationId === job!.organization_id && p.projectId === job!.project_id,
        )
      )
        throw new AppError('PERMISSION_REVOKED', 403);
      await c.query('BEGIN');
      await c.query(
        "SELECT set_config('agent18.organization_id',$1,true),set_config('agent18.project_id',$2,true),set_config('agent18.automation_job',$3,true),set_config('agent18.automation_lease',$4,true),set_config('statement_timeout','10000',true)",
        [job.organization_id, job.project_id, job.id, lease],
      );
      if (
        !(
          await c.query('SELECT control.automation_access($1,$2,NULL,$3) AS allowed', [
            job.organization_id,
            job.project_id,
            job.operator_id,
          ])
        ).rows[0].allowed
      )
        throw new AppError('PERMISSION_REVOKED', 403);
      const scheduleDefinition = { ...job.definition };
      delete scheduleDefinition.title;
      delete scheduleDefinition.configHash;
      const definition = reportScheduleSchema.parse(scheduleDefinition);
      const project = this.projects.find(
        (p) => p.organizationId === job!.organization_id && p.projectId === job!.project_id,
      )!;
      if (
        job.kind === 'analytics_report' &&
        (!project.analytics || analyticsHash(project.analytics) !== job.definition.configHash)
      )
        throw new AppError('ANALYTICS_CONFIG_CHANGED', 403);
      const payload =
        job.kind === 'analytics_report'
          ? await calculateAnalytics(project.analytics, project, {
              metricId: definition.metricId!,
              tenant: definition.tenant,
              days: definition.days,
              dimensions: definition.dimensions,
            })
          : await calculateSupportInsight(
              c,
              { days: definition.days, tenant: definition.tenant },
              { allTenants: job.all_tenants, tenantIds: job.tenant_ids },
            );
      const active = (
        await c.query(
          "SELECT id FROM control.automation_jobs WHERE id=$1 AND lease_id=$2 AND state='running' AND lease_until>now() FOR UPDATE",
          [job.id, lease],
        )
      ).rowCount;
      if (!active) throw new AppError('REPORT_LEASE_LOST', 409);
      await c.query(
        'INSERT INTO control.insight_reports(id,organization_id,project_id,operator_id,title,tenant_ids,all_tenants,definition_version,payload,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$1)',
        [
          job.id,
          job.organization_id,
          job.project_id,
          job.operator_id,
          job.definition.title,
          job.tenant_ids,
          job.all_tenants,
          job.kind === 'analytics_report' ? payload.definitionVersion : supportDefinitionVersion,
          JSON.stringify(payload),
        ],
      );
      await c.query(
        "UPDATE control.automation_jobs SET state='completed',report_id=$1,reason='REPORT_SAVED',completed_at=now(),lease_until=NULL WHERE id=$1 AND lease_id=$2",
        [job.id, lease],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'insight.schedule.completed',$3,$4)",
        [randomUUID(), job.operator_id, job.id, job.id],
      );
      await c.query('COMMIT');
      return { processed: true, id: job.id, state: 'completed' };
    } catch (e) {
      await c.query('ROLLBACK');
      if (!job) throw e;
      const reason = e instanceof AppError ? e.code : 'REPORT_FAILED',
        revoked = ['PERMISSION_REVOKED', 'ANALYTICS_CONFIG_CHANGED'].includes(reason);
      await c.query(
        `UPDATE control.automation_jobs SET state=$3,reason=$4,next_attempt=now()+interval '1 minute',lease_until=NULL,completed_at=CASE WHEN $3='pending' THEN NULL ELSE now() END WHERE id=$1 AND lease_id=$2 AND state='running'`,
        [job.id, lease, revoked ? 'cancelled' : job.attempts < 3 ? 'pending' : 'failed', reason],
      );
      if (revoked && job.schedule_id)
        await c.query(
          'UPDATE control.report_schedules SET enabled=false,version=version+1,last_reason=$2 WHERE id=$1',
          [job.schedule_id, reason],
        );
      return {
        processed: true,
        id: job.id,
        state: revoked ? 'cancelled' : job.attempts < 3 ? 'pending' : 'failed',
        reason,
      };
    } finally {
      c.release();
    }
  }
}
