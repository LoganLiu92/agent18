import { z } from 'zod';
import { AppError } from '@agent18/domain';
export const reportScheduleSchema = z
  .object({
    kind: z.enum(['support_report', 'analytics_report']).default('support_report'),
    days: z.number().int().min(1).max(90),
    tenant: z.string().max(128).default(''),
    frequency: z.enum(['daily', 'weekly']),
    weekday: z.number().int().min(0).max(6).default(1),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    metricId: z.string().max(100).optional(),
    dimensions: z.array(z.string().max(100)).max(3).default([]),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.kind === 'analytics_report' && (!v.metricId || !v.tenant))
      c.addIssue({ code: 'custom', message: 'Analytics schedules require a metric and explicit tenant' });
  });
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;
export function localDay(at: Date, zone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
/** A daily civil-time slot runs once; skipped DST times wait for the next valid day. */
export function nextReportDue(after: Date, definition: ReportSchedule, previousDay?: string) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: definition.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (
    let t = Math.floor(after.getTime() / 60000) * 60000 + 60000;
    t < after.getTime() + 9 * 86400000;
    t += 60000
  ) {
    const parts = Object.fromEntries(formatter.formatToParts(t).map((p) => [p.type, p.value]));
    if (parts.hour + ':' + parts.minute !== definition.time) continue;
    if (definition.frequency === 'weekly' && parts.weekday !== weekdays[definition.weekday]) continue;
    const date = new Date(t);
    if (previousDay && localDay(date, definition.timezone) === previousDay) continue;
    return date;
  }
  throw new AppError('REPORT_SCHEDULE_INVALID', 400);
}
