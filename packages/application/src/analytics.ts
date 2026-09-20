import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import { type AnalyticsConfig, type AnalyticsSelection } from '@agent18/contracts';
import { canonical } from '@agent18/provider-contracts';
export const analyticsHash = (config: AnalyticsConfig) =>
  createHash('sha256').update(canonical(config)).digest('hex');
export function analyticsMetric(config: AnalyticsConfig | undefined, selection: AnalyticsSelection) {
  const metric = config?.enabled
    ? config.metrics.find((m) => m.definition.id === selection.metricId)
    : undefined;
  if (!config || !metric) throw new AppError('ANALYTICS_NOT_CONFIGURED', 409);
  if (!config.tenantIds.includes(selection.tenant)) throw new AppError('ANALYTICS_SCOPE_DENIED', 403);
  if (
    selection.days > metric.definition.maxDays ||
    selection.dimensions.some((d) => !metric.definition.dimensions.includes(d)) ||
    new Set(selection.dimensions).size !== selection.dimensions.length
  )
    throw new AppError('ANALYTICS_SELECTION_INVALID', 400);
  return metric;
}
/** Approved service credentials are project-bound; no employee session or customer token leaves Core. */
export async function calculateAnalytics(
  config: AnalyticsConfig | undefined,
  project: { organizationId: string; projectId: string },
  selection: AnalyticsSelection,
  environment: Record<string, string | undefined> = process.env,
  request: typeof fetch = fetch,
  at = new Date(),
) {
  const metric = analyticsMetric(config, selection),
    definition = metric.definition,
    c = config!;
  const token = environment[c.credentialEnv];
  if (!token || token.length < 16 || /[\r\n]/.test(token))
    throw new AppError('ANALYTICS_CREDENTIAL_MISSING', 503);
  // Windows are complete UTC days. A non-UTC upstream metric must explicitly translate these instants.
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())),
    start = new Date(+end - selection.days * 86400000),
    prior = new Date(+start - selection.days * 86400000);
  const number = z.number().finite().min(-1e15).max(1e15),
    columnKeys = definition.values.map((v) => v.column);
  const numeric = z.object(Object.fromEntries(columnKeys.map((k) => [k, number]))).strict();
  const row = z
    .object({
      ...Object.fromEntries(columnKeys.map((k) => [k, number])),
      ...Object.fromEntries(selection.dimensions.map((k) => [k, z.string().max(200)])),
    })
    .strict();
  const schema = z
    .object({
      organizationId: z.literal(project.organizationId),
      projectId: z.literal(project.projectId),
      tenantId: z.literal(selection.tenant),
      metricId: z.literal(selection.metricId),
      definitionVersion: z.literal(definition.version),
      start: z.string().datetime(),
      end: z.string().datetime(),
      dimensions: z.array(z.string()),
      summary: numeric,
      rows: z.array(row).max(1000),
      complete: z.boolean(),
      generatedAt: z.string().datetime(),
      sourceRevision: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-zA-Z0-9_.:@/-]+$/),
    })
    .strict();
  const one = async (a: Date, b: Date) => {
    const url = new URL(c.baseUrl.replace(/\/$/, '') + metric.path);
    url.search = new URLSearchParams({
      tenant: selection.tenant,
      start: a.toISOString(),
      end: b.toISOString(),
      dimensions: selection.dimensions.join(','),
    }).toString();
    const response = await request(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        authorization: 'Bearer ' + token,
        'x-agent18-organization': project.organizationId,
        'x-agent18-project': project.projectId,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('ANALYTICS_UPSTREAM_FAILED', 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AppError('ANALYTICS_EMPTY_RESPONSE', 502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 524288) {
        await reader.cancel();
        throw new AppError('ANALYTICS_RESPONSE_TOO_LARGE', 502);
      }
      chunks.push(value);
    }
    let result: z.infer<typeof schema>;
    try {
      result = schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      throw new AppError('ANALYTICS_CONTRACT_INVALID', 502);
    }
    if (
      result.start !== a.toISOString() ||
      result.end !== b.toISOString() ||
      JSON.stringify(result.dimensions) !== JSON.stringify(selection.dimensions) ||
      Date.parse(result.generatedAt) > Date.now() + 60000
    )
      throw new AppError('ANALYTICS_CONTRACT_INVALID', 502);
    return result;
  };
  const current = await one(start, end),
    previous = await one(prior, start);
  const changes = columnKeys.map((column) => ({
    column,
    current: current.summary[column]!,
    previous: previous.summary[column]!,
    delta: current.summary[column]! - previous.summary[column]!,
    percent:
      previous.summary[column] === 0
        ? null
        : Math.round(
            ((current.summary[column]! - previous.summary[column]!) / Math.abs(previous.summary[column]!)) *
              10000,
          ) / 100,
  }));
  return {
    kind: 'analytics' as const,
    definitionVersion: definition.version,
    generatedAt: new Date().toISOString(),
    configHash: analyticsHash(c),
    metric: definition,
    title: metric.title,
    selection,
    scope: { allTenants: false, tenantIds: [selection.tenant] },
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: definition.timezone,
    windowBasis: 'Complete UTC days, [start,end)',
    current,
    previous,
    changes,
    limitations: [
      ...(!current.complete || !previous.complete ? ['上游返回不完整数据，不能据此计算总体变化。'] : []),
      '变化是描述性统计；原因需要进一步核实。',
    ],
    comparisonComplete: current.complete && previous.complete,
  };
}
