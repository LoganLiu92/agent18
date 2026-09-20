import { calculateSupportInsight } from '../../../../packages/application/src/support-insights.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent18/domain';
import { containsSecret } from '@agent18/knowledge';
import type { SupportOperation } from './support.js';
const selection = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  tenant: z.string().max(128).default(''),
});
const version = 'support-metrics-v1';
export function registerOperatorInsights(app: FastifyInstance, run: SupportOperation) {
  const base = '/operator/projects/:key/insights';
  async function calculate(
    c: Parameters<Parameters<SupportOperation>[2]>[0],
    p: { organizationId: string; projectId: string },
    actorId: string,
    input: z.infer<typeof selection>,
  ) {
    const grant = (
      await c.query(
        'SELECT all_tenants,tenant_ids FROM control.operator_tenant_grants WHERE operator_id=$1 AND organization_id=$2 AND project_id=$3',
        [actorId, p.organizationId, p.projectId],
      )
    ).rows[0];
    if (
      !grant ||
      (!grant.all_tenants && !grant.tenant_ids.length) ||
      (input.tenant && !grant.all_tenants && !grant.tenant_ids.includes(input.tenant))
    )
      throw new AppError('INSIGHT_SCOPE_REQUIRED', 403);
    const scope = {
      allTenants: input.tenant ? false : grant.all_tenants,
      tenantIds: input.tenant ? [input.tenant] : (grant.tenant_ids as string[]),
    };
    return calculateSupportInsight(c, input, scope);
  }

  app.get(base, (req) =>
    run(req, 'ticket.read', async (c, p, actor) =>
      calculate(c, p, actor.account.id, selection.parse(req.query)),
    ),
  );
  app.get(base + '/reports', (req) =>
    run(req, 'ticket.read', async (c) => {
      const { offset } = z
        .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
        .parse(req.query);
      const rows = (
        await c.query(
          'SELECT id,title,definition_version,created_at FROM control.insight_reports ORDER BY created_at DESC,id LIMIT 51 OFFSET $1',
          [offset],
        )
      ).rows;
      return { reports: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
    }),
  );
  app.post(base + '/reports', (req) => {
    const input = selection
      .extend({ title: z.string().trim().min(2).max(120), requestKey: z.string().uuid() })
      .strict()
      .parse(req.body);
    if (containsSecret(input.title)) throw new AppError('INSIGHT_SECRET_DETECTED', 400);
    return run(req, 'ticket.read', async (c, p, actor) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,183004))', [
        actor.account.id + ':' + p.projectId + ':' + input.requestKey,
      ]);
      const previous = (
        await c.query('SELECT id,title,payload FROM control.insight_reports WHERE request_key=$1', [
          input.requestKey,
        ])
      ).rows[0];
      if (previous) {
        if (
          previous.title !== input.title ||
          previous.payload.selection.days !== input.days ||
          previous.payload.selection.tenant !== input.tenant
        )
          throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return { id: previous.id, replayed: true };
      }
      const report = await calculate(c, p, actor.account.id, selection.parse(input)),
        id = randomUUID();
      await c.query(
        'INSERT INTO control.insight_reports(id,organization_id,project_id,operator_id,title,tenant_ids,all_tenants,definition_version,payload,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          p.organizationId,
          p.projectId,
          actor.account.id,
          input.title,
          report.scope.tenantIds,
          report.scope.allTenants,
          version,
          JSON.stringify(report),
          input.requestKey,
        ],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'insight.save',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id, replayed: false };
    });
  });
  app.get(base + '/reports/:id', (req) =>
    run(req, 'ticket.read', async (c) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const row = (
        await c.query('SELECT id,title,payload,created_at FROM control.insight_reports WHERE id=$1', [id])
      ).rows[0];
      if (!row) throw new AppError('NOT_FOUND', 404);
      return row;
    }),
  );
  app.post(base + '/reports/:id/delete', (req) => {
    z.object({}).strict().parse(req.body);
    return run(req, 'ticket.read', async (c, p, actor) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      if (!(await c.query('DELETE FROM control.insight_reports WHERE id=$1 RETURNING id', [id])).rowCount)
        throw new AppError('NOT_FOUND', 404);
      await c.query(
        "UPDATE control.automation_jobs SET state='cancelled',reason='PRIVACY_ERASURE',lease_until=NULL WHERE id=$1 AND operator_id=$2 AND organization_id=$3 AND project_id=$4",
        [id, actor.account.id, p.organizationId, p.projectId],
      );
      await c.query(
        "INSERT INTO control.privacy_tombstones(id,organization_id,project_id,tenant_id,subject,resource_type,resource_id) VALUES($1,$2,$3,'__report__',$4,'insight',$5) ON CONFLICT DO NOTHING",
        [randomUUID(), p.organizationId, p.projectId, actor.account.id, id],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'insight.delete',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { deleted: true };
    });
  });
}
