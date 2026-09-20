import { z } from 'zod';
export const metricDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{1,79}$/),
    version: z.string().min(1).max(80),
    definition: z.string().trim().min(10).max(2000),
    timezone: z
      .string()
      .min(1)
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'Use an IANA timezone'),
    values: z
      .array(
        z
          .object({
            column: z.string().min(1).max(200),
            unit: z.string().min(1).max(40),
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    dimensions: z.array(z.string().min(1).max(200)).max(10),
    period: z.object({ startField: z.string().min(1).max(50), endField: z.string().min(1).max(50) }).strict(),
    maxDays: z.number().int().min(1).max(366).default(90),
  })
  .strict();
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
