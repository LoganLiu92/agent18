import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { importJWK, SignJWT } from 'jose';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Pool } from '@agent18/persistence';
import { QueryService, importOpenApi, queriesSchema } from '@agent18/actions';
import { OpaPolicy } from '@agent18/policy';
import { buildApp } from '../../apps/server/src/app.js';
import { buildSetupApp } from '../../apps/setup/src/app.js';
import { localDirectory, readConfig } from '../../scripts/config.js';
import { registerDemoBusiness } from '../../examples/identity-bridge/business.js';
import { registerDemoQueries, demoOpenApi, demoPostQuery } from '../../examples/identity-bridge/queries.js';
import { publicApiDefinitions } from '../../apps/server/src/openapi.js';
import type { CustomerPrincipal } from '@agent18/domain';

describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')('complete scoped connection workflow', () => {
  let business: ReturnType<typeof Fastify>,
    server: Awaited<ReturnType<typeof buildApp>>,
    owner: Awaited<ReturnType<typeof buildSetupApp>>,
    admin: InstanceType<typeof Pool>,
    root: string,
    p: CustomerPrincipal,
    service: QueryService,
    queryConfig: ReturnType<typeof queriesSchema.parse>,
    alice: string,
    bob: string,
    nina: string,
    emptyRoles: string;
  let cfg: ReturnType<typeof readConfig>;
  const h = () => ({ authorization: alice, 'x-project-key': cfg.projects[0]!.key });
  const oh = { host: 'localhost:4321', authorization: 'Bearer owner-workflow-access-token' };
  beforeAll(async () => {
    cfg = readConfig();
    root = await mkdtemp(join(tmpdir(), 'agent18-round5-'));
    const identity = JSON.parse(await readFile(join(localDirectory, 'identity.json'), 'utf8')),
      key = await importJWK(identity.privateJwk, 'EdDSA');
    const signed = async (subject: string, tenant = 'tenant-a', roles = ['tenant-admin']) =>
      'Bearer ' +
      (await new SignJWT({ kind: 'customer', project_key: 'invoice-demo', tenant_id: tenant, roles })
        .setSubject(subject)
        .setProtectedHeader({ alg: 'EdDSA', kid: identity.publicJwk.kid })
        .setIssuer(cfg.projects[0]!.issuer)
        .setAudience(cfg.projects[0]!.audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key));
    [alice, bob, nina, emptyRoles] = await Promise.all([
      signed('alice'),
      signed('bob'),
      signed('nina', 'tenant-b'),
      signed('alice', 'tenant-a', []),
    ]);
    p = {
      ...cfg.projects[0]!,
      tenantId: 'tenant-a',
      subject: 'alice',
      kind: 'customer',
      roles: ['tenant-admin'],
      expiresAt: Date.now() + 300000,
    };
    business = Fastify();
    registerDemoBusiness(business, join(root, 'business.sqlite'), { keys: [identity.publicJwk] });
    registerDemoQueries(business, join(root, 'business.sqlite'), { keys: [identity.publicJwk] });
    const baseUrl = await business.listen({ port: 0, host: '127.0.0.1' });
    queryConfig = queriesSchema.parse({
      baseUrl,
      operations: [
        ...importOpenApi(demoOpenApi).operations.map((q) => ({
          ...q,
          enabled: true,
          roles: ['tenant-admin'],
        })),
        demoPostQuery,
      ],
    });
    cfg.projects[0]!.businessQueries = queryConfig;
    server = await buildApp(cfg, { dispatch: false });
    service = new QueryService(server.db, new OpaPolicy(cfg.opaUrl), () => queryConfig);
    const migration = JSON.parse(await readFile(join(localDirectory, 'migration.json'), 'utf8'));
    admin = new Pool({ connectionString: migration.adminDatabaseUrl });
    for (const file of ['server.json', 'server.docker.json'])
      await writeFile(join(root, file), JSON.stringify(cfg));
    await writeFile(join(root, 'migration.json'), JSON.stringify(migration));
    owner = await buildSetupApp({ directory: root, token: 'owner-workflow-access-token', root });
  });
  afterAll(async () => {
    await owner?.close();
    await server?.app.close();
    await business?.close();
    await admin?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('persists customer conversations over HTTP with idempotency and subject isolation', async () => {
    const key = randomUUID();
    const create = () =>
      server.app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { ...h(), 'idempotency-key': key },
        payload: { title: 'Persistent customer conversation' },
      });
    const created = await create();
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().conversation.id;
    expect((await create()).json().conversation.id).toBe(id);
    const messageKey = randomUUID();
    const append = (body: string, authorization = alice) =>
      server.app.inject({
        method: 'POST',
        url: '/api/conversations/' + id + '/messages',
        headers: { ...h(), authorization, 'idempotency-key': messageKey },
        payload: { role: 'user', body },
      });
    expect((await append('Please explain the onboarding workflow.')).statusCode).toBe(200);
    expect((await append('Please explain the onboarding workflow.')).statusCode).toBe(200);
    expect((await append('Changed content')).statusCode).toBe(409);
    for (const authorization of [bob, nina]) {
      expect(
        (await server.app.inject({ url: '/api/conversations/' + id, headers: { ...h(), authorization } }))
          .statusCode,
      ).toBe(404);
      expect((await append('Please explain the onboarding workflow.', authorization)).statusCode).toBe(404);
    }
    const detail = await server.app.inject({ url: '/api/conversations/' + id, headers: h() });
    expect(detail.json().messages).toHaveLength(1);
    expect(detail.json().messages[0]).toMatchObject({ sequence: 1, origin: 'client_display' });
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/conversations/' + id + '/delete',
          headers: h(),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await server.app.inject({ url: '/api/conversations/' + id, headers: h() })).statusCode).toBe(404);
  });
  it('validates metric date windows before calling any upstream service', async () => {
    const q = {
      ...queryConfig.operations.find((q) => q.id === 'orders.list')!,
      fields: [
        { name: 'start', label: 'Start', in: 'query', type: 'string', required: true },
        { name: 'end', label: 'End', in: 'query', type: 'string', required: true },
      ],
      metric: {
        id: 'orders.sample',
        version: '1',
        definition: 'Synthetic order values for boundary verification',
        timezone: 'UTC',
        values: [{ column: 'amount', unit: 'currency', currency: 'USD' }],
        dimensions: ['customer'],
        period: { startField: 'start', endField: 'end' },
        maxDays: 31,
      },
    };
    const metrics = queriesSchema.parse({ ...queryConfig, operations: [q] });
    const scopedService = new QueryService(server.db, new OpaPolicy(cfg.opaUrl), () => metrics);
    const realFetch = globalThis.fetch;
    const upstream = vi.spyOn(globalThis, 'fetch');
    try {
      for (const [start, end] of [
        ['2026-02-30', '2026-03-03'],
        ['2026-03-03', '2026-03-03'],
        ['2026-01-01', '2026-04-01'],
      ])
        await expect(
          scopedService.execute(p, 'orders.list', { start, end }, alice, randomUUID()),
        ).rejects.toMatchObject({ code: 'METRIC_PERIOD_INVALID' });
      expect(upstream).not.toHaveBeenCalled();
      upstream.mockImplementation((url, init) =>
        String(url).startsWith(metrics.baseUrl)
          ? Promise.resolve(
              new Response(
                JSON.stringify([
                  { id: 'ORD-1001', customer: 'Alice', amount: 100, status: '已完成' },
                  { id: 'ORD-1002', customer: 'Alice', amount: 200, status: '待处理' },
                ]),
                { headers: { 'content-type': 'application/json' } },
              ),
            )
          : realFetch(url, init),
      );
      const result = await scopedService.execute(
        p,
        'orders.list',
        { start: '2026-03-01', end: '2026-03-10' },
        alice,
        randomUUID(),
      );
      expect(result.period).toEqual({ start: '2026-03-01', end: '2026-03-10' });
      expect(result.metric?.version).toBe('1');
      expect(result.rows).toHaveLength(2);
    } finally {
      upstream.mockRestore();
    }
  });
  it('uses real SaaS HTTP data and exposes only approved fields', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/api/business/query',
      headers: h(),
      payload: { queryId: 'orders.list', arguments: {} },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().rows.map((v: any) => v.id)).toEqual(['ORD-1001', 'ORD-1002']);
    expect(r.body).not.toContain('internalMemo');
    expect(r.body).not.toContain('internal-only');
    expect(r.json().requestId).toBeTruthy();
  });
  it('runs reviewed POST reads with a fixed JSON body and independent SaaS authorization', async () => {
    for (const [authorization, expected] of [
      [alice, ['ORD-1001']],
      [bob, []],
      [nina, ['ORD-2001']],
    ] as const) {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/business/query',
        headers: { ...h(), authorization },
        payload: { queryId: 'orders.search', arguments: { status: '已完成' } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().rows.map((r: any) => r.id)).toEqual(expected);
      expect(response.body).not.toContain('internalMemo');
    }
    for (const arguments_ of [
      { status: '已完成', tenantId: 'tenant-b' },
      { status: 'invalid' },
      { url: 'https://evil.example' },
      { status: { anything: true } },
    ])
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/business/query',
            headers: h(),
            payload: { queryId: 'orders.search', arguments: arguments_ },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/business/query',
          headers: { ...h(), authorization: emptyRoles },
          payload: { queryId: 'orders.search', arguments: { status: '已完成' } },
        })
      ).statusCode,
    ).toBe(403);
    const operation = queryConfig.operations.find((q) => q.id === 'orders.search')!;
    operation.enabled = false;
    await expect(
      service.execute(p, 'orders.search', { status: '已完成' }, alice, 'disabled-post'),
    ).rejects.toMatchObject({ code: 'QUERY_NOT_ALLOWED' });
    operation.enabled = true;
    const original = globalThis.fetch,
      bodies: RequestInit[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url).startsWith(queryConfig.baseUrl)) {
        bodies.push(init!);
        return Promise.reject(new Error('uncertain network'));
      }
      return original(url, init);
    });
    try {
      await expect(
        service.execute(p, 'orders.search', { status: '已完成' }, alice, 'failed-post'),
      ).rejects.toMatchObject({ code: 'BUSINESS_RESPONSE_INVALID' });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ status: '已完成' }),
      });
      expect(bodies[0]!.headers).toMatchObject({ authorization: alice, 'content-type': 'application/json' });
    } finally {
      spy.mockRestore();
    }
  });
  it('keeps POST registration owner-only and persists its review separately from enablement', async () => {
    expect(
      (
        await owner.inject({
          method: 'POST',
          url: '/owner/queries/review',
          headers: { ...oh, authorization: alice },
          payload: demoPostQuery,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await owner.inject({
          method: 'POST',
          url: '/owner/queries/review',
          headers: oh,
          payload: { ...demoPostQuery, readOnly: false },
        })
      ).statusCode,
    ).toBe(400);
    const reviewed = await owner.inject({
      method: 'POST',
      url: '/owner/queries/review',
      headers: oh,
      payload: { ...demoPostQuery, enabled: false },
    });
    expect(reviewed.json().operation).toMatchObject({ method: 'POST', readOnly: true, enabled: false });
  });
  it('persists semantic events with the case and exposes them only within the verified scope', async () => {
    const context = {
      route: 'order-detail',
      entity: { type: 'order', id: 'ORD-1001' },
      events: [
        {
          type: 'business.operation.failed',
          operation: 'order.save',
          at: new Date().toISOString(),
          errorCode: 'ORDER_TIMEOUT',
          traceId: 'a'.repeat(32),
          entity: { type: 'order', id: 'ORD-1001' },
        },
      ],
    };
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/cases',
      headers: { ...h(), 'idempotency-key': randomUUID() },
      payload: { title: 'Semantic failure context', description: 'Why did this fail?', context },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().case.id;
    expect((await server.app.inject({ url: `/api/cases/${id}`, headers: h() })).json().case.context).toEqual(
      context,
    );
    expect(
      (await server.app.inject({ url: `/api/cases/${id}`, headers: { ...h(), authorization: nina } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await owner.inject({ url: `/owner/projects/invoice-demo/cases/${id}/capture`, headers: oh })).json()
        .context,
    ).toEqual(context);
    expect(
      (await owner.inject({ url: `/owner/projects/other-demo/cases/${id}/capture`, headers: oh })).json()
        .context,
    ).toBeNull();
    const routed = await server.app.inject({
      method: 'POST',
      url: '/api/assistant/route',
      headers: h(),
      payload: { message: '为什么不行', context },
    });
    expect(routed.json()).toEqual({ kind: 'support' });
  });
  it('routes scoped conversation turns without executing business calls or creating proposals', async () => {
    const before = (await admin.query('SELECT count(*)::int AS n FROM core.action_proposals')).rows[0].n;
    const r = await server.app.inject({
      method: 'POST',
      url: '/api/assistant/route',
      headers: h(),
      payload: { message: '查询订单详情' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ kind: 'query', id: 'orders.get', arguments: {} });
    const followup = await server.app.inject({
      method: 'POST',
      url: '/api/assistant/route',
      headers: h(),
      payload: {
        message: 'ORD-1001',
        pending: { kind: 'query', id: 'orders.get', arguments: {}, field: 'orderId' },
      },
    });
    expect(followup.json()).toMatchObject({ kind: 'query', arguments: { orderId: 'ORD-1001' } });
    const denied = await server.app.inject({
      method: 'POST',
      url: '/api/assistant/route',
      headers: { ...h(), authorization: emptyRoles },
      payload: {
        message: 'ORD-1001',
        pending: { kind: 'query', id: 'orders.get', arguments: {}, field: 'orderId' },
      },
    });
    expect(denied.json().kind).toBe('knowledge');
    expect((await admin.query('SELECT count(*)::int AS n FROM core.action_proposals')).rows[0].n).toBe(
      before,
    );
    expect(r.body).not.toContain('Acme');
  });
  it('enforces tenant and object ownership again in the independent SaaS API', async () => {
    for (const authorization of [bob, nina]) {
      const r = await server.app.inject({
        method: 'POST',
        url: '/api/business/query',
        headers: { ...h(), authorization },
        payload: { queryId: 'orders.get', arguments: { orderId: 'ORD-1001' } },
      });
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain('Acme');
    }
    const r = await service.execute(p, 'orders.list', {}, bob, 'independent-backend');
    expect(r.rows.map((v) => v.id)).toEqual(['ORD-1003']);
  });
  it('rejects disabled capabilities, role revocation, unexpected parameters and path traversal', async () => {
    await expect(
      service.execute({ ...p, roles: [] }, 'orders.list', {}, alice, 'roles'),
    ).rejects.toMatchObject({ code: 'QUERY_NOT_ALLOWED' });
    for (const orderId of ['..', '%2fadmin', 'a/b', 'a?x=1'])
      await expect(service.execute(p, 'orders.get', { orderId }, alice, 'path')).rejects.toMatchObject({
        code: 'QUERY_ARGUMENTS_INVALID',
      });
    await expect(
      service.execute(p, 'orders.list', { tenantId: 'tenant-b' }, alice, 'extra'),
    ).rejects.toMatchObject({ code: 'ACTION_ARGUMENTS_INVALID' });
    const denied = await server.app.inject({
      url: '/api/business/queries',
      headers: { ...h(), authorization: emptyRoles },
    });
    expect(denied.json().queries).toEqual([]);
  });
  it('never dispatches when policy is unavailable and rejects redirects or excessive responses', async () => {
    const blocked = new QueryService(server.db, new OpaPolicy('http://127.0.0.1:1'), () => queryConfig);
    await expect(blocked.execute(p, 'orders.list', {}, alice, 'policy-down')).rejects.toMatchObject({
      code: 'POLICY_UNAVAILABLE',
    });
    const fetch = globalThis.fetch;
    for (const response of [
      new Response('redirect', { status: 302 }),
      Response.json({ value: 'x'.repeat(270000) }),
    ]) {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation((url, options) =>
          String(url).startsWith(queryConfig.baseUrl) ? Promise.resolve(response) : fetch(url, options),
        );
      try {
        await expect(service.execute(p, 'orders.list', {}, alice, 'invalid-upstream')).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
    }
  });
  it('keeps conversation, reply and resolution scoped, idempotent and durable', async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/cases',
      headers: { ...h(), 'idempotency-key': randomUUID() },
      payload: {
        title: 'Round 5 customer conversation',
        description: 'Order lookup needs support follow-up',
        context: {},
      },
    });
    const caseId = created.json().case.id;
    const messageKey = randomUUID(),
      url = `/api/cases/${caseId}/messages`;
    const one = {
      method: 'POST' as const,
      url,
      headers: { ...h(), 'idempotency-key': messageKey },
      payload: { body: 'Please verify order progress' },
    };
    expect((await server.app.inject(one)).json()).toEqual({ replayed: false });
    expect((await server.app.inject(one)).json()).toEqual({ replayed: true });
    expect((await server.app.inject({ ...one, payload: { body: 'Changed' } })).statusCode).toBe(409);
    expect(
      (await server.app.inject({ ...one, payload: { body: 'Fake', author: 'support' } })).statusCode,
    ).toBe(400);
    for (const authorization of [bob, nina])
      expect((await server.app.inject({ url, headers: { ...h(), authorization } })).statusCode).toBe(404);
    const replyPath = `/owner/projects/invoice-demo/cases/${caseId}/messages`;
    expect(
      (
        await owner.inject({
          method: 'POST',
          url: replyPath,
          headers: { ...oh, 'idempotency-key': randomUUID() },
          payload: { body: 'Confirmed by support team' },
        })
      ).statusCode,
    ).toBe(200);
    const thread = (await server.app.inject({ url, headers: h() })).json().messages;
    expect(thread.map((m: any) => m.author)).toEqual(['customer', 'support']);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/cases/${caseId}/status`,
          headers: h(),
          payload: { status: 'resolved' },
        })
      ).json().case.status,
    ).toBe('resolved');
    const run = (await server.cases.detail(p, caseId)).runs[0]!;
    await server.cases.execute(p, run.id, 'after-customer-resolution');
    expect((await server.cases.detail(p, caseId)).case.status).toBe('resolved');
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/cases/${caseId}/status`,
          headers: h(),
          payload: { status: 'needs_human' },
        })
      ).json().case.status,
    ).toBe('needs_human');
    expect(
      (await admin.query('SELECT count(*)::int AS n FROM core.case_messages WHERE case_id=$1', [caseId]))
        .rows[0].n,
    ).toBe(2);
    expect((await server.db.query('SELECT * FROM core.case_messages')).rowCount).toBe(0);
  });
  it('protects the owner inbox, makes OpenAPI imports reviewable and preserves Docker endpoints', async () => {
    expect(
      (
        await owner.inject({
          url: '/owner/projects/invoice-demo/cases',
          headers: { ...oh, authorization: alice },
        })
      ).statusCode,
    ).toBe(401);
    const imported = await owner.inject({
      method: 'POST',
      url: '/owner/openapi/import',
      headers: oh,
      payload: { document: demoOpenApi },
    });
    expect(imported.json().operations.every((q: any) => !q.enabled)).toBe(true);
    const docker = structuredClone(cfg);
    docker.projects[0]!.businessQueries!.baseUrl = 'http://identity-demo:4319';
    await writeFile(join(root, 'server.docker.json'), JSON.stringify(docker));
    const saved = await owner.inject({
      method: 'POST',
      url: '/owner/projects/invoice-demo/business',
      headers: oh,
      payload: { businessQueries: queryConfig },
    });
    expect(saved.statusCode).toBe(200);
    expect(
      JSON.parse(
        await readFile(join(root, 'server.docker.json'), 'utf8'),
      ).projects[0].businessQueries.operations.find((q: any) => q.id === 'orders.search'),
    ).toMatchObject({ method: 'POST', readOnly: true, fields: [{ in: 'body' }] });
    expect(
      JSON.parse(await readFile(join(root, 'server.docker.json'), 'utf8')).projects[0].businessQueries
        .baseUrl,
    ).toBe('http://identity-demo:4319');
  });
  it('documents every public customer route and publishes a credential-free contract', async () => {
    expect(server.customerRoutes.sort()).toEqual(
      publicApiDefinitions.map((d) => d.method.toUpperCase() + ' ' + d.path).sort(),
    );
    const spec = await server.app.inject('/openapi.json');
    expect(spec.statusCode).toBe(200);
    expect(spec.body).not.toContain(cfg.workerToken);
    expect(spec.body).not.toContain(cfg.databaseUrl);
    for (const d of publicApiDefinitions) {
      const url = d.path.replace(/\{\w+\}/g, '00000000-0000-4000-8000-000000000000');
      const r = await server.app.inject({
        method: d.method.toUpperCase() as 'GET' | 'POST',
        url,
        ...(d.method === 'post' ? { payload: {} } : {}),
      });
      expect(r.statusCode, d.path).toBe(401);
    }
  });
});
