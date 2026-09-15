import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { observabilityProvider, configurationHash, redact } from '@agent18/observability';
import { operationsConfigSchema, type OperationsConfig } from '@agent18/observability/config';
import { pageCaptureSchema } from '@agent18/contracts';

describe('real HTTP observability contracts', () => {
  let url: string,
    mode = 'normal',
    query = '',
    tenantHeader = '';
  const trace = 'a'.repeat(32),
    scope = {
      organizationId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      tenantId: 'tenant-a',
      subject: 'alice',
    };
  const server = createServer((req, res) => {
    const path = new URL(req.url!, url);
    query = path.searchParams.get('query') ?? '';
    tenantHeader = String(req.headers['x-scope-orgid'] ?? '');
    if (path.pathname === '/health') {
      res.writeHead(mode === 'down' ? 503 : 200);
      res.end('health body must not be evidence');
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(302, { location: url + '/health' });
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (mode === 'large') {
      res.end('x'.repeat(270000));
      return;
    }
    if (path.pathname.includes('loki')) {
      const stamp = String(BigInt(Date.now() - 1000) * 1000000n);
      res.end(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: {
                  app: 'store',
                  tenant_id: mode === 'cross' ? 'tenant-b' : 'tenant-a',
                  subject: 'alice',
                },
                values: [[stamp, `error ${trace} password=private-value user=user@example.com`]],
              },
            ],
          },
        }),
      );
    } else {
      const samples =
        mode === 'many'
          ? Array.from({ length: 40 }, (_, i) => ({
              metric: { instance: String(i) },
              value: [Date.now() / 1000, i === 39 ? '0' : '1'],
            }))
          : mode === 'empty'
            ? []
            : [
                {
                  metric: { instance: 'node-1' },
                  value: [mode === 'stale' ? 1 : Date.now() / 1000, mode === 'nan' ? 'NaN' : '0'],
                },
              ];
      res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: samples } }));
    }
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });
  function config(kind = 'loki'): OperationsConfig {
    return operationsConfigSchema.parse({
      enabled: true,
      checks: [
        kind === 'loki'
          ? {
              id: 'logs',
              title: 'Errors',
              kind,
              url,
              labels: { app: 'store' },
              tenantHeader: 'project-tenant',
              subjectLabel: 'subject',
            }
          : kind === 'http'
            ? { id: 'health', title: 'Health', kind, url: url + '/health' }
            : {
                id: 'metrics',
                title: 'Availability',
                kind,
                url,
                query: 'up{job="store"}',
                comparison: 'lt',
                threshold: 1,
              },
      ],
    });
  }
  const invoke = (c: OperationsConfig, changes: Record<string, unknown> = {}) =>
    observabilityProvider(() => c).tools[0]!.invoke(
      {
        checkId: c.checks[0]!.id,
        configHash: configurationHash(c),
        mode: 'case',
        traceId: trace,
        observedAt: new Date().toISOString(),
        ...changes,
      },
      { scope, requestId: 'test', signal: AbortSignal.timeout(3000) },
    );
  it('constructs bounded Loki queries with fixed project and verified tenant selectors and redacts evidence', async () => {
    mode = 'normal';
    const result = await invoke(config());
    expect(query).toContain('app="store"');
    expect(query).toContain('tenant_id="tenant-a"');
    expect(query).toContain('subject="alice"');
    expect(query).toContain(trace);
    expect(tenantHeader).toBe('project-tenant');
    expect(result).toHaveLength(2);
    expect(result[0]!.resource.namespace).toBe('alert');
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(JSON.stringify(result)).not.toContain('user@example.com');
    expect(result[1]!.visibility).toBe('ENGINEERING');
  });
  it('rejects cross-tenant output, configuration drift and credential-free calls requiring credentials', async () => {
    mode = 'cross';
    await expect(invoke(config())).rejects.toThrow('OBSERVABILITY_SCOPE_REJECTED');
    mode = 'normal';
    await expect(invoke(config(), { configHash: 'b'.repeat(64) })).rejects.toThrow(
      'OBSERVABILITY_CONFIG_CHANGED',
    );
    const c = config();
    c.checks[0]!.credentialEnv = 'AGENT18_OBS_MISSING';
    await expect(invoke(c)).rejects.toThrow('OBSERVABILITY_CREDENTIAL_MISSING');
    expect(
      operationsConfigSchema.safeParse({ ...c, checks: [{ ...c.checks[0], tenantLabel: 'app' }] }).success,
    ).toBe(false);
  });
  it('does not follow redirects or accept an unbounded body', async () => {
    mode = 'redirect';
    await expect(invoke(config())).rejects.toThrow();
    mode = 'large';
    await expect(invoke(config())).rejects.toThrow('OBSERVABILITY_RESPONSE_TOO_LARGE');
  });
  it('evaluates HTTP status without including the upstream response body', async () => {
    mode = 'down';
    const result = await invoke(config('http'));
    expect(result[0]!.resource.namespace).toBe('alert');
    expect(result[0]!.summary).toContain('503');
    expect(JSON.stringify(result)).not.toContain('health body');
  });
  it('handles missing, nonfinite and stale Prometheus data as unknown and checks all returned series', async () => {
    for (const value of ['empty', 'nan', 'stale']) {
      mode = value;
      expect((await invoke(config('prometheus')))[0]!.resource.namespace).toBe('unknown');
    }
    mode = 'many';
    const result = await invoke(config('prometheus'));
    expect(result).toHaveLength(30);
    expect(result[0]!.resource.namespace).toBe('alert');
  });
  it('bounds capture data and accepts JPEG only; redacts bearer and query credentials', () => {
    expect(
      pageCaptureSchema.safeParse({ screenshot: 'data:image/svg+xml,<svg onload=alert(1)>' }).success,
    ).toBe(false);
    expect(redact('Authorization: Bearer secret-secret https://example.com/a?token=private')).not.toContain(
      'secret-secret',
    );
    expect(redact('https://example.com/a?token=private')).toBe('https://example.com/a');
  });
});
