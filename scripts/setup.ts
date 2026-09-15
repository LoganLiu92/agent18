import { demoBridge } from './lib/demo-bridge.js';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK } from 'jose';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { localDirectory } from './config.js';

await mkdir(resolve(localDirectory, 'business-data'), { recursive: true, mode: 0o700 });
const configured = await access(resolve(localDirectory, 'compose.env'))
  .then(() => true)
  .catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
if (configured) {
  // Additive upgrade: preserve all existing keys, credentials and data.
  const migration = JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'));
  if (!migration.indexerPassword) {
    migration.indexerPassword = randomBytes(32).toString('hex');
    for (const file of ['migration.json', 'migration.docker.json']) {
      const existing = JSON.parse(await readFile(resolve(localDirectory, file), 'utf8'));
      await writeFile(
        resolve(localDirectory, file),
        JSON.stringify({ ...existing, indexerPassword: migration.indexerPassword }, null, 2) + '\n',
        { mode: 0o600 },
      );
    }
    const url = new URL(migration.adminDatabaseUrl);
    url.username = 'agent18_indexer';
    url.password = migration.indexerPassword;
    await writeFile(
      resolve(localDirectory, 'indexer.json'),
      JSON.stringify({ databaseUrl: url.toString() }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  console.log('Local configuration ready; existing keys and data preserved.');
  process.exit(0);
}
await mkdir(localDirectory, { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString('hex');
const adminPassword = secret(),
  appPassword = secret(),
  queuePassword = secret(),
  indexerPassword = secret(),
  workerToken = secret();
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'local-demo-1', alg: 'EdDSA', use: 'sig' };
const project = {
  organizationId: '00000000-0000-4000-8000-000000000018',
  projectId: '10000000-0000-4000-8000-000000000018',
  key: 'invoice-demo',
  issuer: 'urn:agent18:demo-saas',
  audience: 'agent18:support',
  jwks: { keys: [publicJwk] },
};
const projects = [
  {
    ...project,
    displayName: 'Aurora 支持中心',
    allowedOrigins: ['http://localhost:4319'],
    businessBridge: demoBridge(),
  },
  { ...project, key: 'other-demo', projectId: '20000000-0000-4000-8000-000000000018' },
];
const config = {
  databaseUrl: `postgresql://agent18_app:${appPassword}@127.0.0.1:54328/agent18`,
  queueDatabaseUrl: `postgresql://agent18_queue:${queuePassword}@127.0.0.1:54328/agent18`,
  opaUrl: 'http://127.0.0.1:8188',
  workerToken,
  consoleOrigin: 'http://localhost:4318',
  projects,
};
const dockerConfig = {
  ...config,
  projects: config.projects.map((p) => ({
    ...p,
    ...('businessBridge' in p ? { businessBridge: demoBridge(true) } : {}),
  })),
  databaseUrl: config.databaseUrl.replace('127.0.0.1:54328', 'postgres:5432'),
  queueDatabaseUrl: config.queueDatabaseUrl.replace('127.0.0.1:54328', 'postgres:5432'),
  opaUrl: 'http://opa:8181',
};
const write = (name: string, content: unknown) =>
  writeFile(
    resolve(localDirectory, name),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n',
    { mode: 0o600 },
  );
await write('server.json', config);
await write('server.docker.json', dockerConfig);
await write('worker.json', {
  queueDatabaseUrl: config.queueDatabaseUrl,
  serverUrl: 'http://127.0.0.1:4318',
  workerToken,
});
await write('worker.docker.json', {
  queueDatabaseUrl: dockerConfig.queueDatabaseUrl,
  serverUrl: 'http://server:4318',
  workerToken,
});
await write('identity.json', { privateJwk: await exportJWK(privateKey), publicJwk });
await write('migration.json', {
  adminDatabaseUrl: `postgresql://postgres:${adminPassword}@127.0.0.1:54328/agent18`,
  appPassword,
  queuePassword,
  indexerPassword,
});
await write('migration.docker.json', {
  adminDatabaseUrl: `postgresql://postgres:${adminPassword}@postgres:5432/agent18`,
  appPassword,
  queuePassword,
  indexerPassword,
});
await write('indexer.json', {
  databaseUrl: `postgresql://agent18_indexer:${indexerPassword}@127.0.0.1:54328/agent18`,
});
await write('postgres-password', adminPassword);
// Compose environment contains paths only. Secrets are file-mounted, never placed in image layers.
await write(
  'compose.env',
  `AGENT18_LOCAL_DIR=${localDirectory}\nAGENT18_UID=${userInfo().uid}\nAGENT18_GID=${userInfo().gid}\n`,
);
console.log('Created local demo keys and database credentials in .local/ (gitignored). Run pnpm demo:start.');
