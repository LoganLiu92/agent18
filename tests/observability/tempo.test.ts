import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { observabilityProvider, configurationHash } from '@agent18/observability';
import { operationsConfigSchema } from '@agent18/observability/config';
import { parseTempoTrace } from '../../providers/observability/src/tempo.js';
describe('Tempo OTLP trace scope contract', () => {
  const scope = {
      organizationId: randomUUID(),
      projectId: randomUUID(),
      tenantId: 'alpha',
      subject: 'alice',
    },
    trace = 'a'.repeat(32);
  let mode = 'normal',
    calls = 0,
    url = '',
    header = '',
    path = '';
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const payload = () => ({
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute('service.namespace', 'shop'),
            attribute('tenant.id', mode === 'cross' ? 'beta' : 'alpha'),
            attribute('service.name', 'checkout'),
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: mode === 'wrongtrace' ? 'b'.repeat(32) : trace,
                spanId: '1'.repeat(16),
                name: 'payment password=synthetic-secret',
                startTimeUnixNano: String(BigInt(Date.now() - 2000) * 1000000n),
                endTimeUnixNano: String(BigInt(Date.now() - 1000) * 1000000n),
                status: { code: 2 },
                attributes: [attribute('user.id', 'alice')],
              },
            ],
          },
        ],
      },
    ],
  });
  const server = createServer((req, res) => {
    calls++;
    path = req.url!;
    header = String(req.headers['x-scope-orgid']);
    if (mode === 'missing') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(mode === 'large' ? 'x'.repeat(270000) : JSON.stringify(payload()));
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const config = () =>
    operationsConfigSchema.parse({
      enabled: true,
      checks: [
        {
          id: 'trace',
          kind: 'tempo',
          title: 'Trace',
          url,
          projectAttributes: { 'service.namespace': 'shop' },
          tenantAttribute: 'tenant.id',
          subjectAttribute: 'user.id',
          tenantHeaders: { alpha: 'backend-alpha' },
        },
      ],
    });
  const invoke = (changes: Record<string, unknown> = {}) => {
    const c = config();
    return observabilityProvider(() => c).tools[0]!.invoke(
      {
        checkId: 'trace',
        configHash: configurationHash(c),
        mode: 'case',
        traceId: trace,
        observedAt: new Date().toISOString(),
        ...changes,
      },
      { scope, requestId: 'test', signal: AbortSignal.timeout(3000) },
    );
  };
  it('correlates exact trace and all span scopes with bounded engineering evidence', async () => {
    mode = 'normal';
    const result = await invoke();
    expect(header).toBe('backend-alpha');
    expect(path).toContain('/api/traces/' + trace);
    expect(result).toHaveLength(2);
    expect(result[0]!.resource.namespace).toBe('alert');
    expect(result.every((x) => x.visibility === 'ENGINEERING')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });
  it('rejects cross tenant and wrong trace; missing capture and expired trace remain unknown', async () => {
    for (mode of ['cross', 'wrongtrace'])
      await expect(invoke()).rejects.toThrow('OBSERVABILITY_SCOPE_REJECTED');
    mode = 'missing';
    expect((await invoke())[0]!.resource.namespace).toBe('unknown');
    const previous = calls;
    expect((await invoke({ traceId: undefined }))[0]!.resource.namespace).toBe('unknown');
    expect(calls).toBe(previous);
    mode = 'large';
    await expect(invoke()).rejects.toThrow('OBSERVABILITY_RESPONSE_TOO_LARGE');
  });
  it('rejects ambiguous duplicate attributes, stale time and invalid encoded span ids', () => {
    mode = 'normal';
    const c = {
      projectAttributes: { 'service.namespace': 'shop' },
      tenantAttribute: 'tenant.id',
      windowMinutes: 10,
    };
    let data = payload();
    data.resourceSpans[0]!.resource.attributes.push(attribute('tenant.id', 'alpha'));
    expect(() => parseTempoTrace(data, trace, scope, c, new Date().toISOString())).toThrow(
      'TRACE_ATTRIBUTES_AMBIGUOUS',
    );
    data = payload();
    data.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano = '1';
    expect(() => parseTempoTrace(data, trace, scope, c, new Date().toISOString())).toThrow(
      'OBSERVABILITY_TIME_REJECTED',
    );
    data = payload();
    data.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.spanId = '!!!';
    expect(() => parseTempoTrace(data, trace, scope, c, new Date().toISOString())).toThrow(
      'TRACE_ID_INVALID',
    );
  });
});
