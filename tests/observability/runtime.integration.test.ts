import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, scoped } from '@agent18/persistence';
import { buildApp } from '../../apps/server/src/app.js';
import { readConfig, localDirectory } from '../../scripts/config.js';
import { operationsConfigSchema } from '@agent18/observability/config';
import { enqueueObservation, ObservationRuntime } from '@agent18/application';
import { configurationHash } from '@agent18/observability';
import type { Scope, PageCapture } from '@agent18/contracts';

describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')(
  'durable observations with PostgreSQL and OPA',
  () => {
    let app: Awaited<ReturnType<typeof buildApp>>,
      admin: InstanceType<typeof Pool>,
      config: ReturnType<typeof readConfig>;
    const scope: Scope = {
      organizationId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      tenantId: 'observation-tenant',
      subject: 'alice',
    };
    let healthy = false,
      caseId: string;
    const server = createServer((_req, res) => {
      res.writeHead(healthy ? 200 : 503);
      res.end();
    });
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const original = readConfig();
      admin = new Pool({
        connectionString: JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'))
          .adminDatabaseUrl,
      });
      await admin.query('INSERT INTO core.organizations VALUES($1,$2)', [
        scope.organizationId,
        'Observation test',
      ]);
      await admin.query('INSERT INTO core.projects VALUES($1,$2,$3,$4)', [
        scope.organizationId,
        scope.projectId,
        'observe-' + scope.projectId.slice(0, 8),
        'Observation test',
      ]);
      await admin.query('INSERT INTO core.tenants VALUES($1,$2,$3,$4)', [
        scope.organizationId,
        scope.projectId,
        scope.tenantId,
        'Observation tenant',
      ]);
      config = {
        ...original,
        projects: [
          {
            ...original.projects[0]!,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            key: 'observe-' + scope.projectId.slice(0, 8),
            knowledge: 'fixture',
            operations: operationsConfigSchema.parse({
              enabled: true,
              checks: [
                {
                  id: 'api-health',
                  kind: 'http',
                  title: 'API health',
                  url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
                },
              ],
            }),
          },
        ],
      };
      app = await buildApp(config, { dispatch: false });
    });
    afterAll(async () => {
      await app?.app.close();
      await admin?.end();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    });
    async function manual(key = crypto.randomUUID()) {
      return scoped(app.db, { ...scope, tenantId: '__operations__', subject: '__owner__' }, (client) =>
        enqueueObservation(
          client,
          { ...scope, tenantId: '__operations__', subject: '__owner__' },
          config.projects[0]!.operations!,
          'inspection',
          'test:' + key,
        ),
      );
    }
    async function drain() {
      for (let i = 0; i < 20; i++) {
        const result = await app.observations.tick();
        if ('processed' in result && !result.processed) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    it('commits page capture and automatic investigation with the Case, hides both across scope', async () => {
      const capture: PageCapture = {
        capturedAt: new Date().toISOString(),
        page: { title: 'Orders', path: '/orders', language: 'zh-CN', width: 1200, height: 800, online: true },
        text: 'Current order page',
        errors: ['Failed to save'],
        breadcrumbs: [],
        requests: [],
        notice: 'Test capture',
      };
      const input = { title: '订单出现异常', description: '订单保存时报错', context: {}, capture },
        key = crypto.randomUUID();
      const created = await app.cases.report(scope, input, key, 'test');
      caseId = created.case.id;
      expect((await app.cases.report(scope, input, key, 'test')).replayed).toBe(true);
      expect(
        (
          await admin.query('SELECT count(*)::int AS n FROM control.observation_jobs WHERE case_id=$1', [
            caseId,
          ])
        ).rows[0].n,
      ).toBe(1);
      expect((await app.cases.detail(scope, caseId)).capture?.text).toBe(capture.text);
      await expect(app.cases.detail({ ...scope, subject: 'bob' }, caseId)).rejects.toThrow('NOT_FOUND');
      expect(
        await scoped(
          app.db,
          { ...scope, subject: 'bob' },
          async (c) =>
            (await c.query('SELECT * FROM core.case_captures WHERE case_id=$1', [caseId])).rowCount,
        ),
      ).toBe(0);
      await drain();
      const detail = await app.cases.detail(scope, caseId);
      expect(detail.investigation?.state).toBe('completed');
      expect(JSON.stringify(detail.investigation)).not.toContain('HTTP 503');
      expect(detail.evidence.some((e) => e.visibility === 'ENGINEERING')).toBe(false);
    });
    it('runs as a server-owned engineering principal; customers cannot invoke the observation tool', async () => {
      await expect(
        app.gateway.invoke(
          { ...scope, kind: 'customer', roles: [], expiresAt: Date.now() + 60000 },
          'operations.observe',
          {},
          'denied',
        ),
      ).rejects.toThrow('POLICY_DENIED');
      const report = (
        await admin.query(
          'SELECT r.payload FROM core.observation_reports r JOIN control.observation_jobs j ON j.id=r.job_id WHERE j.case_id=$1',
          [caseId],
        )
      ).rows[0].payload;
      expect(report.results[0].state).toBe('alert');
      expect(report.results[0].evidence[0].visibility).toBe('ENGINEERING');
      expect(report.analysis.mode).toBe('rules');
    });
    it('deduplicates repeated inspection signals, keeps unknown failures open, and resolves after a healthy observation', async () => {
      const before = (
        await admin.query(
          'SELECT occurrences FROM control.observation_incidents WHERE organization_id=$1 AND project_id=$2',
          [scope.organizationId, scope.projectId],
        )
      ).rows[0].occurrences;
      const key = crypto.randomUUID();
      const originalJob = await manual(key);
      expect(await manual(key)).toBe(originalJob);
      await drain();
      let incident = (
        await admin.query(
          'SELECT * FROM control.observation_incidents WHERE organization_id=$1 AND project_id=$2',
          [scope.organizationId, scope.projectId],
        )
      ).rows[0];
      expect(incident.occurrences).toBe(before + 1);
      config.projects[0]!.operations!.checks[0]!.credentialEnv = 'AGENT18_OBS_DOES_NOT_EXIST';
      await manual();
      await drain();
      incident = (await admin.query('SELECT * FROM control.observation_incidents WHERE id=$1', [incident.id]))
        .rows[0];
      expect(incident.state).toBe('open');
      delete config.projects[0]!.operations!.checks[0]!.credentialEnv;
      healthy = true;
      await manual();
      await drain();
      expect(
        (await admin.query('SELECT state FROM control.observation_incidents WHERE id=$1', [incident.id]))
          .rows[0].state,
      ).toBe('resolved');
    });
    it('cancels a queued job after configuration changes and reclaims an expired lease after restart', async () => {
      const changed = await manual();
      config.projects[0]!.operations!.intervalSeconds = 600;
      await drain();
      expect(
        (await admin.query('SELECT state FROM control.observation_jobs WHERE id=$1', [changed])).rows[0]
          .state,
      ).toBe('cancelled');
      const recovering = await manual();
      await admin.query(
        "UPDATE control.observation_jobs SET state='running',attempts=1,lease_until=now()-interval '1 minute' WHERE id=$1",
        [recovering],
      );
      await drain();
      expect(
        (await admin.query('SELECT state,attempts FROM control.observation_jobs WHERE id=$1', [recovering]))
          .rows[0],
      ).toMatchObject({ state: 'completed', attempts: 2 });
    });
    it('does not claim or cancel jobs belonging to projects configured on another Core', async () => {
      const foreign = { ...scope, projectId: crypto.randomUUID() },
        id = crypto.randomUUID();
      const client = await admin.connect();
      let job: string | undefined;
      try {
        job = await enqueueObservation(
          client,
          foreign,
          config.projects[0]!.operations!,
          'inspection',
          'foreign:' + id,
        );
      } finally {
        client.release();
      }
      await drain();
      expect(
        (await admin.query('SELECT state,attempts FROM control.observation_jobs WHERE id=$1', [job])).rows[0],
      ).toMatchObject({ state: 'pending', attempts: 0 });
      await admin.query(
        "UPDATE control.observation_jobs SET state='cancelled',reason='TEST_FINISHED' WHERE id=$1",
        [job],
      );
    });
    it('accepts only existing model evidence citations and falls back to rules on hallucinated IDs', async () => {
      config.projects[0]!.operations!.modelAnalysis = true;
      let invalid = false;
      const runtime = new ObservationRuntime(app.db, app.gateway, () => config.projects, {
        complete: async (_system, input) => {
          const data = input as { evidence: { id: string }[]; errors: string[] };
          expect(Object.keys(data).sort()).toEqual(['errors', 'evidence']);
          expect(JSON.stringify(input)).not.toContain('screenshot');
          return {
            value: {
              hypotheses: [
                {
                  text: '需要核对上游依赖状态。',
                  evidenceIds: [invalid ? crypto.randomUUID() : data.evidence[0]!.id],
                },
              ],
              nextSteps: ['人工核对业务回执。'],
            },
          };
        },
      });
      try {
        for (const expected of ['model', 'rules']) {
          const job = await manual();
          for (let i = 0; i < 20; i++) {
            await runtime.tick();
            if ((await admin.query('SELECT 1 FROM core.observation_reports WHERE job_id=$1', [job])).rowCount)
              break;
            await new Promise((r) => setTimeout(r, 25));
          }
          const report = (
            await admin.query('SELECT payload FROM core.observation_reports WHERE job_id=$1', [job])
          ).rows[0].payload;
          expect(report.analysis.mode).toBe(expected);
          invalid = true;
        }
      } finally {
        config.projects[0]!.operations!.modelAnalysis = false;
      }
    });
    it('invokes the versioned Tempo binding through the policy gateway', async () => {
      const previous = config.projects[0]!.operations!;
      config.projects[0]!.operations = operationsConfigSchema.parse({
        enabled: true,
        checks: [
          {
            id: 'tempo',
            kind: 'tempo',
            title: 'Trace',
            url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
            projectAttributes: { 'service.namespace': 'observations' },
            tenantAttribute: 'tenant.id',
          },
        ],
      });
      try {
        const evidence = await app.gateway.invoke(
          {
            ...scope,
            kind: 'operator',
            expiresAt: Date.now() + 60000,
            permissions: ['tool:operations.observe:READ'],
          },
          'operations.observe',
          {
            checkId: 'tempo',
            configHash: configurationHash(config.projects[0]!.operations!),
            mode: 'case',
            observedAt: new Date().toISOString(),
          },
          crypto.randomUUID(),
        );
        expect(evidence[0]).toMatchObject({
          kind: 'trace',
          resource: { namespace: 'unknown' },
          provenance: { toolId: 'operations.observe', toolVersion: 2 },
        });
      } finally {
        config.projects[0]!.operations = previous;
      }
    });
    it('upgrades bundled bindings without undoing revocation or replacing locally reviewed descriptors', async () => {
      const migration = await readFile(
        resolve('packages/persistence/migrations/036_observability_trace_binding.sql'),
        'utf8',
      );
      const client = await admin.connect();
      try {
        for (const custom of [false, true]) {
          await client.query('BEGIN');
          await client.query(
            "UPDATE control.providers SET version='1.0.0',review='revoked',reviewed_by='migration-009' WHERE id='observability'",
          );
          await client.query(
            `UPDATE control.tools SET version=1,resource_types='["log","metric","health"]'::jsonb,
            review='revoked',reviewed_by=$1 WHERE id='operations.observe'`,
            [custom ? 'local-owner-review' : 'migration-009'],
          );
          await client.query(migration);
          expect(
            (await client.query("SELECT version,review FROM control.tools WHERE id='operations.observe'"))
              .rows[0],
          ).toEqual({ version: custom ? 1 : 2, review: 'revoked' });
          expect(
            (await client.query("SELECT version,review FROM control.providers WHERE id='observability'"))
              .rows[0],
          ).toEqual({ version: custom ? '1.0.0' : '1.1.0', review: 'revoked' });
          await client.query('ROLLBACK');
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
    it('persists a failed result when the registered tool is revoked and does not publish evidence', async () => {
      const job = await manual();
      try {
        await admin.query("UPDATE control.tools SET review='revoked' WHERE id='operations.observe'");
        await drain();
        expect(
          (await admin.query('SELECT state FROM control.observation_jobs WHERE id=$1', [job])).rows[0].state,
        ).toBe('failed');
        expect(
          (await admin.query('SELECT 1 FROM core.observation_reports WHERE job_id=$1', [job])).rowCount,
        ).toBe(0);
      } finally {
        await admin.query("UPDATE control.tools SET review='approved' WHERE id='operations.observe'");
      }
    });
  },
);
