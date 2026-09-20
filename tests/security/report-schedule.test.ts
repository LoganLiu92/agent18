import { describe, it, expect } from 'vitest';
import { reportScheduleSchema, nextReportDue } from '../../packages/application/src/report-schedule.js';
const definition = (extra: Record<string, unknown> = {}) =>
  reportScheduleSchema.parse({
    days: 30,
    frequency: 'daily',
    time: '09:00',
    timezone: 'Australia/Adelaide',
    ...extra,
  });
describe('civil time report schedules', () => {
  it('uses the target timezone and is strictly after the previous slot', () => {
    expect(nextReportDue(new Date('2026-09-20T00:00:00Z'), definition()).toISOString()).toBe(
      '2026-09-20T23:30:00.000Z',
    );
    expect(nextReportDue(new Date('2026-09-20T23:30:00Z'), definition()).toISOString()).toBe(
      '2026-09-21T23:30:00.000Z',
    );
  });
  it('skips nonexistent spring hours and avoids duplicate autumn hours', () => {
    const d = definition({ timezone: 'America/New_York', time: '02:30' });
    expect(nextReportDue(new Date('2026-03-08T05:00:00Z'), d).toISOString()).toBe('2026-03-09T06:30:00.000Z');
    const fall = definition({ timezone: 'America/New_York', time: '01:30' });
    expect(nextReportDue(new Date('2026-11-01T05:30:00Z'), fall, '2026-11-01').toISOString()).toBe(
      '2026-11-02T06:30:00.000Z',
    );
  });
  it('handles weekly weekday and rejects invalid definitions', () => {
    expect(
      nextReportDue(
        new Date('2026-09-20T00:00:00Z'),
        definition({ frequency: 'weekly', weekday: 2 }),
      ).toISOString(),
    ).toBe('2026-09-21T23:30:00.000Z');
    expect(() => definition({ timezone: 'wrong-zone' })).toThrow();
    expect(() => definition({ time: '24:00' })).toThrow();
    expect(() => definition({ kind: 'analytics_report' })).toThrow();
  });
});
