import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { observabilityProvider, configurationHash } from '@agent18/observability';
import { operationsConfigSchema } from '@agent18/observability/config';
const exec = promisify(execFile),
  root = await mkdtemp(resolve('.local/tempo-check-')),
  name = 'agent18-tempo-qa-' + randomBytes(4).toString('hex');
let created = false;
try {
  await writeFile(
    join(root, 'tempo.yaml'),
    `multitenancy_enabled: true
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
storage:
  trace:
    backend: local
    wal:
      path: /tmp/tempo/wal
    local:
      path: /tmp/tempo/blocks
usage_report:
  reporting_enabled: false
`,
  );
  const image = process.env.AGENT18_TEMPO_IMAGE ?? 'grafana/tempo:3.0.0';
  await exec('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--memory',
    '512m',
    '-p',
    '127.0.0.1::3200',
    '-p',
    '127.0.0.1::4318',
    '-v',
    root + ':/config:ro',
    image,
    '-target=all',
    '-config.file=/config/tempo.yaml',
  ]);
  created = true;
  const state = JSON.parse((await exec('docker', ['inspect', name])).stdout)[0],
    port = (p: string) => state.NetworkSettings.Ports[p][0].HostPort,
    url = 'http://127.0.0.1:' + port('3200/tcp'),
    ingest = 'http://127.0.0.1:' + port('4318/tcp');
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(url + '/ready', { signal: AbortSignal.timeout(1000) })).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw Error('TEMPO_NOT_READY');
  const trace = randomBytes(16).toString('hex'),
    span = randomBytes(8).toString('hex'),
    now = Date.now(),
    attrs = (raw: Record<string, string>) =>
      Object.entries(raw).map(([key, stringValue]) => ({ key, value: { stringValue } }));
  const push = await fetch(ingest + '/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-scope-orgid': 'isolated-traces' },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: attrs({
              'service.namespace': 'qa-shop',
              'service.name': 'checkout',
              'tenant.id': 'qa-tenant',
            }),
          },
          scopeSpans: [
            {
              scope: { name: 'agent18-verification' },
              spans: [
                {
                  traceId: trace,
                  spanId: span,
                  name: 'checkout failed',
                  kind: 2,
                  startTimeUnixNano: String(BigInt(now - 2000) * 1000000n),
                  endTimeUnixNano: String(BigInt(now - 1000) * 1000000n),
                  status: { code: 2 },
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  if (!push.ok) throw Error('OTLP_INGEST_FAILED_' + push.status);
  const config = operationsConfigSchema.parse({
      enabled: true,
      checks: [
        {
          id: 'tempo',
          title: 'Reference Tempo',
          kind: 'tempo',
          url,
          projectAttributes: { 'service.namespace': 'qa-shop' },
          tenantAttribute: 'tenant.id',
          tenantHeaders: { 'qa-tenant': 'isolated-traces' },
        },
      ],
    }),
    scope = {
      organizationId: randomUUID(),
      projectId: randomUUID(),
      tenantId: 'qa-tenant',
      subject: 'customer',
    },
    tool = observabilityProvider(() => config).tools[0]!;
  let evidence: Awaited<ReturnType<typeof tool.invoke>> = [];
  for (let i = 0; i < 20; i++) {
    evidence = await tool.invoke(
      {
        checkId: 'tempo',
        mode: 'case',
        configHash: configurationHash(config),
        traceId: trace,
        observedAt: new Date(now).toISOString(),
      },
      { scope, requestId: randomUUID(), signal: AbortSignal.timeout(5000) },
    );
    if (evidence.length > 1) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (evidence.length !== 2 || evidence[0]!.resource.namespace !== 'alert')
    throw Error('TRACE_CORRELATION_FAILED');
  const missing = await tool.invoke(
    {
      checkId: 'tempo',
      mode: 'case',
      configHash: configurationHash(config),
      traceId: 'f'.repeat(32),
      observedAt: new Date().toISOString(),
    },
    { scope, requestId: randomUUID(), signal: AbortSignal.timeout(5000) },
  );
  if (missing[0]!.resource.namespace !== 'unknown') throw Error('MISSING_TRACE_NOT_UNKNOWN');
  console.log(
    JSON.stringify({
      passed: true,
      image,
      digest: state.Image,
      otlpIngest: true,
      correlatedSpans: evidence.length - 1,
      missingTrace: 'unknown',
      scope: 'isolated-traces / qa-tenant',
    }),
  );
} finally {
  if (created) await exec('docker', ['rm', '-f', name]);
  await rm(root, { recursive: true, force: true });
}
