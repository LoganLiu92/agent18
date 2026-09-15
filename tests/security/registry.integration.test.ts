import { buildApp } from '../../apps/server/src/app.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Pool, scoped } from '@agent18/persistence';
import { CaseService, ToolGateway } from '@agent18/application';
import { OpaPolicy } from '@agent18/policy';
import { FixtureKnowledgeProvider } from '@agent18/knowledge-basic';
import {
  ProviderRegistry,
  builtInTool,
  bindingSchemas,
  evidenceBatchSchema,
  type RegisteredProvider,
} from '@agent18/provider-contracts';
import { readConfig, localDirectory } from '../../scripts/config.js';
import type { Scope } from '@agent18/contracts';
describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')(
  'registered non-knowledge tool through the real Case runtime',
  () => {
    let config: ReturnType<typeof readConfig>;
    let db: InstanceType<typeof Pool>, admin: InstanceType<typeof Pool>;
    let scope: Scope;
    const providerId = 'test-logs-' + crypto.randomUUID(),
      tool = builtInTool('test.logs.' + crypto.randomUUID(), providerId, 'logs.search', 'READ', 'log');
    const invoke = vi.fn(async (input: unknown, context: { scope: Scope; requestId: string }) => [
      {
        id: crypto.randomUUID(),
        kind: 'log' as const,
        source: 'log://synthetic-storefront',
        observedAt: new Date().toISOString(),
        resource: { type: 'log', id: (input as { traceId: string }).traceId },
        summary: 'Synthetic timeout from the storefront service',
        artifactRef: null,
        visibility: 'TENANT' as const,
        sensitivity: 'CONFIDENTIAL' as const,
        scope: context.scope,
        provenance: {
          providerId,
          toolId: tool.id,
          toolVersion: 1,
          sourceVersion: 'deployment-18',
          requestId: context.requestId,
        },
      },
    ]);
    const provider: RegisteredProvider = {
      manifest: { id: providerId, version: '1.0.0', capabilities: ['logs.search'], mode: 'fixture' },
      transport: 'native',
      tools: [
        {
          descriptor: tool,
          inputSchema: z.object({ traceId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
          outputSchema: evidenceBatchSchema,
          invoke,
        },
      ],
      visible: async (_scope, items) => items,
    };
    let gateway: ToolGateway, cases: CaseService;
    let server: Awaited<ReturnType<typeof buildApp>>;
    async function report() {
      const result = await cases.report(
        scope,
        {
          title: 'Synthetic runtime issue',
          description: 'A request timed out',
          context: {
            entity: { namespace: 'crm', type: 'lead', id: 'lead-1' },
            traceId: 'a'.repeat(32),
            environment: 'untrusted-client-env',
          },
        },
        crypto.randomUUID(),
        crypto.randomUUID(),
      );
      const detail = await cases.detail(scope, result.case.id);
      return { caseId: result.case.id, runId: detail.runs[0]!.id };
    }
    beforeAll(async () => {
      config = readConfig();
      scope = {
        organizationId: config.projects[0]!.organizationId,
        projectId: config.projects[0]!.projectId,
        tenantId: 'tenant-a',
        subject: 'core06-' + crypto.randomUUID(),
      };
      const credentials = JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'));
      admin = new Pool({ connectionString: credentials.adminDatabaseUrl });
      await admin.query(
        "INSERT INTO control.providers(id,version,review,transport,capabilities) VALUES($1,'1.0.0','approved','native',$2)",
        [providerId, JSON.stringify(provider.manifest.capabilities)],
      );
      await admin.query(
        "INSERT INTO control.tools(id,version,review,effect,stage,audience,provider,capability,risk,resource_types,environment_policy,schemas) VALUES($1,1,'approved','READ','READ','CUSTOMER',$2,'logs.search','LOW',$3,$4,$5)",
        [
          tool.id,
          providerId,
          JSON.stringify(tool.resourceTypes),
          JSON.stringify(tool.environmentPolicy),
          JSON.stringify(bindingSchemas(provider.tools[0]!)),
        ],
      );
      const providers = new ProviderRegistry();
      providers.register(provider);
      server = await buildApp(config, {
        dispatch: false,
        providers,
        caseWorkflow: { toolId: tool.id, input: (report) => ({ traceId: report.context.traceId }) },
      });
      db = server.db;
      gateway = server.gateway;
      cases = server.cases;
    });
    afterAll(async () => {
      await admin?.query('DELETE FROM control.tools WHERE id=$1', [tool.id]);
      await admin?.query('DELETE FROM control.providers WHERE id=$1', [providerId]);
      await server?.app.close();
      await admin?.end();
    });
    it('persists a log Evidence and generic step without changing the executor, and strips private references', async () => {
      const { caseId, runId } = await report();
      expect(await cases.execute(scope, runId, 'log-run')).toEqual({ state: 'completed' });
      const result = await cases.detail(scope, caseId);
      expect(result.evidence[0]?.kind).toBe('log');
      expect(result.evidence[0]?.summary).toContain('Synthetic timeout');
      expect(result.evidence[0]).not.toHaveProperty('citation');
      expect(result.evidence[0]).not.toHaveProperty('scope');
      expect(result.evidence[0]).not.toHaveProperty('artifactRef');
      expect(
        result.runs[0]?.steps.find((s) => s.capability === 'logs.search' && s.state === 'succeeded'),
      ).toMatchObject({
        toolId: tool.id,
        providerId,
        policyDecision: 'ALLOW',
        inputRef: 'run-input:' + runId,
        outputRef: 'run-evidence:' + runId,
      });
      await scoped(db, { ...scope, subject: 'other' }, async (client) =>
        expect((await client.query('SELECT id FROM core.evidence WHERE case_id=$1', [caseId])).rowCount).toBe(
          0,
        ),
      );
      await expect(cases.detail({ ...scope, tenantId: 'tenant-b' }, caseId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
    it('denies unreviewed tools before invocation and hides revoked historical evidence', async () => {
      const { caseId, runId } = await report();
      await cases.execute(scope, runId, 'before-revoke');
      await admin.query("UPDATE control.providers SET review='revoked' WHERE id=$1", [providerId]);
      const count = invoke.mock.calls.length;
      try {
        expect((await cases.detail(scope, caseId)).evidence).toHaveLength(0);
        await expect(report()).rejects.toMatchObject({ code: 'TOOL_NOT_APPROVED' });
        expect(invoke.mock.calls.length).toBe(count);
      } finally {
        await admin.query("UPDATE control.providers SET review='approved' WHERE id=$1", [providerId]);
      }
    });
    it('pins queued runs to the exact provider and schema fingerprint', async () => {
      const { runId } = await report();
      await admin.query("UPDATE core.runs SET registry_hash='changed' WHERE id=$1", [runId]);
      const count = invoke.mock.calls.length;
      expect(await cases.execute(scope, runId, 'changed-pin')).toEqual({ state: 'blocked' });
      expect(invoke.mock.calls.length).toBe(count);
    });
    it('rejects schema drift and prohibits customer self-review', async () => {
      await admin.query("UPDATE control.tools SET schemas='{}' WHERE id=$1", [tool.id]);
      try {
        await expect(report()).rejects.toMatchObject({ code: 'TOOL_BINDING_CHANGED' });
      } finally {
        await admin.query('UPDATE control.tools SET schemas=$2 WHERE id=$1', [
          tool.id,
          JSON.stringify(bindingSchemas(provider.tools[0]!)),
        ]);
      }
      await expect(
        db.query("UPDATE control.providers SET review='approved' WHERE id=$1", [providerId]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    it('does not publish late output when the provider is revoked during invocation', async () => {
      const { caseId, runId } = await report();
      let release!: () => void, started!: () => void;
      const wait = new Promise<void>((resolve) => {
          release = resolve;
        }),
        entered = new Promise<void>((resolve) => {
          started = resolve;
        });
      const original = invoke.getMockImplementation()!;
      invoke.mockImplementationOnce(async (input, context) => {
        started();
        await wait;
        return original(input, context);
      });
      const running = cases.execute(scope, runId, 'in-flight-revoke');
      await entered;
      try {
        await admin.query("UPDATE control.providers SET review='revoked' WHERE id=$1", [providerId]);
        release();
        expect(await running).toEqual({ state: 'blocked' });
        expect((await cases.detail(scope, caseId)).evidence).toHaveLength(0);
      } finally {
        release();
        await admin.query("UPDATE control.providers SET review='approved' WHERE id=$1", [providerId]);
      }
    });
    it('persists APPROVAL_REQUIRED without invoking a high-risk tool', async () => {
      await admin.query("UPDATE control.tools SET risk='HIGH' WHERE id=$1", [tool.id]);
      try {
        const providers = new ProviderRegistry();
        providers.register({
          ...provider,
          tools: [{ ...provider.tools[0]!, descriptor: { ...tool, risk: 'HIGH' } }],
        });
        const gate = new ToolGateway(
          db,
          new OpaPolicy(config.opaUrl),
          new FixtureKnowledgeProvider(),
          providers,
        );
        const service = new CaseService(db, gate, {
          toolId: tool.id,
          input: () => ({ traceId: 'a'.repeat(32) }),
        });
        const c = await service.report(
          scope,
          { title: 'High risk synthetic issue', description: 'Approval required', context: {} },
          crypto.randomUUID(),
          'high-risk',
        );
        const run = (await service.detail(scope, c.case.id)).runs[0]!;
        const count = invoke.mock.calls.length;
        expect(await service.execute(scope, run.id, 'high-risk-execute')).toEqual({ state: 'blocked' });
        const detail = await service.detail(scope, c.case.id);
        expect(detail.audit.some((a) => a.decision === 'APPROVAL_REQUIRED')).toBe(true);
        expect(detail.runs[0]?.steps.some((s) => s.policyDecision === 'APPROVAL_REQUIRED')).toBe(true);
        expect(invoke.mock.calls.length).toBe(count);
      } finally {
        await admin.query("UPDATE control.tools SET risk='LOW' WHERE id=$1", [tool.id]);
      }
    });
    it('imports candidates as pending and requires the exact reviewed fingerprint in the owner CLI', async () => {
      const path = resolve(tmpdir(), 'agent18-registry-' + crypto.randomUUID() + '.json');
      const cli = (...args: string[]) =>
        promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/registry.ts', ...args], {
          cwd: process.cwd(),
        });
      try {
        await writeFile(
          path,
          JSON.stringify({
            id: providerId,
            version: '1.0.0',
            transport: 'native',
            capabilities: provider.manifest.capabilities,
            tools: [{ descriptor: tool, schemas: bindingSchemas(provider.tools[0]!) }],
          }),
        );
        await cli('import', path);
        await expect(gateway.registry.resolve(tool.id)).rejects.toMatchObject({ code: 'TOOL_NOT_APPROVED' });
        const { stdout } = await cli('inspect', providerId);
        const fingerprint = JSON.parse(stdout).fingerprint;
        await expect(cli('approve', providerId, 'wrong-fingerprint')).rejects.toThrow();
        await cli('approve', providerId, fingerprint);
        expect((await gateway.registry.resolve(tool.id)).tool.review).toBe('approved');
      } finally {
        await rm(path, { force: true });
      }
    });
  },
);
