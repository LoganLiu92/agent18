import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localDirectory } from './config.js';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
const execute = promisify(execFile),
  root = await mkdtemp(join(tmpdir(), 'agent18-isolated-'));
const name = 'agent18_isolated_' + randomBytes(6).toString('hex');
const original = JSON.parse(await readFile(join(localDirectory, 'migration.json'), 'utf8'));
const admin = new Pool({ connectionString: original.adminDatabaseUrl });
let created = false;
const remap = (raw: string) => {
  const u = new URL(raw);
  u.pathname = '/' + name;
  return u.href;
};
try {
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  const config = JSON.parse(await readFile(join(localDirectory, 'server.json'), 'utf8'));
  config.databaseUrl = remap(config.databaseUrl);
  config.queueDatabaseUrl = remap(config.queueDatabaseUrl);
  await writeFile(join(root, 'server.json'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(
    join(root, 'migration.json'),
    JSON.stringify({ ...original, adminDatabaseUrl: remap(original.adminDatabaseUrl) }),
    { mode: 0o600 },
  );
  const indexer = JSON.parse(await readFile(join(localDirectory, 'indexer.json'), 'utf8'));
  await writeFile(join(root, 'indexer.json'), JSON.stringify({ databaseUrl: remap(indexer.databaseUrl) }), {
    mode: 0o600,
  });
  await writeFile(join(root, 'identity.json'), await readFile(join(localDirectory, 'identity.json')), {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    AGENT18_LOCAL_DIR: root,
    AGENT18_CONFIG: join(root, 'server.json'),
    AGENT18_INTEGRATION: '1',
  };
  const migration = await execute('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'], { env, timeout: 60000 });
  console.log(migration.stdout);
  // These suites never stop active workers or call the shared demonstration server.
  const test = await execute(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      'tests/security/operators.integration.test.ts',
      'tests/knowledge/index.integration.test.ts',
      'tests/security/context.test.ts',
      'tests/knowledge/provenance.test.ts',
      'tests/security/foundation.integration.test.ts',
      'tests/connections/workflow.integration.test.ts',
      'tests/actions/delegation.integration.test.ts',
      'tests/setup/workflow.integration.test.ts',
      'tests/observability/runtime.integration.test.ts',
    ],
    { env, timeout: 180000, maxBuffer: 4000000 },
  );
  console.log(test.stdout);
} catch (error) {
  const e = error as { stdout?: string; stderr?: string };
  console.error(e.stdout ?? 'Isolated verification failed');
  console.error(e.stderr ?? '');
  process.exitCode = 1;
} finally {
  if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
