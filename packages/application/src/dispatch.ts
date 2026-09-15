import { createHash, randomBytes } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import type { Scope } from '@agent18/contracts';
import { AppError } from '@agent18/domain';
import type { Database } from '@agent18/persistence';
export const leaseHash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Dispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  readonly boss: PgBoss;
  constructor(
    private readonly db: Database,
    queueDatabaseUrl: string,
    private readonly reconcileRun?: (scope: Scope, runId: string, reason: string | null) => Promise<boolean>,
  ) {
    this.boss = new PgBoss({
      connectionString: queueDatabaseUrl,
      schema: 'pgboss',
      migrate: false,
      supervise: false,
      schedule: false,
    });
    this.boss.on('error', () => console.error('agent18 queue connection error'));
  }
  async start() {
    await this.boss.start();
    await this.flush();
    this.timer = setInterval(() => {
      void this.tick().catch(() => console.error('agent18 outbox delivery deferred'));
    }, 1000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.boss.stop();
  }
  private reconciling = false;
  private async tick() {
    await this.flush();
    await this.reconcile();
  }
  async reconcile() {
    if (!this.reconcileRun || this.reconciling) return;
    this.reconciling = true;
    try {
      const rows = (
        await this.db.query(
          'SELECT * FROM control.dispatch WHERE settled_at IS NULL AND delivered_at IS NOT NULL AND next_check_at<=now() ORDER BY next_check_at LIMIT 25',
        )
      ).rows;
      for (const row of rows) {
        const [job] = await this.boss.findJobs('support-investigation', { id: row.job_id });
        const reason =
          job?.state === 'failed'
            ? 'QUEUE_RETRIES_EXHAUSTED'
            : job?.state === 'cancelled'
              ? 'QUEUE_CANCELLED'
              : job?.state === 'completed'
                ? 'QUEUE_COMPLETED_WITHOUT_RESULT'
                : !job && Date.now() - row.delivered_at.getTime() > 300000
                  ? 'QUEUE_JOB_MISSING'
                  : null;
        const settled = await this.reconcileRun(
          {
            organizationId: row.organization_id,
            projectId: row.project_id,
            tenantId: row.tenant_id,
            subject: row.subject,
          },
          row.run_id,
          reason,
        );
        await this.db.query(
          "UPDATE control.dispatch SET next_check_at=now()+interval '5 seconds',settled_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1",
          [row.id, settled],
        );
      }
    } finally {
      this.reconciling = false;
    }
  }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    let client;
    try {
      client = await this.db.connect();
      await client.query('BEGIN');
      const records = (
        await client.query(
          'SELECT id FROM control.dispatch WHERE delivered_at IS NULL ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED',
        )
      ).rows;
      for (const record of records) {
        // Stable job ID makes a crash between send and outbox commit safe. The consumer is independently idempotent.
        await this.boss.send('support-investigation', { dispatchId: record.id }, { id: record.id });
        await client.query('UPDATE control.dispatch SET job_id=id,delivered_at=now() WHERE id=$1', [
          record.id,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      throw error;
    } finally {
      client?.release();
      this.busy = false;
    }
  }
  async claim(dispatchId: string, jobId: string) {
    const lease = randomBytes(32).toString('hex');
    const result = await this.db.query(
      "UPDATE control.dispatch SET lease_hash=$3,lease_expires_at=now()+interval '60 seconds' WHERE id=$1 AND job_id=$2 AND (lease_expires_at IS NULL OR lease_expires_at < now()) RETURNING run_id",
      [dispatchId, jobId, leaseHash(lease)],
    );
    if (!result.rowCount) throw new AppError('LEASE_UNAVAILABLE', 409);
    return { runId: result.rows[0].run_id, lease };
  }
  async resolve(runId: string, lease: string): Promise<Scope> {
    const row = (
      await this.db.query(
        'SELECT organization_id,project_id,tenant_id,subject FROM control.dispatch WHERE run_id=$1 AND lease_hash=$2 AND lease_expires_at>now()',
        [runId, leaseHash(lease)],
      )
    ).rows[0];
    if (!row) throw new AppError('INVALID_RUN_LEASE', 403);
    return {
      organizationId: row.organization_id,
      projectId: row.project_id,
      tenantId: row.tenant_id,
      subject: row.subject,
    };
  }
  async release(runId: string, lease: string) {
    await this.db.query(
      'UPDATE control.dispatch SET lease_hash=NULL,lease_expires_at=NULL WHERE run_id=$1 AND lease_hash=$2',
      [runId, leaseHash(lease)],
    );
  }
}
