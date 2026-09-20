import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { analyticsConfigSchema } from '@agent18/contracts';
/** Independent reference SaaS adapter. Replace these SQL queries with your authoritative reporting API. */
export function referenceAnalytics(token: string, project: { organizationId: string; projectId: string }) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE orders(id TEXT,tenant TEXT,day TEXT,store TEXT,currency TEXT,state TEXT,paid INTEGER,refund INTEGER);
 INSERT INTO orders VALUES('1','alpha','2026-09-13','North','USD','PAID',10000,0),('2','alpha','2026-09-14','South','USD','PAID',20000,5000),('3','alpha','2026-09-16','North','USD','CANCELLED',9000,0),('4','alpha','2026-09-18','North','EUR','PAID',5000,0),('5','alpha','2026-09-10','North','USD','PAID',5000,0),('6','beta','2026-09-14','North','USD','PAID',999999,0);
 CREATE TABLE visits(id TEXT,tenant TEXT,day TEXT,channel TEXT,visitor TEXT,converted INTEGER);
 INSERT INTO visits VALUES('a','alpha','2026-09-13','organic','u1',1),('b','alpha','2026-09-14','paid','u2',0),('c','alpha','2026-09-16','paid','u1',1),('d','alpha','2026-09-18','organic','u3',0),('e','alpha','2026-09-10','organic','u1',1),('f','alpha','2026-09-11','paid','u2',0),('g','beta','2026-09-14','paid','u9',1);`);
  const server = createServer((req, res) => {
    try {
      const expected = Buffer.from('Bearer ' + token),
        actual = Buffer.from(req.headers.authorization ?? '');
      if (
        req.method !== 'GET' ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        req.headers['x-agent18-project'] !== project.projectId ||
        req.headers['x-agent18-organization'] !== project.organizationId
      ) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url!, 'http://localhost'),
        tenant = url.searchParams.get('tenant'),
        start = url.searchParams.get('start') ?? '',
        end = url.searchParams.get('end') ?? '',
        dimensions = (url.searchParams.get('dimensions') ?? '').split(',').filter(Boolean),
        sales = url.pathname === '/sales',
        web = url.pathname === '/conversion';
      if (
        !['alpha', 'beta'].includes(tenant ?? '') ||
        (!sales && !web) ||
        !/^\d{4}-\d{2}-\d{2}T00:00:00.000Z$/.test(start) ||
        !/^\d{4}-\d{2}-\d{2}T00:00:00.000Z$/.test(end) ||
        new Set(dimensions).size !== dimensions.length ||
        dimensions.some((d) => !(sales ? ['day', 'store'] : ['day', 'channel']).includes(d))
      ) {
        res.writeHead(400).end();
        return;
      }
      const table = sales ? 'orders' : 'visits',
        where = `tenant=? AND day>=? AND day<? ${sales ? "AND currency='USD' AND state='PAID'" : ''}`,
        params = [tenant!, start.slice(0, 10), end.slice(0, 10)],
        aggregate = sales
          ? 'COALESCE(sum(paid-refund),0) AS netCents,count(*) AS orders'
          : 'count(*) AS sessions,count(DISTINCT visitor) AS visitors,COALESCE(sum(converted),0) AS conversions,CASE WHEN count(*)=0 THEN 0 ELSE round(100.0*sum(converted)/count(*),2) END AS conversionRate';
      const summary = db.prepare(`SELECT ${aggregate} FROM ${table} WHERE ${where}`).get(...params),
        rows = dimensions.length
          ? db
              .prepare(
                `SELECT ${dimensions.join(',')},${aggregate} FROM ${table} WHERE ${where} GROUP BY ${dimensions.join(',')} ORDER BY ${dimensions.join(',')} LIMIT 1000`,
              )
              .all(...params)
          : [summary];
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          organizationId: project.organizationId,
          projectId: project.projectId,
          tenantId: tenant,
          metricId: sales ? 'sales.net' : 'website.conversion',
          definitionVersion: 'reference-v1',
          start,
          end,
          dimensions,
          summary,
          rows,
          complete: true,
          generatedAt: new Date().toISOString(),
          sourceRevision: 'sqlite-reference-20260920',
        }),
      );
    } catch {
      res.writeHead(500).end();
    }
  });
  return { server, db };
}
export function referenceAnalyticsConfig(baseUrl: string) {
  return analyticsConfigSchema.parse({
    enabled: true,
    baseUrl,
    credentialEnv: 'AGENT18_ANALYTICS_REFERENCE',
    tenantIds: ['alpha', 'beta'],
    playbooks: [
      {
        id: 'sales-review',
        version: '1',
        title: '经营表现复盘',
        purpose: '比较两个完整周期的实收销售，并按门店核对退款后收入。',
        metricId: 'sales.net',
        days: 7,
        dimensions: ['store'],
        scope: 'TENANT',
        effect: 'READ',
      },
      {
        id: 'conversion-review',
        version: '1',
        title: '网站转化复盘',
        purpose: '区分会话、访客和转化，按渠道比较两个完整周期的表现。',
        metricId: 'website.conversion',
        days: 7,
        dimensions: ['channel'],
        scope: 'TENANT',
        effect: 'READ',
      },
    ],
    metrics: [
      {
        title: '实收销售表现',
        path: '/sales',
        questions: ['最近销售额', '各门店销售', '退款后的收入'],
        definition: {
          id: 'sales.net',
          version: 'reference-v1',
          definition:
            'USD 已付款订单的已付金额减退款，以美分计；排除取消订单和其他币种；按付款归属日统计，未包含税额拆分。',
          timezone: 'UTC',
          values: [
            { column: 'netCents', unit: 'cent', currency: 'USD' },
            { column: 'orders', unit: 'order' },
          ],
          dimensions: ['day', 'store'],
          period: { startField: 'start', endField: 'end' },
          maxDays: 90,
        },
      },
      {
        title: '网站会话转化',
        path: '/conversion',
        questions: ['网站转化率', '流量渠道表现', '访问人数'],
        definition: {
          id: 'website.conversion',
          version: 'reference-v1',
          definition:
            '按会话开始日归属，session 为一次会话，visitor 为去重访客；转化为该会话内完成一次目标，比例=转化会话/全部会话；不同分组访客不可直接相加。',
          timezone: 'UTC',
          values: [
            { column: 'sessions', unit: 'session' },
            { column: 'visitors', unit: 'visitor' },
            { column: 'conversions', unit: 'converted_session' },
            { column: 'conversionRate', unit: 'percent' },
          ],
          dimensions: ['day', 'channel'],
          period: { startField: 'start', endField: 'end' },
          maxDays: 90,
        },
      },
    ],
  });
}
