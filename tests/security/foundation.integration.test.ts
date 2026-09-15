import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT, importJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { buildApp } from '../../apps/server/src/app.js';
import { readConfig, localDirectory, type Config } from '../../scripts/config.js';
import { scoped, type Database } from '@agent18/persistence';
import { OpaPolicy } from '@agent18/policy';
import { ToolGateway } from '@agent18/application';
import { FixtureKnowledgeProvider } from '@agent18/knowledge-basic';
import type { CustomerPrincipal } from '@agent18/domain';

describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')('real PostgreSQL + OPA foundation isolation', () => {
  let server: Awaited<ReturnType<typeof buildApp>>, config: Config, admin: pg.Pool, queue: pg.Pool;
  let privateKey: Awaited<ReturnType<typeof importJWK>>;
  const subject = `security-${crypto.randomUUID()}`;
  let principal: CustomerPrincipal;
  let token: string, caseId: string;
  const report = {
    title: '发票提交失败 · security fixture',
    description: 'Synthetic regression fixture, no customer data.',
    context: { pagePath: '/invoices' },
  };
  async function sign(overrides: Record<string, unknown> = {}, key = privateKey) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: subject,
      kind: 'customer',
      tenant_id: 'tenant-a',
      project_key: 'invoice-demo',
      roles: ['admin'],
      iss: 'urn:agent18:demo-saas',
      aud: 'agent18:support',
      iat: now,
      exp: now + 300,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'local-demo-1' })
      .sign(key);
  }
  const headers = (value = token, project = 'invoice-demo') => ({
    authorization: `Bearer ${value}`,
    'x-project-key': project,
  });
  beforeAll(async () => {
    config = readConfig();
    config.projects = config.projects.map((project) => ({ ...project, knowledge: 'fixture' }));
    privateKey = await importJWK(
      JSON.parse(await readFile(resolve(localDirectory, 'identity.json'), 'utf8')).privateJwk,
      'EdDSA',
    );
    const migration = JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'));
    admin = new pg.Pool({ connectionString: migration.adminDatabaseUrl });
    queue = new pg.Pool({ connectionString: config.queueDatabaseUrl });
    server = await buildApp(config, { dispatch: false });
    token = await sign();
    principal = {
      ...config.projects[0]!,
      organizationId: config.projects[0]!.organizationId,
      projectId: config.projects[0]!.projectId,
      tenantId: 'tenant-a',
      subject,
      kind: 'customer',
      roles: [],
      expiresAt: Date.now() + 300000,
    };
  });
  afterAll(async () => {
    await server?.app.close();
    await admin?.end();
    await queue?.end();
  });
  it('commits one Case, Run and outbox row for concurrent retries', async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        server.app.inject({
          method: 'POST',
          url: '/api/cases',
          headers: { ...headers(), 'idempotency-key': key },
          payload: report,
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5);
    caseId = results[0]!.json().case.id;
    expect(new Set(results.map((r) => r.json().case.id)).size).toBe(1);
    expect(
      (await admin.query('SELECT count(*)::int AS n FROM core.runs WHERE case_id=$1', [caseId])).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM control.dispatch d JOIN core.runs r ON d.run_id=r.id WHERE r.case_id=$1',
          [caseId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/cases',
          headers: { ...headers(), 'idempotency-key': key },
          payload: { ...report, title: 'Changed payload' },
        })
      ).statusCode,
    ).toBe(409);
  });
  it.each([
    ['tenant', { tenant_id: 'tenant-b' }, 'invoice-demo'],
    ['subject', { sub: 'another-user' }, 'invoice-demo'],
    ['project', { project_key: 'other-demo' }, 'other-demo'],
  ] as const)('isolates detail, evidence, audit and list across %s', async (_kind, override, project) => {
    const other = await sign(override);
    const detail = await server.app.inject({ url: `/api/cases/${caseId}`, headers: headers(other, project) });
    expect(detail.statusCode).toBe(404);
    expect(detail.body).not.toContain(report.title);
    const list = await server.app.inject({ url: '/api/cases', headers: headers(other, project) });
    expect(list.statusCode).toBe(200);
    expect(list.json().cases.map((c: { id: string }) => c.id)).not.toContain(caseId);
  });
  it.each([
    ['expired', { iat: 1, exp: 2 }],
    ['audience', { aud: 'other' }],
    ['issuer', { iss: 'attacker' }],
    ['future', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
    ['missing tenant', { tenant_id: undefined }],
    ['operator', { kind: 'operator' }],
    ['excessive TTL', { exp: Math.floor(Date.now() / 1000) + 86400 }],
    ['project binding', { project_key: 'other-demo' }],
  ])('rejects invalid JWT: %s', async (_kind, overrides) => {
    const response = await server.app.inject({
      url: '/api/session',
      headers: headers(await sign(overrides as Record<string, unknown>)),
    });
    expect(response.statusCode).toBe(401);
  });
  it('rejects forged signatures and missing credentials', async () => {
    const keys = await generateKeyPair('EdDSA');
    expect(
      (await server.app.inject({ url: '/api/session', headers: headers(await sign({}, keys.privateKey)) }))
        .statusCode,
    ).toBe(401);
    expect((await server.app.inject({ url: '/api/session' })).statusCode).toBe(401);
  });
  it('keeps tenant administrators as customer principals', async () => {
    const response = await server.app.inject({ url: '/api/session', headers: headers() });
    expect(response.json().principal.kind).toBe('customer');
    expect(response.json().capabilities.operatorConsole).toBe(false);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/internal/jobs/claim',
          headers: headers(),
          payload: { dispatchId: crypto.randomUUID(), jobId: crypto.randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('rejects caller-controlled tenant and user fields in a report', async () => {
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/cases',
          headers: { ...headers(), 'idempotency-key': crypto.randomUUID() },
          payload: { ...report, tenantId: 'tenant-b', subject: 'owner' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('denies absent RLS scope and resets transaction-local scope on pooled connections', async () => {
    expect((await server.db.query('SELECT id FROM core.cases')).rowCount).toBe(0);
    await scoped(server.db, principal, async (client) => {
      expect((await client.query('SELECT id FROM core.cases WHERE id=$1', [caseId])).rowCount).toBe(1);
    });
    expect((await server.db.query('SELECT id FROM core.cases')).rowCount).toBe(0);
    await expect(
      scoped(server.db, { ...principal, tenantId: 'tenant-b' }, async (client) => {
        await client.query('UPDATE core.cases SET tenant_id=$1 WHERE id=$2', ['tenant-a', caseId]);
        await client.query(
          'INSERT INTO core.cases (id,organization_id,project_id,tenant_id,subject,title,description,idempotency_key,request_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            crypto.randomUUID(),
            principal.organizationId,
            principal.projectId,
            'tenant-a',
            subject,
            'invalid scope',
            'invalid scope',
            crypto.randomUUID(),
            'hash',
          ],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it.each([
    'core.cases',
    'core.audit',
    'core.organizations',
    'control.tools',
    'control.dispatch',
    'control.security_events',
  ])('worker database role cannot read %s', async (table) => {
    await expect(queue.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
  });
  it('runtime app cannot modify audits or review tools', async () => {
    await expect(server.db.query("UPDATE control.tools SET review='approved'")).rejects.toMatchObject({
      code: '42501',
    });
    await expect(server.db.query('DELETE FROM core.audit')).rejects.toMatchObject({ code: '42501' });
    const roles = (
      await admin.query(
        "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('agent18_app','agent18_queue')",
      )
    ).rows;
    expect(roles).toHaveLength(2);
    expect(roles.every((r) => !r.rolsuper && !r.rolbypassrls)).toBe(true);
  });
  it('retrieves sources with no Case creation and without internal scope fields', async () => {
    const before = await server.cases.list(principal);
    const result = await server.app.inject({
      method: 'POST',
      url: '/api/knowledge/search',
      headers: headers(),
      payload: { query: '发票创建' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().mode).toBe('retrieval_only');
    expect(result.json().citations.length).toBeGreaterThan(0);
    expect(result.body).not.toContain('organizationId');
    expect(result.body).not.toContain('tenantId');
    expect(await server.cases.list(principal)).toHaveLength(before.length);
  });
  it('fails closed and records a denial when OPA is unavailable', async () => {
    const provider = new FixtureKnowledgeProvider(),
      spy = vi.spyOn(provider, 'search');
    const gateway = new ToolGateway(server.db, new OpaPolicy('http://127.0.0.1:1'), provider);
    await expect(gateway.search(principal, 'invoice', 'offline-opa')).rejects.toMatchObject({
      code: 'POLICY_UNAVAILABLE',
    });
    expect(spy).not.toHaveBeenCalled();
    expect(
      (
        await admin.query("SELECT decision FROM core.audit WHERE subject=$1 AND request_id='offline-opa'", [
          subject,
        ])
      ).rows[0].decision,
    ).toBe('DENY');
  });
  it('will not execute a provider when the decision audit cannot commit', async () => {
    const provider = new FixtureKnowledgeProvider(),
      spy = vi.spyOn(provider, 'search');
    const brokenAuditDb = {
      query: server.db.query.bind(server.db),
      connect: async () => {
        throw new Error('audit outage');
      },
    } as unknown as Database;
    await expect(
      new ToolGateway(brokenAuditDb, new OpaPolicy(config.opaUrl), provider).search(
        principal,
        'invoice',
        'audit-outage',
      ),
    ).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('rejects a reviewed provider that returns another tenant’s data', async () => {
    const provider = new FixtureKnowledgeProvider();
    const original = provider.search.bind(provider);
    vi.spyOn(provider, 'search').mockImplementation(async (input, context) => {
      const results = await original(input, context);
      results[0]!.scope.tenantId = 'tenant-b';
      return results;
    });
    await expect(
      new ToolGateway(server.db, new OpaPolicy(config.opaUrl), provider).search(
        principal,
        'invoice',
        'poisoned-provider',
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESULT_REJECTED' });
    expect(
      (
        await admin.query(
          "SELECT decision FROM core.audit WHERE subject=$1 AND request_id='poisoned-provider' ORDER BY created_at DESC",
          [subject],
        )
      ).rows[0].decision,
    ).toBe('DENY');
  });
  it('rejects expired Case capabilities before execution', async () => {
    await expect(
      server.gateway.search(principal, 'invoice', 'expired-cap', {
        id: crypto.randomUUID(),
        toolId: 'knowledge.search',
        toolVersion: 1,
        scope: principal,
        expiresAt: 1,
        revision: 1,
        caseId,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('valid workload credentials alone cannot select arbitrary runs', async () => {
    const result = await server.app.inject({
      method: 'POST',
      url: `/internal/runs/${crypto.randomUUID()}/execute`,
      headers: { authorization: `Bearer ${config.workerToken}`, 'x-run-lease': 'a'.repeat(64) },
      payload: {},
    });
    expect(result.statusCode).toBe(403);
  });
  it('retains security audits without raw tokens or report bodies', async () => {
    const events = await admin.query(
      'SELECT * FROM control.security_events ORDER BY created_at DESC LIMIT 100',
    );
    expect(events.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(events.rows)).not.toContain(token);
    expect(JSON.stringify(events.rows)).not.toContain(report.description);
  });
});
