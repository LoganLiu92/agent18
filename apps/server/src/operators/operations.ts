import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent18/domain';
import { enqueueObservation } from '@agent18/application';
import type { SupportOperation } from './support.js';
export function registerOperatorOperations(app: FastifyInstance, run: SupportOperation) {
  const base = '/operator/projects/:key/operations';
  app.get(base, (req) =>
    run(req, 'operations.read', async (c, p) => {
      const q = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) }).parse(req.query);
      const jobs = (
        await c.query(
          "SELECT j.id,j.case_id,j.kind,j.state,j.reason,j.attempts,j.created_at,j.updated_at,j.tenant_id FROM control.observation_jobs j WHERE organization_id=$1 AND project_id=$2 AND control.operator_support_access(organization_id,project_id,tenant_id,'engineering') ORDER BY created_at DESC,id LIMIT 51 OFFSET $3",
          [p.organizationId, p.projectId, q.offset],
        )
      ).rows;
      const incidents = (
        await c.query(
          "SELECT i.id,i.check_id,i.state,i.occurrences,i.updated_at,i.last_job_id FROM control.observation_incidents i WHERE organization_id=$1 AND project_id=$2 AND control.operator_support_access(organization_id,project_id,'__operations__','engineering') ORDER BY updated_at DESC LIMIT 100",
          [p.organizationId, p.projectId],
        )
      ).rows;
      return {
        enabled: p.operations?.enabled ?? false,
        autoInvestigate: p.operations?.autoInvestigate ?? false,
        intervalSeconds: p.operations?.intervalSeconds ?? null,
        checks: p.operations?.checks.map((x) => ({ id: x.id, title: x.title, kind: x.kind })) ?? [],
        jobs: jobs.slice(0, 50),
        nextOffset: jobs.length > 50 ? q.offset + 50 : null,
        incidents,
      };
    }),
  );
  app.get(base + '/:id', (req) =>
    run(req, 'operations.read', async (c, p) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const job = (
        await c.query(
          "SELECT id,case_id,kind,state,reason,attempts,created_at,updated_at,tenant_id FROM control.observation_jobs WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND control.operator_support_access(organization_id,project_id,tenant_id,'engineering')",
          [id, p.organizationId, p.projectId],
        )
      ).rows[0];
      if (!job) throw new AppError('NOT_FOUND', 404);
      const report =
        (await c.query('SELECT payload FROM core.observation_reports WHERE job_id=$1', [id])).rows[0]
          ?.payload ?? null;
      return { job, report };
    }),
  );
  app.post(base + '/investigate', (req) => {
    const input = z
      .object({ caseId: z.string().uuid(), requestKey: z.string().uuid() })
      .strict()
      .parse(req.body);
    return run(req, 'operations.read', async (c, p, actor) => {
      const ticket = (
        await c.query(
          "SELECT id,tenant_id,subject FROM core.cases WHERE id=$1 AND deleted_at IS NULL AND control.operator_support_access(organization_id,project_id,tenant_id,'engineering') FOR UPDATE",
          [input.caseId],
        )
      ).rows[0];
      if (!ticket) throw new AppError('NOT_FOUND', 404);
      if (!p.operations?.enabled || !p.operations.autoInvestigate || !p.operations.checks.length)
        throw new AppError('OPERATIONS_NOT_CONFIGURED', 409);
      const key = 'operator:' + input.caseId + ':' + input.requestKey;
      const previous = (
        await c.query(
          'SELECT id FROM control.observation_jobs WHERE organization_id=$1 AND project_id=$2 AND dedup_key=$3',
          [p.organizationId, p.projectId, key],
        )
      ).rows[0];
      if (previous) return { id: previous.id, replayed: true };
      const pending = +(
        await c.query(
          "SELECT count(*) FROM control.observation_jobs WHERE case_id=$1 AND state IN ('pending','running')",
          [input.caseId],
        )
      ).rows[0].count;
      if (pending >= 2) throw new AppError('INVESTIGATION_ALREADY_QUEUED', 409);
      const id = await enqueueObservation(
        c,
        {
          organizationId: p.organizationId,
          projectId: p.projectId,
          tenantId: ticket.tenant_id,
          subject: ticket.subject,
        },
        p.operations,
        'case',
        key,
        ticket.id,
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'operations.investigate',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id, replayed: false };
    });
  });
}
