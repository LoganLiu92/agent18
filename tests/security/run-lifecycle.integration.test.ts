import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { SignJWT, importJWK } from 'jose';
import { AppError, type CustomerPrincipal } from '@agent18/domain';
import { scoped } from '@agent18/persistence';
import { RunService, ToolGateway, Dispatcher } from '@agent18/application';
import { OpaPolicy } from '@agent18/policy';
import { FixtureKnowledgeProvider } from '@agent18/knowledge-basic';
import { buildApp } from '../../apps/server/src/app.js';
import { readConfig, localDirectory } from '../../scripts/config.js';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')(
  'durable Run lifecycle with real PostgreSQL and OPA',
  () => {
    const exec = promisify(execFile);
    const compose = (...args: string[]) =>
      exec('docker', [
        'compose',
        '--env-file',
        '.local/compose.env',
        '-f',
        'deploy/compose/compose.yaml',
        ...args,
      ]);
    let app: Awaited<ReturnType<typeof buildApp>>,
      admin: pg.Pool,
      identity: CustomerPrincipal,
      headers: Record<string, string>;
    let config: ReturnType<typeof readConfig>;
    const body = {
      title: '发票失败 · lifecycle fixture',
      description: 'Synthetic Run lifecycle regression',
      context: {},
    };
    async function report() {
      const result = await app.cases.report(identity, body, crypto.randomUUID(), crypto.randomUUID());
      const detail = await app.cases.detail(identity, result.case.id);
      return { caseId: result.case.id, runId: detail.runs[0]!.id };
    }
    async function detail(caseId: string) {
      return app.cases.detail(identity, caseId);
    }
    function gate(provider: FixtureKnowledgeProvider) {
      return new ToolGateway(app.db, new OpaPolicy(config.opaUrl), provider);
    }
    beforeAll(async () => {
      // Pause only agent18's demo worker so test runs can stop at deliberate race boundaries.
      await compose('stop', 'worker');
      config = readConfig();
      const migration = JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'));
      admin = new pg.Pool({ connectionString: migration.adminDatabaseUrl });
      app = await buildApp(config, { dispatch: false });
      identity = {
        organizationId: config.projects[0]!.organizationId,
        projectId: config.projects[0]!.projectId,
        tenantId: 'tenant-a',
        subject: `lifecycle-${crypto.randomUUID()}`,
        kind: 'customer',
        roles: [],
        expiresAt: Date.now() + 300000,
      };
      const issuer = JSON.parse(await readFile(resolve(localDirectory, 'identity.json'), 'utf8'));
      const token = await new SignJWT({
        kind: 'customer',
        tenant_id: identity.tenantId,
        project_key: 'invoice-demo',
        roles: [],
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: issuer.publicJwk.kid })
        .setIssuer('urn:agent18:demo-saas')
        .setAudience('agent18:support')
        .setSubject(identity.subject)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(await importJWK(issuer.privateJwk, 'EdDSA'));
      headers = { authorization: `Bearer ${token}`, 'x-project-key': 'invoice-demo' };
    });
    afterAll(async () => {
      if (app && admin) {
        const rows = (
          await admin.query(
            "SELECT id,case_id FROM core.runs WHERE subject=$1 AND state IN ('pending','running')",
            [identity.subject],
          )
        ).rows;
        for (const row of rows) await app.cases.runs.cancel(identity, row.id, 'fixture-cleanup');
        const jobs = (
          await admin.query('SELECT job_id FROM control.dispatch WHERE subject=$1 AND job_id IS NOT NULL', [
            identity.subject,
          ])
        ).rows;
        await app.dispatcher.boss.start();
        if (jobs.length)
          await app.dispatcher.boss.cancel(
            'support-investigation',
            jobs.map((job) => job.job_id),
          );
        await app.dispatcher.boss.stop();
      }
      await app?.app.close();
      await admin?.end();
      await compose('start', 'worker');
    });
    it('cancels a pending Run idempotently, revokes its capability and never calls the provider', async () => {
      const { caseId, runId } = await report();
      const provider = new FixtureKnowledgeProvider(),
        spy = vi.spyOn(provider, 'search');
      const runs = new RunService(app.db, gate(provider));
      expect(
        (await app.app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, headers, payload: {} }))
          .statusCode,
      ).toBe(200);
      expect((await runs.cancel(identity, runId, 'cancel-again')).replayed).toBe(true);
      expect(await runs.execute(identity, runId, 'cancelled-execution')).toEqual({ state: 'cancelled' });
      expect(spy).not.toHaveBeenCalled();
      const result = await detail(caseId);
      expect(result.runs[0]?.state).toBe('cancelled');
      expect(result.runs[0]?.steps).toHaveLength(1);
      expect(result.evidence).toHaveLength(0);
      expect(
        (await admin.query('SELECT scope_revision FROM core.runs WHERE id=$1', [runId])).rows[0]
          .scope_revision,
      ).toBe(2);
    });
    it('commits cancellation during a provider call and discards its late result across Server instances', async () => {
      const { caseId, runId } = await report();
      const started = latch(),
        release = latch();
      const provider = new FixtureKnowledgeProvider(),
        original = provider.search.bind(provider);
      vi.spyOn(provider, 'search').mockImplementation(async (input, context) => {
        started.resolve();
        await release.promise;
        return original(input, context);
      });
      const executing = new RunService(app.db, gate(provider));
      const pending = executing.execute(identity, runId, 'late-result');
      await started.promise;
      await app.cases.runs.cancel(identity, runId, 'other-server-cancel');
      release.resolve();
      expect(await pending).toEqual({ state: 'cancelled' });
      expect((await detail(caseId)).evidence).toHaveLength(0);
      expect((await detail(caseId)).runs[0]?.state).toBe('cancelled');
    });
    it('signals cancellation to an active provider in this Server instance', async () => {
      const { runId } = await report();
      const started = latch();
      const provider = new FixtureKnowledgeProvider();
      let aborted = false;
      vi.spyOn(provider, 'search').mockImplementation(async (_input, context) => {
        started.resolve();
        return new Promise((_resolve, reject) =>
          context.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(context.signal.reason);
            },
            { once: true },
          ),
        );
      });
      const runs = new RunService(app.db, gate(provider));
      const result = runs.execute(identity, runId, 'cooperative-cancel');
      await started.promise;
      await runs.cancel(identity, runId, 'customer-cancel');
      expect(await result).toEqual({ state: 'cancelled' });
      expect(aborted).toBe(true);
    });
    it('will not overwrite a completed Run with a late cancel', async () => {
      const { caseId, runId } = await report();
      await app.cases.execute(identity, runId, 'completed-before-cancel');
      await expect(app.cases.runs.cancel(identity, runId, 'late-cancel')).rejects.toMatchObject({
        code: 'RUN_ALREADY_TERMINAL',
      });
      expect((await detail(caseId)).runs[0]?.state).toBe('completed');
      expect((await detail(caseId)).runs[0]?.steps.map((step) => `${step.name}:${step.state}`)).toEqual([
        'execution:started',
        'knowledge.search:started',
        'knowledge.search:succeeded',
        'execution:succeeded',
      ]);
    });
    it('records bounded attempts and reaches failed when the application retry budget is exhausted', async () => {
      const { caseId, runId } = await report();
      const gateway = app.gateway;
      const spy = vi.spyOn(gateway, 'invoke').mockRejectedValue(new AppError('POLICY_UNAVAILABLE', 503));
      try {
        for (let i = 0; i < 2; i++)
          await expect(app.cases.execute(identity, runId, `attempt-${i}`)).rejects.toMatchObject({
            status: 503,
          });
        expect(await app.cases.execute(identity, runId, 'attempt-3')).toEqual({ state: 'failed' });
        await app.cases.execute(identity, runId, 'duplicate-terminal');
        const run = (await detail(caseId)).runs[0]!;
        expect(run.attemptCount).toBe(3);
        expect(run.outcome).toBe('ATTEMPT_BUDGET_EXHAUSTED');
        expect(run.canRetry).toBe(true);
        expect(
          run.steps.filter((step) => step.name === 'execution' && step.state === 'started'),
        ).toHaveLength(3);
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
    });
    it('bounds a provider that ignores cancellation and does not publish its late response', async () => {
      const { caseId, runId } = await report();
      await admin.query('UPDATE core.runs SET execution_budget_ms=100,max_attempts=1 WHERE id=$1', [runId]);
      const release = latch();
      const provider = new FixtureKnowledgeProvider(),
        original = provider.search.bind(provider);
      vi.spyOn(provider, 'search').mockImplementation(async (input, context) => {
        await release.promise;
        return original(input, context);
      });
      const runs = new RunService(app.db, gate(provider));
      try {
        expect(await runs.execute(identity, runId, 'timeout')).toEqual({ state: 'failed' });
      } finally {
        release.resolve();
      }
      const result = await detail(caseId);
      expect(result.evidence).toHaveLength(0);
      expect(result.runs[0]?.steps.some((step) => step.reason === 'STEP_TIMEOUT')).toBe(true);
    });
    it('creates one child Run for concurrent manual retries and preserves the old history', async () => {
      const { caseId, runId } = await report();
      await app.cases.runs.cancel(identity, runId, 'cancel-for-retry');
      const key = crypto.randomUUID();
      const replies = await Promise.all(
        Array.from({ length: 4 }, () =>
          app.app.inject({
            method: 'POST',
            url: `/api/runs/${runId}/retry`,
            headers: { ...headers, 'idempotency-key': key },
            payload: {},
          }),
        ),
      );
      expect(replies.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(replies.filter((r) => r.statusCode === 200)).toHaveLength(3);
      const result = await detail(caseId);
      expect(result.runs).toHaveLength(2);
      expect(result.runs[0]?.state).toBe('cancelled');
      expect(result.runs[1]?.retryOf).toBe(runId);
      expect(result.runs[1]?.state).toBe('pending');
      expect(new Set(replies.map((r) => r.json().runId)).size).toBe(1);
    });
    it('enforces the per-Case manual retry budget', async () => {
      const { caseId, runId } = await report();
      let current = runId;
      for (let i = 0; i < 2; i++) {
        await app.cases.runs.cancel(identity, current, `cancel-${i}`);
        current = (await app.cases.runs.retry(identity, current, crypto.randomUUID(), `retry-${i}`)).runId;
      }
      await app.cases.runs.cancel(identity, current, 'cancel-final');
      await expect(
        app.cases.runs.retry(identity, current, crypto.randomUUID(), 'beyond-budget'),
      ).rejects.toMatchObject({ code: 'CASE_RUN_BUDGET_EXHAUSTED' });
      expect((await detail(caseId)).runs).toHaveLength(3);
      expect((await detail(caseId)).runs.every((run) => !run.canRetry)).toBe(true);
    });
    it('rejects a retry key reused against another parent Run', async () => {
      const a = await report(),
        b = await report();
      const key = crypto.randomUUID();
      await app.cases.runs.cancel(identity, a.runId, 'cancel-a');
      await app.cases.runs.cancel(identity, b.runId, 'cancel-b');
      await app.cases.runs.retry(identity, a.runId, key, 'retry-a');
      await expect(app.cases.runs.retry(identity, b.runId, key, 'retry-b')).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
    });
    it('will not use manual retry to reopen a policy-blocked Run', async () => {
      const { runId } = await report();
      await admin.query("UPDATE core.runs SET capability_expires_at=now()-interval '1 second' WHERE id=$1", [
        runId,
      ]);
      expect(await app.cases.execute(identity, runId, 'expired')).toEqual({ state: 'blocked' });
      await expect(
        app.cases.runs.retry(identity, runId, crypto.randomUUID(), 'policy-bypass'),
      ).rejects.toMatchObject({ code: 'RUN_NOT_RETRYABLE' });
    });
    it.each(['tenantId', 'subject', 'projectId'] as const)(
      'isolates Run control and steps across %s',
      async (field) => {
        const { caseId, runId } = await report();
        const other = {
          ...identity,
          [field]:
            field === 'projectId'
              ? config.projects[1]!.projectId
              : field === 'tenantId'
                ? 'tenant-b'
                : 'other-subject',
        };
        await expect(app.cases.runs.cancel(other, runId, 'cross-scope')).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        await expect(
          app.cases.runs.retry(other, runId, crypto.randomUUID(), 'cross-scope-retry'),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await scoped(app.db, other, async (client) =>
          expect(
            (await client.query('SELECT id FROM core.run_steps WHERE case_id=$1', [caseId])).rowCount,
          ).toBe(0),
        );
      },
    );
    it('makes step history append-only for App and inaccessible to Worker', async () => {
      await expect(app.db.query('DELETE FROM core.run_steps')).rejects.toMatchObject({ code: '42501' });
      const queue = new pg.Pool({ connectionString: config.queueDatabaseUrl });
      try {
        await expect(queue.query('SELECT * FROM core.run_steps')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await queue.end();
      }
    });
    it('reconciles a broker failure into a terminal business Run using the real queue state', async () => {
      const { caseId, runId } = await report();
      const dispatcher = new Dispatcher(app.db, config.queueDatabaseUrl, (scope, id, reason) =>
        app.cases.runs.reconcile(scope, id, reason),
      );
      try {
        await dispatcher.boss.start();
        await dispatcher.flush();
        const row = (await admin.query('SELECT job_id FROM control.dispatch WHERE run_id=$1', [runId]))
          .rows[0];
        // Inject a terminal broker outcome for this synthetic job only; polling still uses pg-boss findJobs.
        await admin.query(
          "UPDATE pgboss.job SET state='failed',completed_on=now() WHERE name='support-investigation' AND id=$1",
          [row.job_id],
        );
        for (let i = 0; i < 20; i++) {
          await dispatcher.reconcile();
          if ((await detail(caseId)).runs[0]?.state === 'failed') break;
        }
        const result = (await detail(caseId)).runs[0]!;
        expect(result.state).toBe('failed');
        expect(result.outcome).toBe('QUEUE_RETRIES_EXHAUSTED');
        expect(
          (await admin.query('SELECT settled_at FROM control.dispatch WHERE run_id=$1', [runId])).rows[0]
            .settled_at,
        ).not.toBeNull();
      } finally {
        await dispatcher.boss.stop();
      }
    });
    it('does not reconcile a Run while its executor owns the advisory lock', async () => {
      const { runId } = await report();
      const started = latch(),
        release = latch();
      const provider = new FixtureKnowledgeProvider(),
        original = provider.search.bind(provider);
      vi.spyOn(provider, 'search').mockImplementation(async (input, context) => {
        started.resolve();
        await release.promise;
        return original(input, context);
      });
      const pending = new RunService(app.db, gate(provider)).execute(identity, runId, 'locked-run');
      await started.promise;
      expect(await app.cases.runs.reconcile(identity, runId, 'QUEUE_RETRIES_EXHAUSTED')).toBe(false);
      release.resolve();
      expect(await pending).toEqual({ state: 'completed' });
    });
  },
);
