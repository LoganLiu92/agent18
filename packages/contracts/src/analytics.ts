import { z } from 'zod';
import { metricDefinitionSchema } from './metrics.js';
const field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/);
export const analyticsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z
      .string()
      .url()
      .refine((raw) => {
        const u = new URL(raw);
        return (
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          (u.protocol === 'https:' ||
            (u.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal', 'analytics-demo'].includes(
                u.hostname,
              )))
        );
      }),
    credentialEnv: z.string().regex(/^AGENT18_ANALYTICS_[A-Z0-9_]{1,60}$/),
    tenantIds: z.array(z.string().min(1).max(128)).min(1).max(1000),
    playbooks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/),
            version: z.string().min(1).max(40),
            title: z.string().min(2).max(100),
            purpose: z.string().min(10).max(1000),
            metricId: z.string().max(80),
            days: z.number().int().min(1).max(90),
            dimensions: z.array(field).max(3),
            scope: z.literal('TENANT'),
            effect: z.literal('READ'),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    metrics: z
      .array(
        z
          .object({
            title: z.string().min(2).max(100),
            path: z
              .string()
              .regex(/^\/[a-zA-Z0-9_/-]{1,180}$/)
              .refine((v) => !v.includes('//')),
            definition: metricDefinitionSchema,
            questions: z.array(z.string().min(3).max(160)).max(10).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.metrics.map((m) => m.definition.id)).size !== v.metrics.length)
      c.addIssue({ code: 'custom', message: 'Metric IDs must be unique' });
    if (new Set(v.playbooks.map((p) => p.id)).size !== v.playbooks.length)
      c.addIssue({ code: 'custom', message: 'Playbook IDs must be unique' });
    for (const p of v.playbooks) {
      const m = v.metrics.find((m) => m.definition.id === p.metricId);
      if (
        !m ||
        p.days > m.definition.maxDays ||
        p.dimensions.some((d) => !m.definition.dimensions.includes(d))
      )
        c.addIssue({ code: 'custom', message: 'Playbook requires an approved metric and dimensions' });
    }
    for (const m of v.metrics)
      if (
        [...m.definition.values.map((v) => v.column), ...m.definition.dimensions].some(
          (v) => !field.safeParse(v).success,
        ) ||
        new Set([...m.definition.values.map((v) => v.column), ...m.definition.dimensions]).size !==
          m.definition.values.length + m.definition.dimensions.length
      )
        c.addIssue({ code: 'custom', message: 'Use distinct simple metric column identifiers' });
  });
export type AnalyticsConfig = z.infer<typeof analyticsConfigSchema>;
export const analyticsSelectionSchema = z
  .object({
    metricId: z.string().max(80),
    tenant: z.string().min(1).max(128),
    days: z.number().int().min(1).max(90),
    dimensions: z.array(field).max(3).default([]),
  })
  .strict();
export type AnalyticsSelection = z.infer<typeof analyticsSelectionSchema>;
