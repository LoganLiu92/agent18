import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { importJWK, SignJWT } from 'jose';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Pool } from '@agent18/persistence';
import { ActionService, bridgeSchema } from '@agent18/actions';
import { OpaPolicy } from '@agent18/policy';
import { AppError, type CustomerPrincipal } from '@agent18/domain';
import { buildApp } from '../../apps/server/src/app.js';
import { localDirectory, readConfig } from '../../scripts/config.js';
import { registerDemoBusiness } from '../../examples/identity-bridge/business.js';

describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')('delegated business actions', () => {
  let bridge: ReturnType<typeof Fastify>,
    server: Awaited<ReturnType<typeof buildApp>>,
    admin: InstanceType<typeof Pool>,
    root: string,
    p: CustomerPrincipal,
    auth: string,
    business: ReturnType<typeof bridgeSchema.parse>,
    service: ActionService;
  let signed: (subject?: string, roles?: string[]) => Promise<string>;
  const args = { emailNotifications: false };
  beforeAll(async () => {
    const config = readConfig(),
      identity = JSON.parse(await readFile(join(localDirectory, 'identity.json'), 'utf8'));
    const key = await importJWK(identity.privateJwk, 'EdDSA');
    p = {
      ...config.projects[0]!,
      tenantId: 'tenant-a',
      subject: 'action-test-' + randomUUID(),
      kind: 'customer',
      roles: ['tenant-admin'],
      expiresAt: Date.now() + 300000,
    };
    signed = async (subject = p.subject, roles = ['tenant-admin']) =>
      'Bearer ' +
      (await new SignJWT({
        kind: 'customer',
        tenant_id: 'tenant-a',
        project_key: config.projects[0]!.key,
        roles,
      })
        .setSubject(subject)
        .setProtectedHeader({ alg: 'EdDSA', kid: identity.publicJwk.kid })
        .setIssuer(config.projects[0]!.issuer)
        .setAudience(config.projects[0]!.audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key));
    auth = await signed();
    root = await mkdtemp(join(tmpdir(), 'agent18-business-'));
    bridge = Fastify();
    registerDemoBusiness(bridge, join(root, 'business.sqlite'), { keys: [identity.publicJwk] });
    const url = await bridge.listen({ port: 0, host: '127.0.0.1' });
    business = bridgeSchema.parse({
      url: url + '/agent18/bridge',
      actions: [
        {
          id: 'profile.notifications.update',
          title: 'Preferences',
          description: 'Change own preference',
          roles: ['tenant-admin'],
          enabled: true,
          fields: [{ name: 'emailNotifications', label: 'Email', type: 'boolean' }],
        },
      ],
    });
    config.projects[0]!.businessBridge = business;
    config.projects[0]!.allowedOrigins = ['https://customer.example'];
    server = await buildApp(config, { dispatch: false });
    service = new ActionService(server.db, new OpaPolicy(config.opaUrl), () => business);
    admin = new Pool({
      connectionString: JSON.parse(await readFile(join(localDirectory, 'migration.json'), 'utf8'))
        .adminDatabaseUrl,
    });
  });
  afterAll(async () => {
    await server?.app.close();
    await bridge?.close();
    await admin?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const headers = () => ({ authorization: auth, 'x-project-key': readConfig().projects[0]!.key });
  it('only offers registered actions and rejects identity or unsupported argument injection', async () => {
    expect(service.list(p)).toHaveLength(1);
    expect(service.list({ ...p, roles: [] })).toHaveLength(0);
    await expect(service.prepare(p, 'unregistered', {}, auth, 'invalid')).rejects.toMatchObject({
      code: 'ACTION_NOT_ALLOWED',
    });
    await expect(
      service.prepare(
        p,
        'profile.notifications.update',
        { ...args, tenantId: 'tenant-b' },
        auth,
        'injection',
      ),
    ).rejects.toMatchObject({ code: 'ACTION_ARGUMENTS_INVALID' });
  });
  it('model planning produces a preview only and rejects invented operations', async () => {
    let invalid = false;
    const planner = new ActionService(server.db, new OpaPolicy(readConfig().opaUrl), () => business, {
      identity: 'planner-test',
      complete: async () => ({
        value: { actionId: invalid ? 'arbitrary.sql' : 'profile.notifications.update', arguments: args },
        tokens: 10,
      }),
    });
    const proposal = await planner.plan(p, 'turn notifications off', auth, 'model-plan');
    expect(proposal.state).toBe('proposed');
    const status = await bridge.inject({
      method: 'POST',
      url: '/agent18/bridge',
      headers: { authorization: auth },
      payload: { phase: 'status', actionId: proposal.actionId, idempotencyKey: proposal.id },
    });
    expect(status.json().status).toBe('not_found');
    invalid = true;
    await expect(planner.plan(p, 'run SQL', auth, 'bad-plan')).rejects.toMatchObject({
      code: 'ACTION_NOT_ALLOWED',
    });
  });
  it('only prepares before confirmation and permits a single concurrent execution', async () => {
    const proposed = await service.prepare(p, 'profile.notifications.update', args, auth, 'prepare');
    expect(proposed.state).toBe('proposed');
    const before = await bridge.inject({
      method: 'POST',
      url: '/agent18/bridge',
      headers: { authorization: auth },
      payload: { phase: 'status', actionId: proposed.actionId, idempotencyKey: proposed.id },
    });
    expect(before.json().status).toBe('not_found');
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => service.confirm(p, proposed.id, auth, 'confirm-' + i)),
    );
    expect((await service.get(p, proposed.id)).state).toBe('succeeded');
    const next = await service.prepare(p, proposed.actionId, args, auth, 'next');
    expect(next.preview.revision).toBe('1');
    const repeat = await service.confirm(p, proposed.id, auth, 'repeat');
    expect(repeat.state).toBe('succeeded');
  });
  it('checks subject isolation, expiry and role changes at confirmation', async () => {
    const proposed = await service.prepare(p, 'profile.notifications.update', args, auth, 'scoped');
    await expect(service.get({ ...p, subject: 'someone-else' }, proposed.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      service.confirm({ ...p, roles: [] }, proposed.id, auth, 'revoked-role'),
    ).rejects.toMatchObject({ code: 'ACTION_NOT_ALLOWED' });
    await admin.query("UPDATE core.action_proposals SET expires_at=now()-interval '1 second' WHERE id=$1", [
      proposed.id,
    ]);
    expect((await service.confirm(p, proposed.id, auth, 'expired')).state).toBe('expired');
  });
  it('rejects registry changes and stale business previews', async () => {
    const first = await service.prepare(p, 'profile.notifications.update', args, auth, 'stale-first');
    const changed = new ActionService(server.db, new OpaPolicy(readConfig().opaUrl), () => ({
      ...business,
      actions: business.actions.map((a) => ({ ...a, title: 'Changed' })),
    }));
    await expect(changed.confirm(p, first.id, auth, 'changed')).rejects.toMatchObject({
      code: 'ACTION_CONFIGURATION_CHANGED',
    });
    const second = await service.prepare(
      p,
      'profile.notifications.update',
      { emailNotifications: true },
      auth,
      'stale-second',
    );
    expect((await service.confirm(p, second.id, auth, 'second')).state).toBe('succeeded');
    expect((await service.confirm(p, first.id, auth, 'first')).state).toBe('rejected');
  });
  it('keeps delivery uncertainty and reconciles receipts without retrying a write', async () => {
    const proposed = await service.prepare(p, 'profile.notifications.update', args, auth, 'uncertain');
    const original = globalThis.fetch;
    let executes = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (String(input) === business.url && body.phase === 'execute') {
        executes++;
        await original(input, init);
        throw new Error('connection lost after commit');
      }
      return original(input, init);
    });
    try {
      expect((await service.confirm(p, proposed.id, auth, 'uncertain-confirm')).state).toBe('uncertain');
      expect((await service.confirm(p, proposed.id, auth, 'uncertain-repeat')).state).toBe('uncertain');
      expect((await service.reconcile(p, proposed.id, auth, 'reconcile')).state).toBe('succeeded');
      expect(executes).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('SaaS bridge independently rejects a token with insufficient roles', async () => {
    await expect(
      service.prepare(p, 'profile.notifications.update', args, await signed(p.subject, []), 'backend-rbac'),
    ).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
  });
  it('rejects execution when policy or committed audit is unavailable', async () => {
    const blocked = new ActionService(server.db, new OpaPolicy('http://127.0.0.1:1'), () => business);
    await expect(
      blocked.prepare(p, 'profile.notifications.update', args, auth, 'policy-down'),
    ).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
    const proposal = await service.prepare(p, 'profile.notifications.update', args, auth, 'audit-down-pre');
    const spy = vi.spyOn(server.db, 'connect').mockRejectedValue(new AppError('AUDIT_UNAVAILABLE', 503));
    try {
      await expect(service.confirm(p, proposal.id, auth, 'audit-down')).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect((await service.get(p, proposal.id)).state).toBe('proposed');
  });
  it('HTTP requires explicit exact confirmation, exposes scoped history and binds CORS to project', async () => {
    const proposal = await service.prepare(p, 'profile.notifications.update', args, auth, 'http-pre');
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/actions/proposals/${proposal.id}/confirm`,
      headers: headers(),
      payload: { confirmed: true, arguments: { emailNotifications: true } },
    });
    expect(response.statusCode).toBe(400);
    const history = await server.app.inject({ url: '/api/actions/proposals', headers: headers() });
    expect(history.json().proposals.some((r: { id: string }) => r.id === proposal.id)).toBe(true);
    expect(
      (
        await server.app.inject({
          url: '/api/session',
          headers: { ...headers(), origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    const preflight = await server.app.inject({
      method: 'OPTIONS',
      url: '/api/actions/prepare',
      headers: { origin: 'https://customer.example' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://customer.example');
  });
  it('does not persist bearer tokens in proposals or audit rows', async () => {
    const records = await admin.query('SELECT * FROM core.action_proposals WHERE subject=$1', [p.subject]);
    expect(JSON.stringify(records.rows)).not.toContain(auth);
    expect((await server.db.query('SELECT * FROM core.action_proposals')).rowCount).toBe(0);
  });
});
