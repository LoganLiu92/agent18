import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@agent18/persistence';
import { enqueueObservation } from '@agent18/application';
import { readConfig, localDirectory } from './config.js';
import { Agent18 } from '@agent18/web-sdk';

const config = readConfig(),
  project = config.projects.find((p) => p.key === 'invoice-demo');
assert.ok(
  project?.operations?.enabled && project.issuer === 'urn:agent18:demo-saas',
  'Run pnpm observability:demo first; this test is only for the synthetic local demo',
);
const db = new Pool({
  connectionString: JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'))
    .adminDatabaseUrl,
});
const steps: string[] = [];
const pass = (step: string) => {
  steps.push(step);
  console.log('PASS: ' + step);
};
async function demo(path: string, body = {}) {
  const r = await fetch('http://127.0.0.1:4319' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return r.json();
}
async function until<T>(read: () => Promise<T>, valid: (v: T) => boolean, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await read();
    if (valid(v)) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('OBSERVATION_ACCEPTANCE_TIMEOUT');
}
async function metric(expected: number) {
  await until(
    async () => {
      const url = new URL('http://127.0.0.1:39090/api/v1/query');
      url.searchParams.set('query', 'agent18_demo_service_healthy{job="agent18-demo"}');
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return (await r.json()).data?.result?.[0]?.value?.[1];
    },
    (v) => Number(v) === expected,
    30000,
  );
}
async function report(jobId: string) {
  return until(
    async () =>
      (
        await db.query(
          'SELECT j.state,r.payload FROM control.observation_jobs j LEFT JOIN core.observation_reports r ON j.id=r.job_id WHERE j.id=$1',
          [jobId],
        )
      ).rows[0],
    (r) => {
      assert.ok(!['failed', 'cancelled'].includes(r?.state), 'job failed or cancelled');
      return r?.state === 'completed';
    },
  );
}
async function inspect() {
  const client = await db.connect();
  try {
    const jobId = await enqueueObservation(
      client,
      { ...project!, tenantId: '__operations__', subject: '__owner__' },
      project!.operations!,
      'inspection',
      'acceptance:' + crypto.randomUUID(),
    );
    return (await report(jobId!)).payload;
  } finally {
    client.release();
  }
}
try {
  const identity = await demo('/token', { profile: 'aurora' });
  const sdk = new Agent18({
    baseUrl: 'http://127.0.0.1:4318',
    projectKey: 'invoice-demo',
    getToken: async () => identity.token,
    capture: { enabled: false },
  });
  const fault = await demo('/simulate-error', { profile: 'aurora' });
  assert.equal(fault.logged, true, 'real Loki push must succeed');
  await metric(0);
  pass('Synthetic business error ingested by real Loki; real Prometheus scraped the failure');
  sdk.setContext({
    pageUrl: 'http://localhost:4319/example?token=omit',
    route: 'order-detail',
    entity: { type: 'order', id: 'ORD-1042' },
  });
  sdk.emit({
    type: 'business.operation.failed',
    operation: 'order.save',
    errorCode: 'ORDER_SAVE_TIMEOUT',
    traceId: fault.traceId,
  });
  assert.equal((await sdk.routeConversation({ message: '为什么不行', history: [] })).kind, 'support');
  const key = crypto.randomUUID(),
    input = {
      title: '可观测性闭环验收',
      description: '演示订单保存失败，关联真实 Loki 日志与 Prometheus 指标。',
      capture: {
        capturedAt: new Date().toISOString(),
        page: { title: 'Demo', path: '/example', language: 'zh-CN', width: 1200, height: 800, online: true },
        text: 'Synthetic context',
        errors: ['ORDER_SAVE_TIMEOUT'],
        breadcrumbs: [],
        requests: [],
        notice: 'Synthetic automated capture; real browser checked separately.',
      },
    };
  const created = await sdk.reportCase(input, key);
  assert.equal((await sdk.reportCase(input, key)).case.id, created.case.id);
  const job = (await db.query('SELECT id FROM control.observation_jobs WHERE case_id=$1', [created.case.id]))
    .rows;
  assert.equal(job.length, 1);
  const investigation = (await report(job[0].id)).payload;
  assert.equal(investigation.results.length, 3);
  assert.ok(
    investigation.results.every((r: { state: string }) => r.state === 'alert'),
    JSON.stringify(
      investigation.results.map((r: { checkId: string; state: string; error: string }) => ({
        id: r.checkId,
        state: r.state,
        error: r.error,
      })),
    ),
  );
  assert.ok(JSON.stringify(investigation).includes(fault.traceId));
  const detail = await sdk.getCase(created.case.id);
  assert.equal(detail.investigation?.state, 'completed');
  assert.ok(!JSON.stringify(detail.investigation).includes(fault.traceId));
  const otherIdentity = await demo('/token', { profile: 'colleague' });
  const other = new Agent18({
    baseUrl: 'http://127.0.0.1:4318',
    projectKey: 'invoice-demo',
    getToken: async () => otherIdentity.token,
    capture: { enabled: false },
  });
  await assert.rejects(() => other.getCase(created.case.id));
  pass(
    'Semantic failure routed to support and one durable Case investigation linked its scoped Loki trace and actual HTTP/metric failures; customer sees safe summary, other subject denied',
  );
  await inspect();
  await inspect();
  const incidents = (
    await db.query(
      'SELECT check_id,state,occurrences FROM control.observation_incidents WHERE project_id=$1 AND check_id IN ($2,$3,$4)',
      [project!.projectId, 'demo-health', 'demo-errors', 'demo-metrics'],
    )
  ).rows;
  assert.equal(incidents.length, 3);
  assert.ok(incidents.every((i) => i.state !== 'resolved' && i.occurrences >= 2));
  pass('Repeated real inspections merge into three persistent incidents');
  await demo('/recover-demo');
  await metric(1);
  const recovered = await inspect();
  assert.ok(
    recovered.results
      .filter((r: { checkId: string }) => r.checkId !== 'demo-errors')
      .every((r: { state: string }) => r.state === 'healthy'),
  );
  pass(
    'HTTP and Prometheus recovery resolves their incidents; Loki retains errors until the configured time window expires',
  );
  await until(
    async () =>
      (await inspect()).results.find((r: { checkId: string }) => r.checkId === 'demo-errors')?.state,
    (s) => s === 'healthy',
    100000,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM control.observation_incidents WHERE project_id=$1 AND check_id IN ('demo-health','demo-errors','demo-metrics') AND state <> 'resolved'",
        [project!.projectId],
      )
    ).rows[0].n,
    0,
  );
  pass('Loki window expires and the final incident resolves from fresh healthy evidence');
  await mkdir('.local/release', { recursive: true });
  await writeFile(
    '.local/release/observability-acceptance.json',
    JSON.stringify(
      { passed: true, at: new Date().toISOString(), components: ['Loki 3.7.7', 'Prometheus 3.14.0'], steps },
      null,
      2,
    ) + '\n',
  );
  sdk.destroy();
  other.destroy();
} finally {
  await demo('/recover-demo').catch(() => {});
  await db.end();
}
