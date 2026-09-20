import type { PoolClient } from 'pg';
export const supportDefinitionVersion = 'support-metrics-v1';
export async function calculateSupportInsight(
  c: PoolClient,
  input: { days: number; tenant: string },
  scope: { allTenants: boolean; tenantIds: string[] },
) {
  // Only fixed aggregates, computed under the same RLS as the ticket queue.
  const end = (await c.query('SELECT now() AS at')).rows[0].at as Date;
  const start = new Date(end.getTime() - input.days * 86400000);
  const rows = (
    await c.query(
      `SELECT ticket_status AS status,count(*)::int AS count FROM core.cases WHERE deleted_at IS NULL AND created_at>=$1 AND created_at<$2 AND ($3='' OR tenant_id=$3) GROUP BY ticket_status ORDER BY ticket_status`,
      [start, end, input.tenant],
    )
  ).rows;
  const daily = (
    await c.query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,count(*)::int AS created,count(*) FILTER(WHERE ticket_status IN ('resolved','closed'))::int AS resolved FROM core.cases WHERE deleted_at IS NULL AND created_at>=$1 AND created_at<$2 AND ($3='' OR tenant_id=$3) GROUP BY day ORDER BY day`,
      [start, end, input.tenant],
    )
  ).rows;
  const resolution = (
    await c.query(
      `SELECT count(*)::int AS sample,round(avg(extract(epoch FROM (resolved_at-created_at))/3600)::numeric,2) AS average_hours FROM core.cases WHERE deleted_at IS NULL AND created_at>=$1 AND created_at<$2 AND ($3='' OR tenant_id=$3) AND ticket_status IN ('resolved','closed') AND resolved_at>=created_at`,
      [start, end, input.tenant],
    )
  ).rows[0];
  const backlog = +(
    await c.query(
      `SELECT count(*) FROM core.cases WHERE deleted_at IS NULL AND ticket_status NOT IN ('resolved','closed') AND ($1='' OR tenant_id=$1)`,
      [input.tenant],
    )
  ).rows[0].count;
  return {
    definitionVersion: supportDefinitionVersion,
    generatedAt: end.toISOString(),
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: 'UTC',
    scope,
    selection: input,
    byStatus: rows,
    daily,
    resolution: {
      sample: resolution.sample,
      averageHours: resolution.average_hours === null ? null : +resolution.average_hours,
    },
    backlog,
    definitions: {
      created: '在半开时间区间 [start,end) 内创建的可见工单，排除已删除记录。',
      resolved: '区间内创建且当前状态为已解决或已关闭的工单；按创建日分组，非当日结案量。',
      backlog: '生成时刻所有尚未解决的可见工单，不限创建时间。',
      resolution: '区间内创建、当前已解决且具有有效解决时间的样本；当前解决时间减创建时间，小时。',
    },
  };
}
