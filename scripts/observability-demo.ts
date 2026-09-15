import { readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configSchema, localDirectory } from './config.js';
import { operationsConfigSchema } from '@agent18/observability/config';
import { atomicJson } from './lib/atomic.js';
import { startStack } from './lib/start-stack.js';

// Local synthetic invoice-demo only; never infer production URLs or log scopes.
const compose = [
  'compose',
  '--env-file',
  resolve(localDirectory, 'compose.env'),
  '-f',
  'deploy/compose/compose.yaml',
  '--profile',
  'demo',
  '--profile',
  'observability',
];
const execute = promisify(execFile);
const operations = operationsConfigSchema.parse({
  enabled: true,
  autoInvestigate: true,
  intervalSeconds: 60,
  modelAnalysis: false,
  checks: [
    {
      id: 'demo-health',
      kind: 'http',
      title: '演示业务服务',
      url: 'http://identity-demo:4319/operational-health',
    },
    {
      id: 'demo-errors',
      kind: 'loki',
      title: '业务错误日志',
      url: 'http://loki:3100',
      labels: { app: 'invoice-demo' },
      tenantLabel: 'tenant_id',
      subjectLabel: 'subject',
      contains: 'error',
      windowMinutes: 1,
    },
    {
      id: 'demo-metrics',
      kind: 'prometheus',
      title: '业务可用性指标',
      url: 'http://prometheus:9090',
      query: 'agent18_demo_service_healthy{job="agent18-demo"}',
      comparison: 'lt',
      threshold: 1,
    },
  ],
});
try {
  const updates = await Promise.all(
    ['server.json', 'server.docker.json'].map(async (file) => {
      const path = resolve(localDirectory, file),
        config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      const project = config.projects.find(
        (p) => p.key === 'invoice-demo' && p.issuer === 'urn:agent18:demo-saas',
      );
      if (!project)
        throw new Error(
          'Synthetic invoice-demo project required. Run pnpm run setup && pnpm demo:start first.',
        );
      project.operations = operations;
      return { path, config };
    }),
  );
  await execute('docker', [...compose, 'up', '-d', '--no-deps', 'loki', 'prometheus'], {
    timeout: 240000,
    maxBuffer: 4000000,
  });
  for (const url of ['http://127.0.0.1:31310/ready', 'http://127.0.0.1:39090/-/ready']) {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await fetch(url, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) throw new Error('Observability component not ready: ' + url);
  }
  for (const { path, config } of updates) {
    await copyFile(path, path + '.before-observability-' + Date.now());
    await atomicJson(path, config);
  }
  await startStack(compose, { build: false, demo: true });
  console.log(
    'Real Loki + Prometheus are connected to invoice-demo. Open http://localhost:4319/example, simulate an error and report it. Owner → 巡检与排查 shows engineering evidence. Run pnpm test:observability for full acceptance.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'OBSERVABILITY_DEMO_FAILED');
  process.exitCode = 1;
}
