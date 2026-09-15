import Fastify from 'fastify';
import { registerDemoBusiness } from './business.js';
import { SignJWT, importJWK } from 'jose';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { localDirectory } from '../../scripts/config.js';

// Demonstration SaaS issuer, intentionally separate from Core. Never deploy this unauthenticated issuer publicly.
const config = JSON.parse(
  await readFile(process.env.AGENT18_IDENTITY_CONFIG ?? resolve(localDirectory, 'identity.json'), 'utf8'),
);
const key = await importJWK(config.privateJwk, 'EdDSA');
export const profiles = {
  aurora: { label: 'Aurora Studio', tenant: 'tenant-a', subject: 'alice', project: 'invoice-demo' },
  northwind: { label: 'Northwind Labs', tenant: 'tenant-b', subject: 'nina', project: 'invoice-demo' },
  colleague: {
    label: 'Aurora · 同租户另一用户',
    tenant: 'tenant-a',
    subject: 'bob',
    project: 'invoice-demo',
  },
  other: { label: 'Aurora · 另一项目', tenant: 'tenant-a', subject: 'alice', project: 'other-demo' },
} as const;
const app = Fastify({ logger: false, bodyLimit: 1024 });
app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (
    origin &&
    ![
      'http://localhost:4318',
      'http://127.0.0.1:4318',
      'http://localhost:5173',
      'http://localhost:4319',
      'http://127.0.0.1:4319',
    ].includes(origin)
  )
    return reply.code(403).send({ error: 'ORIGIN_DENIED' });
  if (origin) reply.header('access-control-allow-origin', origin).header('vary', 'origin');
  reply
    .header('cache-control', 'no-store')
    .header('access-control-allow-headers', 'content-type')
    .header('access-control-allow-methods', 'POST, OPTIONS');
  if (request.method === 'OPTIONS') return reply.code(204).send();
});
app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: 'INVALID_DEMO_PROFILE' }));
app.get('/example', async (_request, reply) =>
  reply.type('text/html; charset=utf-8').send(await readFile('examples/embedded-site/index.html', 'utf8')),
);
app.get('/health', async () => ({ status: 'ok', mode: 'LOCAL_DEMO_ONLY' }));
app.options('/token', async (_request, reply) => reply.code(204).send());
app.post('/token', async (request) => {
  const input = z
    .object({ profile: z.enum(['aurora', 'northwind', 'colleague', 'other']) })
    .strict()
    .parse(request.body);
  const profile = profiles[input.profile];
  const token = await new SignJWT({
    kind: 'customer',
    tenant_id: profile.tenant,
    project_key: profile.project,
    roles: ['tenant-admin'],
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: config.publicJwk.kid })
    .setSubject(profile.subject)
    .setIssuer('urn:agent18:demo-saas')
    .setAudience('agent18:support')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
  return { token, projectKey: profile.project, label: profile.label };
});
registerDemoBusiness(
  app,
  process.env.AGENT18_DEMO_BUSINESS_DB ?? resolve(localDirectory, 'business-data/preferences.sqlite'),
  { keys: [config.publicJwk] },
);
await app.listen({ host: process.env.AGENT18_HOST ?? '127.0.0.1', port: 4319 });
console.log('agent18 demo identity issuer listening on port 4319; development only');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
