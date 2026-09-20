import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { referenceAnalytics, referenceAnalyticsConfig } from '../../examples/analytics-bridge/reference.js';
import { calculateAnalytics } from '../../packages/application/src/analytics.js';
import { analyticsConfigSchema, type AnalyticsConfig } from '@agent18/contracts';
describe('approved analytics over independent SQLite HTTP service', () => {
  const project = { organizationId: randomUUID(), projectId: randomUUID() },
    token = 'isolated-reference-credential-2026',
    fixture = referenceAnalytics(token, project),
    at = new Date('2026-09-20T12:00:00Z');
  let config: AnalyticsConfig;
  beforeAll(async () => {
    await new Promise<void>((r) => fixture.server.listen(0, '127.0.0.1', r));
    config = referenceAnalyticsConfig(
      'http://127.0.0.1:' + (fixture.server.address() as { port: number }).port,
    );
  });
  afterAll(async () => {
    await new Promise<void>((r) => fixture.server.close(() => r()));
    fixture.db.close();
  });
  const query = (metricId: string, dimensions: string[] = []) =>
    calculateAnalytics(
      config,
      project,
      { metricId, days: 7, tenant: 'alpha', dimensions },
      { AGENT18_ANALYTICS_REFERENCE: token },
      fetch,
      at,
    );
  it('reconciles total sales, stores, and preceding window against source records', async () => {
    const total = await query('sales.net'),
      stores = await query('sales.net', ['store']);
    const truth = fixture.db
      .prepare(
        "SELECT sum(paid-refund) n,count(*) c FROM orders WHERE tenant='alpha' AND day>='2026-09-13' AND day<'2026-09-20' AND currency='USD' AND state='PAID'",
      )
      .get()!;
    expect(total.current.summary).toEqual({ netCents: truth.n, orders: truth.c });
    expect(total.current.summary.netCents).toBe(25000);
    expect(total.previous.summary.netCents).toBe(5000);
    expect(total.changes.find((c) => c.column === 'netCents')?.percent).toBe(400);
    expect(stores.current.rows).toEqual([
      { store: 'North', netCents: 10000, orders: 1 },
      { store: 'South', netCents: 15000, orders: 1 },
    ]);
  });
  it('reconciles sessions, distinct visitors, and per-channel conversion without adding rates', async () => {
    const total = await query('website.conversion'),
      channels = await query('website.conversion', ['channel']);
    expect(total.current.summary).toEqual({ sessions: 4, visitors: 3, conversions: 2, conversionRate: 50 });
    expect(total.previous.summary).toEqual({ sessions: 2, visitors: 2, conversions: 1, conversionRate: 50 });
    expect(channels.current.rows).toEqual([
      { channel: 'organic', sessions: 2, visitors: 2, conversions: 1, conversionRate: 50 },
      { channel: 'paid', sessions: 2, visitors: 2, conversions: 1, conversionRate: 50 },
    ]);
  });
  it('executes two reviewed playbooks through the same bounded read-only contract', async () => {
    expect(config.playbooks).toHaveLength(2);
    for (const p of config.playbooks) {
      expect(p.effect).toBe('READ');
      const result = await query(p.metricId, p.dimensions);
      expect(result.comparisonComplete).toBe(true);
      expect(result.selection.dimensions).toEqual(p.dimensions);
    }
    expect(
      analyticsConfigSchema.safeParse({
        ...config,
        playbooks: [{ ...config.playbooks[0], effect: 'EXECUTE' }],
      }).success,
    ).toBe(false);
    expect(
      analyticsConfigSchema.safeParse({
        ...config,
        playbooks: [{ ...config.playbooks[0], metricId: 'unknown' }],
      }).success,
    ).toBe(false);
  });
  it('rejects unapproved scope and dimensions before upstream, and wrong service authentication', async () => {
    const selection = { metricId: 'sales.net', days: 7, tenant: 'unknown', dimensions: [] };
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      throw Error('should not call');
    };
    await expect(calculateAnalytics(config, project, selection, {}, request, at)).rejects.toThrow(
      'ANALYTICS_SCOPE_DENIED',
    );
    await expect(
      calculateAnalytics(
        config,
        project,
        { ...selection, tenant: 'alpha', dimensions: ['password'] },
        {},
        request,
        at,
      ),
    ).rejects.toThrow('ANALYTICS_SELECTION_INVALID');
    expect(calls).toBe(0);
    await expect(
      calculateAnalytics(
        config,
        project,
        { ...selection, tenant: 'alpha' },
        { AGENT18_ANALYTICS_REFERENCE: 'wrong-credential-1234' },
        fetch,
        at,
      ),
    ).rejects.toThrow('ANALYTICS_UPSTREAM_FAILED');
  });
  it('rejects cross-tenant or definition-mismatched results and preserves incomplete evidence', async () => {
    const selection = { metricId: 'sales.net', days: 7, tenant: 'alpha', dimensions: [] };
    for (const patch of [
      { tenantId: 'beta' },
      { definitionVersion: 'unreviewed' },
      { summary: { netCents: NaN, orders: 1 } },
    ]) {
      const request: typeof fetch = async (...args) => {
        const r = await fetch(...args);
        return Response.json({ ...((await r.json()) as object), ...patch });
      };
      await expect(
        calculateAnalytics(config, project, selection, { AGENT18_ANALYTICS_REFERENCE: token }, request, at),
      ).rejects.toThrow('ANALYTICS_CONTRACT_INVALID');
    }
    const request: typeof fetch = async (...args) =>
      Response.json({ ...((await (await fetch(...args)).json()) as object), complete: false });
    expect(
      (
        await calculateAnalytics(
          config,
          project,
          selection,
          { AGENT18_ANALYTICS_REFERENCE: token },
          request,
          at,
        )
      ).comparisonComplete,
    ).toBe(false);
  });
});
