import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pool } from '@agent18/persistence';
import { KnowledgeIndexer, sourceSchema } from '@agent18/knowledge';
import { createBackup, restoreBackup, activateRestore } from './lib/backup.js';
import { buildSetupApp } from '../apps/setup/src/app.js';
const execute = promisify(execFile),
  root = await mkdtemp(join(tmpdir(), 'agent18-journey-')),
  name = 'agent18-journey-' + randomBytes(4).toString('hex');
const core = 'http://127.0.0.1:14318',
  saas = 'http://127.0.0.1:14319';
const env = { ...process.env, AGENT18_LOCAL_DIR: root, AGENT18_STACK_NAME: name };
const compose = [
  'compose',
  '--project-name',
  name,
  '--env-file',
  join(root, 'compose.env'),
  '-f',
  'deploy/compose/compose.yaml',
  '-f',
  join(root, 'ports.yaml'),
  '--profile',
  'demo',
];
const log: { step: string; passed: boolean }[] = [];
const pass = (step: string) => {
  log.push({ step, passed: true });
  console.log('✓ ' + step);
};
let owner: Awaited<ReturnType<typeof buildSetupApp>> | undefined, pool: InstanceType<typeof Pool> | undefined;
let composeStarted = false;
try {
  await execute('pnpm', ['run', 'setup'], { env, timeout: 30000 });
  for (const file of ['server.json', 'server.docker.json']) {
    const c = JSON.parse(await readFile(join(root, file), 'utf8'));
    c.consoleOrigin = core;
    c.projects[0].allowedOrigins = ['http://localhost:14319'];
    if (file === 'server.json') {
      c.databaseUrl = c.databaseUrl.replace(':54328/', ':15432/');
      c.queueDatabaseUrl = c.queueDatabaseUrl.replace(':54328/', ':15432/');
      c.opaUrl = 'http://127.0.0.1:18188';
    }
    await writeFile(join(root, file), JSON.stringify(c), { mode: 0o600 });
  }
  for (const file of ['migration.json', 'indexer.json']) {
    const text = (await readFile(join(root, file), 'utf8')).replaceAll(':54328/', ':15432/');
    await writeFile(join(root, file), text, { mode: 0o600 });
  }
  await writeFile(
    join(root, 'ports.yaml'),
    `services:\n  postgres:\n    ports: !override ['127.0.0.1:15432:5432']\n  opa:\n    ports: !override ['127.0.0.1:18188:8181']\n  server:\n    ports: !override ['127.0.0.1:14318:4318']\n  identity-demo:\n    ports: !override ['127.0.0.1:14319:4319']\n`,
  );
  // The stack name is stored so backup/restore target this isolated project as well.
  await writeFile(
    join(root, 'compose.env'),
    (await readFile(join(root, 'compose.env'), 'utf8')) + `\nAGENT18_STACK_NAME=${name}\n`,
  );
  composeStarted = true;
  await execute('docker', [...compose, 'up', '-d', '--wait'], { env, timeout: 180000, maxBuffer: 1000000 });
  pass('Clean configuration, migrations and isolated Compose startup');
  const config = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));
  pool = new Pool({
    connectionString: JSON.parse(await readFile(join(root, 'indexer.json'), 'utf8')).databaseUrl,
  });
  const sourceDir = join(root, 'sources');
  await mkdir(sourceDir);
  await writeFile(
    join(sourceDir, 'guide.md'),
    '# JourneyOrderStatus\nJourneyOrderStatus 订单处理中时，请打开订单详情查看最新处理状态。',
  );
  const indexer = new KnowledgeIndexer(
    pool,
    { ...config.projects[0], tenantId: 'operator', subject: 'journey' },
    join(root, 'git-cache'),
  );
  const source = sourceSchema.parse({
    id: 'journey-guide',
    name: 'Journey product guide',
    kind: 'directory',
    location: sourceDir,
    audience: 'customer',
    tenantIds: [],
  });
  const draft = await indexer.sync(source, { mode: 'extractive', maxModelCalls: 1 });
  await indexer.publish(draft.buildId);
  assert.equal(
    (await indexer.sync(source, { mode: 'extractive', maxModelCalls: 1, skipUnchanged: true })).unchanged,
    true,
  );
  await pool.end();
  pool = undefined;
  for (const file of ['server.json', 'server.docker.json']) {
    const c = JSON.parse(await readFile(join(root, file), 'utf8'));
    c.projects[0].knowledge = 'indexed';
    c.setupCompleted = true;
    await writeFile(join(root, file), JSON.stringify(c), { mode: 0o600 });
  }
  await execute('docker', [...compose, 'up', '-d', '--no-deps', '--force-recreate', '--wait', 'server'], {
    env,
    timeout: 120000,
    maxBuffer: 1000000,
  });
  const diagnosis = await execute('pnpm', ['--silent', 'run', 'doctor', '--json'], {
    env,
    timeout: 30000,
  });
  const health = JSON.parse(diagnosis.stdout);
  assert.equal(health.ready, true);
  assert.ok(
    health.checks.some(
      (check: { id: string; status: string }) => check.id === 'rls' && check.status === 'pass',
    ),
  );
  const identity = async (profile: string) => {
    const r = await fetch(saas + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    assert.equal(r.status, 200);
    return (await r.json()).token as string;
  };
  const alice = await identity('aurora'),
    bob = await identity('colleague'),
    nina = await identity('northwind');
  const api = async (path: string, body?: unknown, token = alice, key?: string, status = 200) => {
    const r = await fetch(core + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'x-project-key': 'invoice-demo',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, status, path);
    return r.json();
  };
  const answer = await api('/api/knowledge/ask', { query: 'JourneyOrderStatus' });
  assert.equal(answer.mode, 'retrieval_only');
  assert.ok(answer.citations.length > 0);
  pass('Source import, explicit publication, unchanged build reuse and cited retrieval');
  assert.equal((await api('/api/business/query', { queryId: 'orders.list', arguments: {} })).rows.length, 2);
  for (const token of [bob, nina])
    await api(
      '/api/business/query',
      { queryId: 'orders.get', arguments: { orderId: 'ORD-1001' } },
      token,
      undefined,
      404,
    );
  pass('Real SaaS queries with same-tenant and cross-tenant object isolation');
  const proposal = await api('/api/actions/prepare', {
    actionId: 'profile.notifications.update',
    arguments: { emailNotifications: false },
  });
  assert.equal(proposal.state, 'proposed');
  assert.equal(
    (await api('/api/business/query', { queryId: 'preferences.get', arguments: {} })).rows[0]
      .emailNotifications,
    true,
  );
  assert.equal(
    (await api(`/api/actions/proposals/${proposal.id}/confirm`, { confirmed: true })).state,
    'succeeded',
  );
  const after = await api('/api/business/query', { queryId: 'preferences.get', arguments: {} });
  assert.equal(after.rows[0].emailNotifications, false);
  assert.equal(after.rows[0].revision, 1);
  assert.equal(
    (await api(`/api/actions/proposals/${proposal.id}/confirm`, { confirmed: true })).state,
    'succeeded',
  );
  assert.equal(
    (await api('/api/business/query', { queryId: 'preferences.get', arguments: {} })).rows[0].revision,
    1,
  );
  pass('Preview without mutation, confirmation, durable receipt and read-after-write verification');
  const reported = await api(
      '/api/cases',
      {
        title: 'JourneyOrderStatus needs help',
        description: 'JourneyOrderStatus requires follow-up',
        context: {},
      },
      alice,
      randomUUID(),
      201,
    ),
    caseId = reported.case.id;
  let detail;
  for (let i = 0; i < 30; i++) {
    detail = await api('/api/cases/' + caseId);
    if (detail.runs[0]?.state === 'completed') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(detail.runs[0].state, 'completed');
  assert.ok(detail.evidence.length > 0);
  await api(`/api/cases/${caseId}/messages`, { body: 'Customer follow-up' }, alice, randomUUID());
  await api(`/api/cases/${caseId}`, undefined, bob, undefined, 404);
  owner = await buildSetupApp({ directory: root, token: 'journey-owner-access-code', port: 14321 });
  await owner.listen({ host: '127.0.0.1', port: 14321 });
  const response = await fetch(
    `http://127.0.0.1:14321/owner/projects/invoice-demo/cases/${caseId}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer journey-owner-access-code',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ body: 'Support reply from local operator' }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await api(`/api/cases/${caseId}/messages`)).messages.map((m: any) => m.author),
    ['customer', 'support'],
  );
  assert.equal((await api(`/api/cases/${caseId}/status`, { status: 'resolved' })).case.status, 'resolved');
  pass('Real Worker investigation, customer follow-up, owner reply and resolution');
  const docs = await fetch(core + '/docs/overview');
  assert.equal(docs.status, 200);
  assert.ok((await docs.text()).includes('运行机制'));
  assert.equal((await (await fetch(core + '/openapi.json')).json()).openapi, '3.1.0');
  const snapshot = await createBackup(root);
  const restored = await restoreBackup(root, snapshot.directory, true);
  assert.equal(restored.counts.cases, 1);
  assert.equal(restored.counts.messages, 2);
  assert.equal(restored.counts.proposals, 1);
  pass('Built-in documentation, machine-readable API, real backup and isolated restore');
  const retained = await restoreBackup(root, snapshot.directory, false);
  assert.ok(retained.database);
  await activateRestore(root, retained.database);
  await execute(
    'docker',
    [...compose, 'up', '-d', '--no-deps', '--force-recreate', '--wait', 'server', 'worker'],
    { env, timeout: 120000, maxBuffer: 1000000 },
  );
  assert.equal((await api('/api/cases/' + caseId)).case.status, 'resolved');
  assert.equal((await api(`/api/cases/${caseId}/messages`)).messages.length, 2);
  assert.equal((await api(`/api/actions/proposals/${proposal.id}`)).state, 'succeeded');
  pass('Explicit activation of a verified new database with restored customer history and receipts');

  await mkdir('.local/release', { recursive: true });
  await writeFile(
    '.local/release/journey.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        steps: log,
        model: 'unconfigured; retrieval verified',
        scope: 'isolated synthetic SaaS, local Docker and PostgreSQL',
      },
      null,
      2,
    ),
  );
} finally {
  await owner?.close();
  await pool?.end();
  let cleaned = true;
  if (composeStarted)
    await execute('docker', [...compose, 'down', '--volumes', '--remove-orphans'], {
      env,
      timeout: 90000,
      maxBuffer: 1000000,
    }).catch(() => {
      cleaned = false;
      console.error('Isolated journey cleanup failed; inspect stack ' + name + ' and config ' + root);
    });
  if (cleaned) await rm(root, { recursive: true, force: true });
}
