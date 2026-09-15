import { z } from 'zod';

const endpoint = z
  .string()
  .url()
  .max(500)
  .refine((value) => {
    const u = new URL(value);
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      !['169.254.169.254', 'metadata.google.internal', '100.100.100.200'].includes(u.hostname)
    );
  }, 'Use a fixed HTTP(S) endpoint without credentials, query or fragment');
const common = {
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  title: z.string().min(1).max(100),
  url: endpoint,
  credentialEnv: z
    .string()
    .regex(/^AGENT18_OBS_[A-Z0-9_]{1,64}$/)
    .optional(),
};
const label = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
export const checkSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('http'),
      expectedStatus: z.number().int().min(200).max(399).default(200),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('loki'),
      labels: z
        .record(label, z.string().min(1).max(128))
        .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 8),
      tenantHeader: z
        .string()
        .regex(/^[a-zA-Z0-9_.-]{1,128}$/)
        .optional(),
      tenantLabel: label.default('tenant_id'),
      subjectLabel: label.optional(),
      contains: z.string().min(1).max(100).default('error'),
      windowMinutes: z.number().int().min(1).max(60).default(10),
      minimumMatches: z.number().int().min(1).max(30).default(1),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('prometheus'),
      query: z.string().min(1).max(1000),
      comparison: z.enum(['gt', 'lt']),
      threshold: z.number().finite(),
    })
    .strict(),
]);
export const operationsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    autoInvestigate: z.boolean().default(true),
    intervalSeconds: z.number().int().min(60).max(86400).default(300),
    modelAnalysis: z.boolean().default(false),
    checks: z.array(checkSchema).max(8).default([]),
  })
  .strict()
  .refine((v) => new Set(v.checks.map((c) => c.id)).size === v.checks.length, 'Check IDs must be unique')
  .refine(
    (v) =>
      v.checks.every(
        (c) =>
          c.kind !== 'loki' ||
          (!(c.tenantLabel in c.labels) &&
            (!c.subjectLabel || (!(c.subjectLabel in c.labels) && c.subjectLabel !== c.tenantLabel))),
      ),
    'Tenant and subject labels must not replace the fixed project selectors',
  );
export type OperationsConfig = z.infer<typeof operationsConfigSchema>;
export type ObservationCheck = z.infer<typeof checkSchema>;
