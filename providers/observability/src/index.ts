import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Scope, type Evidence, evidenceSchema } from '@agent18/contracts';
import { AppError } from '@agent18/domain';
import { canonical, environments, type RegisteredProvider } from '@agent18/provider-contracts';
import type { OperationsConfig } from './config.js';

export const observationInput = z
  .object({
    checkId: z.string().max(64),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(['case', 'inspection']),
    traceId: z
      .string()
      .regex(/^[a-fA-F0-9]{16,32}$/)
      .optional(),
    observedAt: z.string().datetime(),
  })
  .strict();
export const configurationHash = (c: OperationsConfig) =>
  createHash('sha256').update(canonical(c)).digest('hex');
export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(
      /((?:password|passwd|secret|api[_-]?key|authorization|cookie|token)["']?\s*[:=]\s*["']?)[^\s,;}"']+/gi,
      '$1[redacted]',
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/[^\s"']+/g, (v) => {
      try {
        const u = new URL(v);
        return u.origin + u.pathname;
      } catch {
        return '[url]';
      }
    })
    .slice(0, 1800);
}
async function boundedJson(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('OBSERVABILITY_UPSTREAM_FAILED', 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('OBSERVABILITY_EMPTY_RESPONSE', 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 262144) {
      await reader.cancel();
      throw new AppError('OBSERVABILITY_RESPONSE_TOO_LARGE', 502);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export function observabilityProvider(
  configFor: (scope: Scope) => OperationsConfig | undefined,
  environment: Record<string, string | undefined> = process.env,
  request: typeof fetch = fetch,
): RegisteredProvider {
  return {
    manifest: { id: 'observability', version: '1.0.0', capabilities: ['operations.observe'], mode: 'live' },
    transport: 'http',
    // Engineering evidence is intentionally never released by the customer evidence projection.
    visible: async () => [],
    tools: [
      {
        descriptor: {
          id: 'operations.observe',
          version: 1,
          review: 'approved',
          capability: 'operations.observe',
          provider: 'observability',
          effect: 'READ',
          stage: 'READ',
          audience: 'ENGINEERING',
          risk: 'LOW',
          resourceTypes: ['log', 'metric', 'health'],
          environmentPolicy: [...environments],
        },
        inputSchema: observationInput,
        outputSchema: z.array(evidenceSchema).max(50),
        invoke: async (raw, ctx) => {
          const input = observationInput.parse(raw),
            config = configFor(ctx.scope);
          if (!config?.enabled || configurationHash(config) !== input.configHash)
            throw new AppError('OBSERVABILITY_CONFIG_CHANGED', 403);
          const check = config.checks.find((c) => c.id === input.checkId);
          if (!check) throw new AppError('OBSERVABILITY_CHECK_NOT_FOUND', 403);
          const headers: Record<string, string> = {};
          if (check.credentialEnv) {
            const secret = environment[check.credentialEnv];
            if (!secret || /[\r\n]/.test(secret)) throw new AppError('OBSERVABILITY_CREDENTIAL_MISSING', 503);
            headers.authorization = 'Bearer ' + secret;
          }
          const evidence = (
            kind: Evidence['kind'],
            type: string,
            summary: string,
            state: string,
            at = new Date().toISOString(),
          ): Evidence => ({
            id: randomUUID(),
            kind,
            source: `observability://${check.id}`,
            observedAt: at,
            resource: { namespace: state, type, id: check.id },
            summary: redact(summary),
            artifactRef: null,
            visibility: 'ENGINEERING',
            sensitivity: 'CONFIDENTIAL',
            scope: ctx.scope,
            provenance: {
              providerId: 'observability',
              toolId: 'operations.observe',
              toolVersion: 1,
              sourceVersion: input.configHash,
              requestId: ctx.requestId,
            },
          });
          const get = (url: string) => request(url, { headers, signal: ctx.signal, redirect: 'error' });
          if (check.kind === 'http') {
            const started = Date.now(),
              result = await get(check.url);
            await result.body?.cancel();
            return [
              evidence(
                'metric',
                'health',
                `${check.title}: HTTP ${result.status}; ${Date.now() - started} ms`,
                result.status === check.expectedStatus ? 'healthy' : 'alert',
              ),
            ];
          }
          if (check.kind === 'loki') {
            const labels = { ...check.labels };
            // Customer-submitted trace IDs never broaden the configured project/tenant boundary.
            if (input.mode === 'case') {
              labels[check.tenantLabel] = ctx.scope.tenantId;
              if (check.subjectLabel) labels[check.subjectLabel] = ctx.scope.subject;
            }
            if (check.tenantHeader) headers['X-Scope-OrgID'] = check.tenantHeader;
            let query =
              '{' +
              Object.entries(labels)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(',') +
              '}';
            query += ' |= ' + JSON.stringify(check.contains);
            if (input.traceId) query += ' |= ' + JSON.stringify(input.traceId);
            const end = Math.min(Date.parse(input.observedAt) + 60000, Date.now());
            const url = new URL(check.url.replace(/\/$/, '') + '/loki/api/v1/query_range');
            url.search = new URLSearchParams({
              query,
              start: String(BigInt(end - check.windowMinutes * 60000) * 1000000n),
              end: String(BigInt(end) * 1000000n),
              limit: '30',
              direction: 'backward',
            }).toString();
            const body = z
              .object({
                status: z.literal('success'),
                data: z.object({
                  resultType: z.literal('streams'),
                  result: z
                    .array(
                      z.object({
                        stream: z.record(z.string(), z.string()),
                        values: z.array(z.tuple([z.string().regex(/^\d{1,20}$/), z.string().max(262144)])),
                      }),
                    )
                    .max(100),
                }),
              })
              .parse(await boundedJson(await get(url.toString())));
            const lines: Evidence[] = [];
            for (const stream of body.data.result) {
              if (Object.entries(labels).some(([key, value]) => stream.stream[key] !== value))
                throw new AppError('OBSERVABILITY_SCOPE_REJECTED', 502);
              for (const [timestamp, line] of stream.values) {
                if (lines.length >= 30) break;
                const ms = Number(BigInt(timestamp) / 1000000n);
                if (!Number.isFinite(ms) || ms < end - check.windowMinutes * 60000 || ms > end)
                  throw new AppError('OBSERVABILITY_TIME_REJECTED', 502);
                if (!line.includes(check.contains) || (input.traceId && !line.includes(input.traceId)))
                  throw new AppError('OBSERVABILITY_FILTER_REJECTED', 502);
                lines.push(evidence('log', 'log', line, 'sample', new Date(ms).toISOString()));
              }
            }
            return [
              evidence(
                'log',
                'log',
                `${check.title}: ${lines.length} matching log samples (limit 30)`,
                lines.length >= check.minimumMatches ? 'alert' : 'healthy',
              ),
              ...lines,
            ];
          }
          const url = new URL(check.url.replace(/\/$/, '') + '/api/v1/query');
          url.search = new URLSearchParams({ query: check.query, timeout: '2s' }).toString();
          const body = z
            .object({
              status: z.literal('success'),
              data: z.object({
                resultType: z.literal('vector'),
                result: z
                  .array(
                    z.object({
                      metric: z.record(z.string(), z.string()),
                      value: z.tuple([z.number(), z.string()]),
                    }),
                  )
                  .max(100),
              }),
            })
            .parse(await boundedJson(await get(url.toString())));
          if (!body.data.result.length)
            return [evidence('metric', 'metric', `${check.title}: no samples`, 'unknown')];
          const now = Date.now();
          const samples = body.data.result.map((sample) => {
            const value = Number(sample.value[1]),
              stale = Math.abs(now - sample.value[0] * 1000) > 300000;
            const state =
              !Number.isFinite(value) || stale
                ? 'unknown'
                : (check.comparison === 'gt' ? value > check.threshold : value < check.threshold)
                  ? 'alert'
                  : 'healthy';
            return evidence(
              'metric',
              'metric',
              `${check.title}: ${sample.value[1]}; threshold ${check.comparison} ${check.threshold}; ${JSON.stringify(sample.metric)}`,
              state,
            );
          });
          if (samples.length <= 30) return samples;
          const state = samples.some((e) => e.resource.namespace === 'alert')
            ? 'alert'
            : samples.some((e) => e.resource.namespace === 'unknown')
              ? 'unknown'
              : 'healthy';
          return [
            evidence(
              'metric',
              'metric',
              `${check.title}: evaluated ${samples.length} series; displaying first 29 samples`,
              state,
            ),
            ...samples.slice(0, 29),
          ];
        },
      },
    ],
  };
}
