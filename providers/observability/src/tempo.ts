import { z } from 'zod';
import { AppError } from '@agent18/domain';
import type { Scope } from '@agent18/contracts';
const attribute = z.object({
  key: z.string().max(200),
  value: z.object({
    stringValue: z.string().max(4000).optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
  }),
});
const attributes = z.array(attribute).max(128).default([]);
const span = z.object({
  traceId: z.string().max(64),
  spanId: z.string().max(32),
  parentSpanId: z.string().max(32).optional(),
  name: z.string().max(1000),
  startTimeUnixNano: z.string().regex(/^\d{1,20}$/),
  endTimeUnixNano: z.string().regex(/^\d{1,20}$/),
  attributes,
  status: z.object({ code: z.union([z.number(), z.string()]).optional() }).optional(),
});
const group = z.object({ spans: z.array(span).max(500) });
const batch = z.object({
  resource: z.object({ attributes }).optional(),
  scopeSpans: z.array(group).max(100).optional(),
  instrumentationLibrarySpans: z.array(group).max(100).optional(),
});
const payload = z.object({
  batches: z.array(batch).max(100).optional(),
  resourceSpans: z.array(batch).max(100).optional(),
});
export type TempoScope = {
  projectAttributes: Record<string, string>;
  tenantAttribute: string;
  subjectAttribute?: string;
  windowMinutes: number;
};
function identity(value: string, bytes: number) {
  if (new RegExp(`^[a-fA-F0-9]{${bytes * 2}}$`).test(value)) return value.toLowerCase();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value)
    throw new AppError('TRACE_ID_INVALID', 502);
  return decoded.toString('hex');
}
/** Parse only bounded OTLP fields and independently enforce every returned span's scope. */
export function parseTempoTrace(
  raw: unknown,
  traceId: string,
  scope: Scope,
  check: TempoScope,
  observedAt: string,
) {
  const body = payload.parse(raw),
    batches = body.batches ?? body.resourceSpans;
  if (!batches) throw new AppError('TRACE_RESPONSE_INVALID', 502);
  const expected = traceId.toLowerCase().padStart(32, '0'),
    end = Math.min(Date.parse(observedAt) + 60000, Date.now()),
    start = end - check.windowMinutes * 60000;
  const rows: {
    id: string;
    parentId: string | null;
    service: string;
    name: string;
    at: string;
    durationMs: number;
    error: boolean;
  }[] = [];
  for (const resource of batches) {
    const values = (items: z.infer<typeof attributes>) => {
      if (new Set(items.map((a) => a.key)).size !== items.length)
        throw new AppError('TRACE_ATTRIBUTES_AMBIGUOUS', 502);
      return Object.fromEntries(
        items.map((a) => [a.key, a.value.stringValue ?? String(a.value.intValue ?? '')]),
      );
    };
    const shared = values(resource.resource?.attributes ?? []);
    for (const group of resource.scopeSpans ?? resource.instrumentationLibrarySpans ?? []) {
      for (const s of group.spans) {
        if (rows.length >= 500) throw new AppError('TRACE_RESPONSE_TOO_LARGE', 502);
        const tags = { ...shared, ...values(s.attributes) };
        if (
          identity(s.traceId, 16) !== expected ||
          Object.entries(check.projectAttributes).some(([k, v]) => tags[k] !== v) ||
          tags[check.tenantAttribute] !== scope.tenantId ||
          (check.subjectAttribute && tags[check.subjectAttribute] !== scope.subject)
        )
          throw new AppError('OBSERVABILITY_SCOPE_REJECTED', 502);
        const a = Number(BigInt(s.startTimeUnixNano) / 1000000n),
          b = Number(BigInt(s.endTimeUnixNano) / 1000000n);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a < start || b > end || b < a)
          throw new AppError('OBSERVABILITY_TIME_REJECTED', 502);
        rows.push({
          id: identity(s.spanId, 8),
          parentId: s.parentSpanId ? identity(s.parentSpanId, 8) : null,
          service: tags['service.name'] ?? 'unknown',
          name: s.name,
          at: new Date(a).toISOString(),
          durationMs: b - a,
          error: s.status?.code === 2 || s.status?.code === 'STATUS_CODE_ERROR',
        });
      }
    }
  }
  return rows;
}
