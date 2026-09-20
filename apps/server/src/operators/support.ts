import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { AppError } from '@agent18/domain';
import { containsSecret } from '@agent18/knowledge';
import type { OperatorService, OperatorSession } from './service.js';
import type { OperatorPermission } from './permissions.js';
import type { Config } from '../../../../scripts/config.js';
const params = (req: FastifyRequest) =>
  z.object({ key: z.string(), id: z.string().uuid().optional() }).parse(req.params);
const states = [
  'new',
  'open',
  'investigating',
  'waiting_customer',
  'waiting_internal',
  'resolved',
  'closed',
] as const;
const transitions: Record<string, readonly string[]> = {
  new: ['open', 'investigating', 'waiting_customer', 'waiting_internal', 'resolved'],
  open: ['investigating', 'waiting_customer', 'waiting_internal', 'resolved'],
  investigating: ['open', 'waiting_customer', 'waiting_internal', 'resolved'],
  waiting_customer: ['open', 'investigating', 'waiting_internal', 'resolved'],
  waiting_internal: ['open', 'investigating', 'waiting_customer', 'resolved'],
  resolved: ['open', 'closed'],
  closed: ['open'],
};
export type SupportOperation = <T>(
  req: FastifyRequest,
  permission: OperatorPermission,
  fn: (c: PoolClient, p: Config['projects'][number], actor: OperatorSession) => Promise<T>,
) => Promise<T>;
export function registerOperatorSupport(
  app: FastifyInstance,
  service: OperatorService,
  session: (req: FastifyRequest) => OperatorSession,
) {
  const base = '/operator/projects/:key';
  const run: SupportOperation = (req, permission, fn) =>
    service.withPermission(session(req), params(req).key, permission, async (c, p) => {
      const actor = session(req);
      await c.query(
        "SELECT set_config('agent18.organization_id',$1,true),set_config('agent18.project_id',$2,true),set_config('agent18.operator_session',$3,true),set_config('statement_timeout','5000',true)",
        [p.organizationId, p.projectId, actor.tokenHash],
      );
      return fn(c, p, actor);
    });
  app.get(base + '/support/access', (req) =>
    run(req, 'source.configure', async (c, p) => ({
      tenants: (await c.query('SELECT tenant_id,display_name FROM core.tenants ORDER BY tenant_id')).rows,
      accounts: (
        await c.query(
          `SELECT a.id,a.display_name,a.username,a.enabled,a.administrator,m.roles,coalesce(g.all_tenants,false) AS all_tenants,coalesce(g.tenant_ids,'{}') AS tenant_ids FROM control.operator_accounts a LEFT JOIN control.operator_memberships m ON m.operator_id=a.id AND m.organization_id=$1 AND m.project_id=$2 LEFT JOIN control.operator_tenant_grants g ON g.operator_id=a.id AND g.organization_id=$1 AND g.project_id=$2 WHERE a.administrator OR m.roles && ARRAY['support','engineer']::text[] ORDER BY a.username LIMIT 201`,
          [p.organizationId, p.projectId],
        )
      ).rows,
    })),
  );
  app.post(base + '/support/access/:id', (req) => {
    const { id } = params(req),
      input = z
        .object({ allTenants: z.boolean(), tenantIds: z.array(z.string().min(1).max(128)).max(100) })
        .strict()
        .parse(req.body);
    return run(req, 'source.configure', async (c, p, actor) => {
      if (!(await c.query('SELECT id FROM control.operator_accounts WHERE id=$1 AND enabled', [id])).rowCount)
        throw new AppError('NOT_FOUND', 404);
      if (input.allTenants && input.tenantIds.length) throw new AppError('INVALID_REQUEST', 400);
      if (
        new Set(input.tenantIds).size !== input.tenantIds.length ||
        (
          await c.query('SELECT tenant_id FROM core.tenants WHERE tenant_id=ANY($1::text[])', [
            input.tenantIds,
          ])
        ).rowCount !== input.tenantIds.length
      )
        throw new AppError('INVALID_REQUEST', 400);
      await c.query(
        `INSERT INTO control.operator_tenant_grants(operator_id,organization_id,project_id,all_tenants,tenant_ids,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(operator_id,organization_id,project_id) DO UPDATE SET all_tenants=excluded.all_tenants,tenant_ids=excluded.tenant_ids,updated_by=excluded.updated_by,updated_at=now()`,
        [id, p.organizationId, p.projectId, input.allTenants, input.tenantIds, actor.account.id],
      );
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'operator.tenant_grant', id, req.id],
      );
      return { updated: true };
    });
  });
  app.get(base + '/tickets', (req) =>
    run(req, 'ticket.read', async (c, p, actor) => {
      const q = z
        .object({
          status: z.enum(['all', ...states]).default('all'),
          priority: z.enum(['all', 'low', 'normal', 'high', 'urgent']).default('all'),
          tenant: z.string().max(128).default(''),
          search: z.string().max(100).default(''),
          team: z.string().max(100).default(''),
          mine: z.enum(['true', 'false']).default('false'),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .parse(req.query);
      const rows = (
        await c.query(
          `SELECT c.id,c.title,c.tenant_id,c.subject,c.ticket_status,c.priority,c.assignee_id,a.display_name AS assignee,c.team,c.ticket_version,c.created_at,c.updated_at FROM core.cases c LEFT JOIN control.operator_accounts a ON a.id=c.assignee_id WHERE c.deleted_at IS NULL AND ($1='all' OR c.ticket_status=$1) AND ($2='all' OR c.priority=$2) AND ($3='' OR c.tenant_id=$3) AND ($4='' OR strpos(lower(c.title),lower($4))>0) AND (NOT $5::boolean OR c.assignee_id=$6) AND ($8='' OR c.team=$8) ORDER BY c.updated_at DESC,c.id LIMIT 51 OFFSET $7`,
          [q.status, q.priority, q.tenant, q.search, q.mine === 'true', actor.account.id, q.offset, q.team],
        )
      ).rows;
      const grant = (
        await c.query(
          'SELECT all_tenants,tenant_ids FROM control.operator_tenant_grants WHERE operator_id=$1 AND organization_id=$2 AND project_id=$3',
          [actor.account.id, p.organizationId, p.projectId],
        )
      ).rows[0] ?? { all_tenants: false, tenant_ids: [] };
      return {
        tickets: rows.slice(0, 50),
        nextOffset: rows.length > 50 ? q.offset + 50 : null,
        grant,
        tenants: (
          await c.query(
            "SELECT tenant_id,display_name FROM core.tenants WHERE control.operator_support_access(organization_id,project_id,tenant_id,'read') ORDER BY tenant_id",
          )
        ).rows,
      };
    }),
  );
  app.get(base + '/tickets/:id', (req) =>
    run(req, 'ticket.read', async (c, p, actor) => {
      const { id } = params(req),
        ticket = (await c.query('SELECT * FROM core.cases WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
      if (!ticket) throw new AppError('NOT_FOUND', 404);
      const messages = (
        await c.query(
          'SELECT id,author_kind,body,created_at FROM core.case_messages WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 501',
          [id],
        )
      ).rows;
      const notes = (
        await c.query(
          'SELECT n.id,n.body,n.created_at,a.display_name AS author FROM core.ticket_notes n JOIN control.operator_accounts a ON a.id=n.operator_id WHERE case_id=$1 ORDER BY n.created_at DESC,n.id LIMIT 101',
          [id],
        )
      ).rows;
      const events = (
        await c.query(
          'SELECT e.id,e.action,e.detail,e.created_at,a.display_name AS actor FROM core.ticket_events e LEFT JOIN control.operator_accounts a ON a.id=e.operator_id WHERE case_id=$1 ORDER BY e.created_at DESC,e.id LIMIT 101',
          [id],
        )
      ).rows;
      const engineering = (
        await c.query("SELECT control.operator_support_access($1,$2,$3,'engineering') AS allowed", [
          p.organizationId,
          p.projectId,
          ticket.tenant_id,
        ])
      ).rows[0].allowed;
      const assignees = (
        await c.query(
          `SELECT a.id,a.display_name FROM control.operator_accounts a JOIN control.operator_tenant_grants g ON g.operator_id=a.id AND g.organization_id=$1 AND g.project_id=$2 LEFT JOIN control.operator_memberships m ON m.operator_id=a.id AND m.organization_id=$1 AND m.project_id=$2 WHERE a.enabled AND NOT a.must_change_password AND (a.administrator OR m.roles && ARRAY['support','engineer']::text[]) AND (g.all_tenants OR $3=ANY(g.tenant_ids)) ORDER BY a.display_name LIMIT 200`,
          [p.organizationId, p.projectId, ticket.tenant_id],
        )
      ).rows;
      const elapsed =
        Number(ticket.sla_elapsed_seconds) +
        (ticket.sla_clock_started_at
          ? Number(
              (
                await c.query('SELECT core.sla_seconds($1,now(),$2) AS seconds', [
                  ticket.sla_clock_started_at,
                  ticket.sla_calendar,
                ])
              ).rows[0].seconds,
            )
          : 0);
      const responseElapsed = ticket.first_response_started_at
        ? Number(
            (
              await c.query('SELECT core.sla_seconds($1,coalesce($2,now()),$3) AS seconds', [
                ticket.first_response_started_at,
                ticket.first_response_at,
                ticket.sla_calendar,
              ])
            ).rows[0].seconds,
          )
        : null;
      const { request_hash: _hash, idempotency_key: _key, ...safe } = ticket;
      return {
        ticket: {
          ...safe,
          firstResponseSla:
            responseElapsed === null
              ? null
              : {
                  targetMinutes: ticket.first_response_target_minutes,
                  elapsedMinutes: Math.round(responseElapsed / 60),
                  completed: !!ticket.first_response_at,
                  breached: responseElapsed > ticket.first_response_target_minutes * 60,
                },
          sla: ticket.sla_target_minutes
            ? {
                targetMinutes: ticket.sla_target_minutes,
                elapsedMinutes: Math.round(elapsed / 60),
                paused: !ticket.sla_clock_started_at,
                breached: elapsed > ticket.sla_target_minutes * 60,
              }
            : null,
        },
        messages: messages.slice(0, 500).reverse(),
        notes: notes.slice(0, 100),
        events: events.slice(0, 100),
        truncated: messages.length > 500 || notes.length > 100 || events.length > 100,
        assignees,
        engineering,
        actorId: actor.account.id,
        transitions: transitions[ticket.ticket_status],
      };
    }),
  );
  app.get(base + '/tickets/:id/history', (req) =>
    run(req, 'ticket.read', async (c) => {
      const { id } = params(req),
        q = z
          .object({
            kind: z.enum(['messages', 'notes', 'events']),
            offset: z.coerce.number().int().min(0).max(1000000).default(0),
          })
          .parse(req.query);
      if (!(await c.query('SELECT id FROM core.cases WHERE id=$1 AND deleted_at IS NULL', [id])).rowCount)
        throw new AppError('NOT_FOUND', 404);
      const query =
        q.kind === 'messages'
          ? 'SELECT id,body,author_kind AS actor,created_at FROM core.case_messages WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET $2'
          : q.kind === 'notes'
            ? 'SELECT n.id,n.body,a.display_name AS actor,n.created_at FROM core.ticket_notes n JOIN control.operator_accounts a ON a.id=n.operator_id WHERE case_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT 101 OFFSET $2'
            : 'SELECT e.id,e.action,e.detail,a.display_name AS actor,e.created_at FROM core.ticket_events e LEFT JOIN control.operator_accounts a ON a.id=e.operator_id WHERE case_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 101 OFFSET $2';
      const rows = (await c.query(query, [id, q.offset])).rows;
      return { records: rows.slice(0, 100), nextOffset: rows.length > 100 ? q.offset + 100 : null };
    }),
  );
  app.post(base + '/tickets/:id', (req) => {
    const input = z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.literal('assign'),
            version: z.number().int().positive(),
            assigneeId: z.string().uuid().nullable(),
            team: z.string().trim().max(100),
            priority: z.enum(['low', 'normal', 'high', 'urgent']),
          })
          .strict(),
        z
          .object({
            action: z.literal('status'),
            version: z.number().int().positive(),
            status: z.enum(states),
            reason: z.string().trim().min(2).max(1000),
            resolution: z
              .object({
                summary: z.string().trim().min(10).max(4000),
                rootCause: z.string().trim().max(4000),
                verification: z.enum(['hypothesis', 'supported', 'verified']),
                publicSummary: z.string().trim().min(10).max(4000),
              })
              .strict()
              .optional(),
          })
          .strict(),
        z
          .object({
            action: z.enum(['reply', 'note']),
            version: z.number().int().positive(),
            body: z.string().trim().min(1).max(4000),
            requestKey: z.string().uuid(),
          })
          .strict(),
      ])
      .parse(req.body);
    if (containsSecret(JSON.stringify(input))) throw new AppError('SUPPORT_SECRET_DETECTED', 400);
    return run(req, 'ticket.edit', async (c, p, actor) => {
      const { id } = params(req),
        ticket = (
          await c.query('SELECT * FROM core.cases WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
        ).rows[0];
      if (!ticket) throw new AppError('NOT_FOUND', 404);
      if (input.action === 'reply' || input.action === 'note') {
        const previous = (
          await c.query(
            input.action === 'reply'
              ? "SELECT body FROM core.case_messages WHERE case_id=$1 AND author_kind='support' AND request_key=$2"
              : 'SELECT body FROM core.ticket_notes WHERE case_id=$1 AND request_key=$2',
            [id, input.requestKey],
          )
        ).rows[0];
        if (previous) {
          if (previous.body !== input.body) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
          return { id, replayed: true };
        }
      }
      if (ticket.ticket_version !== input.version) throw new AppError('TICKET_VERSION_CONFLICT', 409);
      let detail: unknown = {};
      if (input.action === 'assign') {
        if (input.assigneeId) {
          const allowed = (
            await c.query(
              `SELECT a.id FROM control.operator_accounts a JOIN control.operator_tenant_grants g ON g.operator_id=a.id AND g.organization_id=$2 AND g.project_id=$3 LEFT JOIN control.operator_memberships m ON m.operator_id=a.id AND m.organization_id=$2 AND m.project_id=$3 WHERE a.id=$1 AND a.enabled AND NOT a.must_change_password AND (g.all_tenants OR $4=ANY(g.tenant_ids)) AND (a.administrator OR m.roles && ARRAY['support','engineer']::text[])`,
              [input.assigneeId, p.organizationId, p.projectId, ticket.tenant_id],
            )
          ).rowCount;
          if (!allowed) throw new AppError('TICKET_ASSIGNEE_NOT_ALLOWED', 403);
        }
        await c.query(
          'UPDATE core.cases SET assignee_id=$2,team=$3,priority=$4,updated_at=now() WHERE id=$1',
          [id, input.assigneeId, input.team, input.priority],
        );
        detail = { assigneeId: input.assigneeId, team: input.team, priority: input.priority };
      } else if (input.action === 'status') {
        if (!transitions[ticket.ticket_status]?.includes(input.status))
          throw new AppError('TICKET_STATE_CONFLICT', 409);
        if ((input.status === 'resolved') !== !!input.resolution)
          throw new AppError('TICKET_RESOLUTION_REQUIRED', 400);
        await c.query(
          "UPDATE core.cases SET ticket_status=$2,resolution=coalesce($3::jsonb,resolution),public_resolution=coalesce($4,public_resolution),first_response_at=CASE WHEN $4 IS NOT NULL THEN coalesce(first_response_at,now()) ELSE first_response_at END,resolved_at=CASE WHEN $2 IN ('resolved','closed') THEN coalesce(resolved_at,now()) ELSE NULL END,updated_at=now() WHERE id=$1",
          [
            id,
            input.status,
            input.resolution ? JSON.stringify(input.resolution) : null,
            input.resolution?.publicSummary ?? null,
          ],
        );
        detail = { from: ticket.ticket_status, to: input.status, reason: input.reason };
      } else {
        const scope = [p.organizationId, p.projectId, ticket.tenant_id, ticket.subject];
        if (input.action === 'reply')
          await c.query(
            "INSERT INTO core.case_messages(id,case_id,organization_id,project_id,tenant_id,subject,author_kind,body,request_key,operator_id) VALUES($1,$2,$3,$4,$5,$6,'support',$7,$8,$9)",
            [randomUUID(), id, ...scope, input.body, input.requestKey, actor.account.id],
          );
        else
          await c.query(
            'INSERT INTO core.ticket_notes(id,case_id,organization_id,project_id,tenant_id,subject,body,request_key,operator_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [randomUUID(), id, ...scope, input.body, input.requestKey, actor.account.id],
          );
        await c.query(
          'UPDATE core.cases SET updated_at=now(),first_response_at=CASE WHEN $2 THEN coalesce(first_response_at,now()) ELSE first_response_at END WHERE id=$1',
          [id, input.action === 'reply'],
        );
      }
      await c.query(
        'INSERT INTO core.ticket_events(id,case_id,organization_id,project_id,tenant_id,subject,action,operator_id,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          id,
          p.organizationId,
          p.projectId,
          ticket.tenant_id,
          ticket.subject,
          input.action,
          actor.account.id,
          JSON.stringify(detail),
        ],
      );
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'ticket.' + input.action, id, req.id],
      );
      return { id, version: ticket.ticket_version + 1 };
    });
  });
  app.post(base + '/tickets/:id/knowledge', { bodyLimit: 60000 }, (req) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        title: z.string().trim().min(2).max(200),
        body: z.string().trim().min(10).max(12000),
      })
      .strict()
      .parse(req.body);
    if (containsSecret(input.title + '\n' + input.body)) throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.edit', async (c, p, actor) => {
      const ticket = (
        await c.query('SELECT * FROM core.cases WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
          params(req).id,
        ])
      ).rows[0];
      if (!ticket) throw new AppError('NOT_FOUND', 404);
      if (ticket.ticket_version !== input.version) throw new AppError('TICKET_VERSION_CONFLICT', 409);
      if (!['resolved', 'closed'].includes(ticket.ticket_status) || !ticket.resolution)
        throw new AppError('TICKET_RESOLUTION_REQUIRED', 409);
      const previous = (
        await c.query(
          'SELECT id,title,body FROM knowledge.documents WHERE origin_case_id=$1 AND origin_case_version=$2',
          [ticket.id, input.version],
        )
      ).rows[0];
      if (previous) {
        if (previous.title !== input.title || previous.body !== input.body)
          throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return { id: previous.id, replayed: true };
      }
      const id = randomUUID(),
        snapshot = { ...input, category: 'troubleshooting', audience: 'internal' };
      await c.query(
        "INSERT INTO knowledge.documents(id,organization_id,project_id,title,body,category,audience,updated_by,origin_case_id,origin_case_version) VALUES($1,$2,$3,$4,$5,'troubleshooting','internal',$6,$7,$8)",
        [
          id,
          p.organizationId,
          p.projectId,
          input.title,
          input.body,
          actor.account.id,
          ticket.id,
          input.version,
        ],
      );
      await c.query(
        "INSERT INTO knowledge.document_history(id,document_id,organization_id,project_id,version,action,snapshot,actor_id) VALUES($1,$2,$3,$4,1,'created',$5,$6)",
        [randomUUID(), id, p.organizationId, p.projectId, JSON.stringify(snapshot), actor.account.id],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'ticket.knowledge_draft',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id, replayed: false };
    });
  });
  app.get(base + '/tickets/:id/investigation', (req) =>
    run(req, 'operations.read', async (c) => {
      const { id } = params(req),
        ticket = (await c.query('SELECT id FROM core.cases WHERE id=$1 AND deleted_at IS NULL', [id]))
          .rows[0];
      if (!ticket) throw new AppError('NOT_FOUND', 404);
      return {
        runs: (
          await c.query(
            'SELECT id,state,outcome,tool_id,tool_version,created_at,completed_at FROM core.runs WHERE case_id=$1 ORDER BY created_at DESC LIMIT 100',
            [id],
          )
        ).rows,
        evidence: (
          await c.query(
            'SELECT id,payload,created_at FROM core.evidence WHERE case_id=$1 ORDER BY created_at DESC LIMIT 100',
            [id],
          )
        ).rows,
        reports: (
          await c.query(
            'SELECT r.job_id,r.payload,r.created_at FROM core.observation_reports r JOIN control.observation_jobs j ON j.id=r.job_id WHERE j.case_id=$1 ORDER BY r.created_at DESC LIMIT 20',
            [id],
          )
        ).rows,
        capture:
          (await c.query('SELECT payload FROM core.case_captures WHERE case_id=$1', [id])).rows[0]?.payload ??
          null,
      };
    }),
  );
  return run;
}
