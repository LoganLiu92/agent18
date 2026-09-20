import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '@agent18/provider-contracts';
import { AppError } from '@agent18/domain';
import { externalTicketEventSchema, type TicketSyncConfig } from '@agent18/contracts';
import type { Database } from '@agent18/persistence';
export const ticketSyncHash = (config: TicketSyncConfig) =>
  createHash('sha256').update(canonical(config)).digest('hex');
export const syncSignature = (secret: string, timestamp: string, id: string, payload: unknown) =>
  createHmac('sha256', secret)
    .update(timestamp + '.' + id + '.' + canonical(payload))
    .digest('hex');
export function verifySyncSignature(
  secret: string,
  timestamp: string,
  id: string,
  payload: unknown,
  signature: string,
  now = Date.now(),
) {
  if (
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    throw new AppError('SYNC_SIGNATURE_INVALID', 401);
  const expected = Buffer.from(syncSignature(secret, timestamp, id, payload), 'hex'),
    actual = Buffer.from(signature, 'hex');
  if (!timingSafeEqual(expected, actual)) throw new AppError('SYNC_SIGNATURE_INVALID', 401);
}
type Project = { organizationId: string; projectId: string; ticketSync?: TicketSyncConfig };
export class TicketSyncRuntime {
  constructor(
    private db: Database,
    private projects: Project[],
    private environment: Record<string, string | undefined> = process.env,
    private request: typeof fetch = fetch,
  ) {}
  private binding(org: string, project: string, tenant: string, hash?: string) {
    const p = this.projects.find((p) => p.organizationId === org && p.projectId === project),
      config = p?.ticketSync;
    if (!config?.enabled || !config.tenantIds.includes(tenant) || (hash && ticketSyncHash(config) !== hash))
      throw new AppError('SYNC_CONFIG_CHANGED', 403);
    const secret = this.environment[config.credentialEnv];
    if (!secret || secret.length < 32) throw new AppError('SYNC_CREDENTIAL_MISSING', 503);
    return { config, secret };
  }
  async tick() {
    const c = await this.db.connect(),
      lease = randomUUID();
    let job: Record<string, any> | undefined;
    try {
      await c.query('BEGIN');
      await c.query(
        "UPDATE control.ticket_outbox SET state='failed',reason='ATTEMPTS_EXHAUSTED' WHERE state='running' AND lease_until<now() AND attempts>=5",
      );
      job = (
        await c.query(
          "UPDATE control.ticket_outbox SET state='running',lease_id=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id=(SELECT o.id FROM control.ticket_outbox o WHERE ((state='pending' AND next_attempt<=now()) OR (state='running' AND lease_until<now() AND attempts<5)) AND NOT EXISTS(SELECT 1 FROM control.ticket_outbox older WHERE older.case_id=o.case_id AND older.case_version<o.case_version AND older.state IN ('pending','running','failed')) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *",
          [lease],
        )
      ).rows[0];
      await c.query('COMMIT');
      if (!job) return { processed: false };
      const { config, secret } = this.binding(
        job.organization_id,
        job.project_id,
        job.tenant_id,
        job.config_hash,
      );
      const link = (
        await c.query(
          'SELECT l.*,control.report_actor_allowed(operator_id,organization_id,project_id,false,ARRAY[tenant_id]) AS allowed FROM control.external_ticket_links l WHERE case_id=$1',
          [job.case_id],
        )
      ).rows[0];
      if (!link?.enabled || !link.allowed) throw new AppError('SYNC_PERMISSION_REVOKED', 403);
      const payload = {
          ...job.payload,
          eventId: job.id,
          organizationId: job.organization_id,
          projectId: job.project_id,
          tenantId: job.tenant_id,
        },
        timestamp = String(Math.floor(Date.now() / 1000));
      const response = await this.request(config.url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-agent18-event': job.id,
          'x-agent18-timestamp': timestamp,
          'x-agent18-signature': syncSignature(secret, timestamp, job.id, payload),
        },
        body: canonical(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError('SYNC_UPSTREAM_FAILED', 502);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AppError('SYNC_RESPONSE_INVALID', 502);
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) {
          await reader.cancel();
          throw new AppError('SYNC_RESPONSE_INVALID', 502);
        }
        chunks.push(value);
      }
      const receipt = z
        .object({ eventId: z.literal(job.id), externalId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
        .strict()
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      await c.query('BEGIN');
      const active = (
        await c.query(
          "SELECT id FROM control.ticket_outbox WHERE id=$1 AND state='running' AND lease_id=$2 AND lease_until>now() FOR UPDATE",
          [job.id, lease],
        )
      ).rowCount;
      if (!active) throw new AppError('SYNC_LEASE_LOST', 409);
      const latest = (
        await c.query('SELECT external_id FROM control.external_ticket_links WHERE case_id=$1 FOR UPDATE', [
          job.case_id,
        ])
      ).rows[0];
      if (latest.external_id && latest.external_id !== receipt.externalId)
        throw new AppError('SYNC_REFERENCE_CHANGED', 409);
      await c.query(
        'UPDATE control.external_ticket_links SET external_id=$2,updated_at=now() WHERE case_id=$1',
        [job.case_id, receipt.externalId],
      );
      await c.query(
        "UPDATE control.ticket_outbox SET state='delivered',reason='ACKNOWLEDGED',lease_until=NULL,completed_at=now() WHERE id=$1",
        [job.id],
      );
      await c.query('COMMIT');
      return { processed: true, id: job.id, state: 'delivered' };
    } catch (e) {
      await c.query('ROLLBACK');
      if (!job) throw e;
      const reason = e instanceof AppError ? e.code : 'SYNC_FAILED',
        state = ['SYNC_CONFIG_CHANGED', 'SYNC_PERMISSION_REVOKED'].includes(reason)
          ? 'cancelled'
          : job.attempts >= 5
            ? 'failed'
            : 'pending';
      await c.query(
        "UPDATE control.ticket_outbox SET state=$3,reason=$4,lease_until=NULL,next_attempt=now()+($5::int*interval '30 seconds') WHERE id=$1 AND lease_id=$2 AND state='running'",
        [job.id, lease, state, reason, 2 ** job.attempts],
      );
      return { processed: true, id: job.id, state, reason };
    } finally {
      c.release();
    }
  }
  async receive(raw: unknown, headers: { timestamp: string; signature: string; eventId: string }) {
    const input = externalTicketEventSchema.parse(raw),
      { config, secret } = this.binding(input.organizationId, input.projectId, input.tenantId);
    if (headers.eventId !== input.eventId) throw new AppError('SYNC_SIGNATURE_INVALID', 401);
    verifySyncSignature(secret, headers.timestamp, input.eventId, input, headers.signature);
    const c = await this.db.connect(),
      hash = createHash('sha256').update(canonical(input)).digest('hex');
    try {
      await c.query('BEGIN');
      const link = (
        await c.query(
          'SELECT l.*,control.report_actor_allowed(operator_id,organization_id,project_id,false,ARRAY[tenant_id]) AS allowed FROM control.external_ticket_links l WHERE case_id=$1 AND organization_id=$2 AND project_id=$3 AND tenant_id=$4 FOR UPDATE',
          [input.ticketId, input.organizationId, input.projectId, input.tenantId],
        )
      ).rows[0];
      if (
        !link?.enabled ||
        !link.allowed ||
        link.external_id !== input.externalId ||
        link.config_hash !== ticketSyncHash(config)
      )
        throw new AppError('SYNC_LINK_NOT_FOUND', 404);
      const existing = (
        await c.query('SELECT payload_hash,outcome FROM control.ticket_inbox WHERE id=$1', [input.eventId])
      ).rows[0];
      if (existing) {
        if (existing.payload_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        await c.query('COMMIT');
        return { outcome: existing.outcome, replayed: true };
      }
      const outcome =
        input.origin === 'agent18'
          ? 'echo_ignored'
          : input.version <= link.external_version
            ? 'stale_ignored'
            : 'applied';
      if (outcome === 'applied')
        await c.query(
          'UPDATE control.external_ticket_links SET external_version=$2,external_status=$3,updated_at=now() WHERE case_id=$1',
          [input.ticketId, input.version, input.status],
        );
      await c.query(
        'INSERT INTO control.ticket_inbox(id,case_id,payload_hash,version,outcome) VALUES($1,$2,$3,$4,$5)',
        [input.eventId, input.ticketId, hash, input.version, outcome],
      );
      await c.query('COMMIT');
      return { outcome, replayed: false };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
