import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSetupApp } from '../../apps/setup/src/app.js';
let directory: string, app: Awaited<ReturnType<typeof buildSetupApp>>;
const headers = {
  host: 'localhost:4321',
  origin: 'http://localhost:4321',
  authorization: 'Bearer test-owner-access-token',
};
const config = {
  databaseUrl: 'postgresql://unused',
  queueDatabaseUrl: 'postgresql://unused',
  opaUrl: 'http://127.0.0.1:8188',
  workerToken: 'worker-secret-that-must-not-be-returned',
  consoleOrigin: 'http://localhost:4318',
  projects: [
    {
      key: 'example',
      organizationId: '00000000-0000-4000-8000-000000000018',
      projectId: '10000000-0000-4000-8000-000000000018',
      issuer: 'urn:saas',
      audience: 'agent18:support',
      jwks: { keys: [] },
    },
  ],
};
const model = { baseUrl: 'http://localhost:45888/v1', name: 'local-model', apiKey: 'test-secret-key' };
const apply = vi.fn(async () => {});
beforeEach(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'agent18-owner-'));
  for (const name of ['server.json', 'server.docker.json'])
    await writeFile(resolve(directory, name), JSON.stringify(config));
  await writeFile(resolve(directory, 'index.html'), '<html>local setup</html>');
  apply.mockClear();
  app = await buildSetupApp({ directory, token: 'test-owner-access-token', root: directory, apply });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
it('requires local host, local client, exact origin and owner authentication', async () => {
  for (const [patch, code] of [
    [{ authorization: 'Bearer customer-token' }, 401],
    [{ host: 'attacker.example:4321' }, 403],
    [{ origin: 'https://attacker.example' }, 403],
    [{ origin: 'null' }, 403],
  ] as const) {
    expect((await app.inject({ url: '/owner/state', headers: { ...headers, ...patch } })).statusCode).toBe(
      code,
    );
  }
  expect((await app.inject({ url: '/owner/state', headers, remoteAddress: '192.0.2.10' })).statusCode).toBe(
    403,
  );
  for (const url of ['/owner/%73tate', '/%6fwner/state', '/owner%2fstate'])
    expect((await app.inject({ url, headers: { host: 'localhost:4321' } })).statusCode).not.toBe(200);
  const publicPage = await app.inject({ url: '/setup', headers: { host: 'localhost:4321' } });
  expect(publicPage.statusCode).toBe(200);
  expect(publicPage.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect((await app.inject({ url: '/owner/state', headers })).statusCode).toBe(200);
  expect(app.printRoutes()).not.toContain('/shell');
});
it('saves model settings without returning secrets and preserves a masked existing key', async () => {
  expect(
    (await app.inject({ method: 'POST', url: '/owner/model', headers, payload: model })).statusCode,
  ).toBe(200);
  expect((await stat(resolve(directory, 'model.env'))).mode & 0o777).toBe(0o600);
  const state = await app.inject({ url: '/owner/state', headers });
  expect(state.json().model).toMatchObject({ configured: true, name: 'local-model' });
  expect(state.body).not.toContain(model.apiKey);
  expect(state.body).not.toContain(config.workerToken);
  expect(state.body).not.toContain(config.databaseUrl);
  await app.inject({
    method: 'POST',
    url: '/owner/model',
    headers,
    payload: { ...model, apiKey: '', name: 'updated-model' },
  });
  const env = parseEnv(await readFile(resolve(directory, 'model.env'), 'utf8'));
  expect(env.AGENT18_MODEL_API_KEY).toBe(model.apiKey);
  expect(env.AGENT18_MODEL_NAME).toBe('updated-model');
});
it('connection test uses the owner-supplied candidate without saving it or returning provider errors', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"connected":true}' } }] }),
  );
  vi.stubGlobal('fetch', fetch);
  const connected = await app.inject({ method: 'POST', url: '/owner/model/test', headers, payload: model });
  expect(connected.json()).toEqual({ connected: true });
  await expect(readFile(resolve(directory, 'model.env'))).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockImplementationOnce(async () => new Response('sensitive-provider-error', { status: 401 }));
  const failure = await app.inject({ method: 'POST', url: '/owner/model/test', headers, payload: model });
  expect(failure.statusCode).toBe(400);
  expect(failure.json().error.code).toBe('MODEL_AUTH_FAILED');
  expect(failure.body).not.toContain('sensitive');
});
it('denies private identity keys and invalid models before changing configuration', async () => {
  const initial = await readFile(resolve(directory, 'server.json'), 'utf8');
  const invalid = await app.inject({
    method: 'POST',
    url: '/owner/project',
    headers,
    payload: {
      project: {
        ...config.projects[0],
        jwks: { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'private', x: 'key', d: 'private-material' }] },
      },
      organizationName: 'Example',
      projectName: 'Example',
      tenants: [{ id: 'test', name: 'Test' }],
    },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.body).not.toContain('private-material');
  expect(await readFile(resolve(directory, 'server.json'), 'utf8')).toBe(initial);
  for (const baseUrl of [
    'http://remote.example/v1',
    'https://user:secret@example.com',
    'https://example.com?secret=key',
  ])
    expect(
      (await app.inject({ method: 'POST', url: '/owner/model', headers, payload: { ...model, baseUrl } }))
        .statusCode,
    ).toBe(400);
});
it('only applies validated owner settings and never accepts a browser command', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/owner/apply',
        headers: { ...headers, authorization: 'Bearer customer' },
        payload: { displayName: 'Example' },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/owner/apply',
        headers,
        payload: { displayName: 'Example', command: 'touch /tmp/unwanted' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/owner/apply',
        headers,
        payload: { displayName: 'Example', coreUrl: 'https://support.example/path' },
      })
    ).statusCode,
  ).toBe(400);
  expect(apply).not.toHaveBeenCalled();
  const result = await app.inject({
    method: 'POST',
    url: '/owner/apply',
    headers,
    payload: { displayName: 'Example', coreUrl: 'https://support.example' },
  });
  expect(result.json()).toEqual({ saved: true, applied: true });
  expect(apply).toHaveBeenCalledOnce();
  for (const file of ['server.json', 'server.docker.json'])
    expect(JSON.parse(await readFile(resolve(directory, file), 'utf8'))).toMatchObject({
      setupCompleted: true,
      displayName: 'Example',
      consoleOrigin: 'https://support.example',
      workerToken: config.workerToken,
    });
});
it('keeps saved settings and reports a failed restart truthfully', async () => {
  apply.mockRejectedValueOnce(new Error('docker output must not leak'));
  const result = await app.inject({
    method: 'POST',
    url: '/owner/apply',
    headers,
    payload: { displayName: 'Saved' },
  });
  expect(result.json()).toEqual({ error: { code: 'SETTINGS_SAVED_RESTART_FAILED' } });
  expect(JSON.parse(await readFile(resolve(directory, 'server.json'), 'utf8')).displayName).toBe('Saved');
});
it('does not re-bootstrap and replace existing keys if an additive setup upgrade fails', async () => {
  await writeFile(resolve(directory, 'compose.env'), 'configured');
  await writeFile(resolve(directory, 'migration.json'), 'not valid json');
  await writeFile(resolve(directory, 'identity.json'), 'preserve-existing-key');
  await expect(
    promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/setup.ts'], {
      env: { ...process.env, AGENT18_LOCAL_DIR: directory },
    }),
  ).rejects.toThrow();
  expect(await readFile(resolve(directory, 'identity.json'), 'utf8')).toBe('preserve-existing-key');
  expect(await readFile(resolve(directory, 'server.json'), 'utf8')).toBe(JSON.stringify(config));
});

it('a fresh installation includes the working demo entry and keeps its generated identity on a second setup', async () => {
  await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/setup.ts'], {
    env: { ...process.env, AGENT18_LOCAL_DIR: directory },
  });
  const host = JSON.parse(await readFile(resolve(directory, 'server.json'), 'utf8'));
  const docker = JSON.parse(await readFile(resolve(directory, 'server.docker.json'), 'utf8'));
  expect(host.projects[0].allowedOrigins).toContain('http://localhost:4319');
  expect(host.projects[0].businessBridge.url).toBe('http://127.0.0.1:4319/agent18/bridge');
  expect(docker.projects[0].businessBridge.url).toBe('http://identity-demo:4319/agent18/bridge');
  expect(host.projects[0].businessBridge.actions[0].roles).toEqual(['tenant-admin']);
  const identity = await readFile(resolve(directory, 'identity.json'), 'utf8');
  await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/setup.ts'], {
    env: { ...process.env, AGENT18_LOCAL_DIR: directory },
  });
  expect(await readFile(resolve(directory, 'identity.json'), 'utf8')).toBe(identity);
});
