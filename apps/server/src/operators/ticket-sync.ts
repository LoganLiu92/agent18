import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent18/domain';
import { ticketSyncHash } from '../../../../packages/application/src/ticket-sync.js';
import type { SupportOperation } from './support.js';
export function registerTicketSync(app: FastifyInstance, run: SupportOperation) {
  const base = '/operator/projects/:key/tickets/:id/external';
  app.get(base, (req) =>
    run(req, 'ticket.read', async (c, p) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const ticket = (
        await c.query('SELECT tenant_id FROM core.cases WHERE id=$1 AND deleted_at IS NULL', [id])
      ).rows[0];
      if (!ticket) throw new AppError('NOT_FOUND', 404);
      return {
        configured: !!p.ticketSync?.enabled && p.ticketSync.tenantIds.includes(ticket.tenant_id),
        link:
          (
            await c.query(
              'SELECT enabled,external_id,external_status,external_version,updated_at FROM control.external_ticket_links WHERE case_id=$1',
              [id],
            )
          ).rows[0] ?? null,
        jobs: (
          await c.query(
            'SELECT id,case_version,state,attempts,reason,created_at FROM control.ticket_outbox WHERE case_id=$1 ORDER BY case_version DESC LIMIT 50',
            [id],
          )
        ).rows,
      };
    }),
  );
  app.post(base, (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      input = z
        .object({ action: z.enum(['connect', 'disconnect', 'retry']), version: z.number().int().positive() })
        .strict()
        .parse(req.body);
    return run(req, 'ticket.edit', async (c, p, actor) => {
      const ticket = (
        await c.query('SELECT * FROM core.cases WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
      ).rows[0];
      if (!ticket) throw new AppError('NOT_FOUND', 404);
      if (ticket.ticket_version !== input.version) throw new AppError('TICKET_VERSION_CONFLICT', 409);
      if (input.action === 'disconnect') {
        await c.query(
          'UPDATE control.external_ticket_links SET enabled=false,updated_at=now() WHERE case_id=$1',
          [id],
        );
        await c.query(
          "UPDATE control.ticket_outbox SET state='cancelled',reason='LINK_DISCONNECTED' WHERE case_id=$1 AND state IN ('pending','running','failed')",
          [id],
        );
      } else {
        if (!p.ticketSync?.enabled || !p.ticketSync.tenantIds.includes(ticket.tenant_id))
          throw new AppError('SYNC_NOT_CONFIGURED', 409);
        const hash = ticketSyncHash(p.ticketSync);
        const link = (
          await c.query('SELECT * FROM control.external_ticket_links WHERE case_id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (link && link.config_hash !== hash) {
          if (link.enabled) throw new AppError('SYNC_REFERENCE_REVIEW_REQUIRED', 409);
          await c.query(
            'UPDATE control.external_ticket_links SET config_hash=$2,external_id=NULL,external_status=NULL,external_version=0 WHERE case_id=$1',
            [id, hash],
          );
        }
        if (!link)
          await c.query(
            'INSERT INTO control.external_ticket_links(case_id,organization_id,project_id,tenant_id,operator_id,config_hash) VALUES($1,$2,$3,$4,$5,$6)',
            [id, p.organizationId, p.projectId, ticket.tenant_id, actor.account.id, hash],
          );
        else
          await c.query(
            'UPDATE control.external_ticket_links SET enabled=true,operator_id=$2,updated_at=now() WHERE case_id=$1',
            [id, actor.account.id],
          );
        if (input.action === 'retry')
          await c.query(
            "UPDATE control.ticket_outbox SET state='pending',attempts=0,next_attempt=now(),reason=NULL WHERE id=(SELECT id FROM control.ticket_outbox WHERE case_id=$1 AND state='failed' ORDER BY case_version LIMIT 1)",
            [id],
          );
        // A metadata-only snapshot enters the same transactional outbox as subsequent updates.
        await c.query('UPDATE core.cases SET updated_at=now() WHERE id=$1', [id]);
      }
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'ticket.sync.' + input.action, id, req.id],
      );
      return { updated: true };
    });
  });
}
