import { useEffect, useState } from 'react';
import type { MetricDefinition, AnalyticsConfig } from '@agent18/contracts';
import type { calculateAnalytics } from '../../../packages/application/src/analytics.js';
import { ReportSchedules } from './report-schedules.js';
export type AnalyticsReport = Awaited<ReturnType<typeof calculateAnalytics>>;
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Metric = { title: string; definition: MetricDefinition; questions: string[] };
export function AnalyticsReportView({ data }: { data: AnalyticsReport }) {
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agent18-business-insight.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="admin-card">
      <h2>{data.title}</h2>
      <p>{data.metric.definition}</p>
      <small>
        租户 {data.selection.tenant} · {data.start} 至 {data.end} · 口径 {data.definitionVersion} ·{' '}
        {data.timezone}
      </small>
      <p>
        {data.windowBasis} · 计算时间 {data.generatedAt}
      </p>
      <div className="ws-stats">
        {data.changes.map((v) => (
          <article key={v.column}>
            <strong>{v.current}</strong>
            <span>
              {v.column} (
              {[
                data.metric.values.find((c) => c.column === v.column)?.unit,
                data.metric.values.find((c) => c.column === v.column)?.currency,
              ]
                .filter(Boolean)
                .join(' · ')}
              )
            </span>
            <small>
              上期 {v.previous} ·{' '}
              {data.comparisonComplete
                ? v.percent === null
                  ? '基数为零，比例不适用'
                  : `${v.percent}%`
                : '数据不完整，不作总体对比'}
            </small>
          </article>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              {[...data.selection.dimensions, ...data.metric.values.map((v) => v.column)].map((k) => (
                <th key={k}>
                  {k}
                  {data.metric.values.some((v) => v.column === k)
                    ? ` (${data.metric.values
                        .filter((v) => v.column === k)
                        .map((v) => [v.unit, v.currency].filter(Boolean).join(' · '))
                        .join('')})`
                    : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.current.rows.map((r, i) => (
              <tr key={i}>
                {[...data.selection.dimensions, ...data.metric.values.map((v) => v.column)].map((k) => (
                  <td key={k}>{String(r[k] ?? '—')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        当前数据版本 {data.current.sourceRevision} · 对比版本 {data.previous.sourceRevision}
      </p>
      {data.limitations.map((v) => (
        <p key={v}>{v}</p>
      ))}
      <button onClick={download}>导出含口径与来源的 JSON</button>
    </section>
  );
}
export function AnalyticsWorkspace({
  request,
  base,
  onSaved,
  onReport,
}: {
  request: Request;
  base: string;
  onSaved: () => Promise<void>;
  onReport: (id: string) => Promise<void>;
}) {
  const path = base + '/insights',
    [metrics, setMetrics] = useState<Metric[]>([]),
    [playbooks, setPlaybooks] = useState<AnalyticsConfig['playbooks']>([]),
    [metricId, setMetricId] = useState(''),
    [question, setQuestion] = useState(''),
    [tenant, setTenant] = useState(''),
    [days, setDays] = useState(30),
    [dimensions, setDimensions] = useState<string[]>([]),
    [title, setTitle] = useState('业务分析报告'),
    [report, setReport] = useState<AnalyticsReport>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID()),
    [planned, setPlanned] = useState(false);
  const metric = metrics.find((m) => m.definition.id === metricId);
  useEffect(() => {
    let active = true;
    request<{ metrics: Metric[]; playbooks: AnalyticsConfig['playbooks'] }>(path + '/analytics')
      .then((r) => {
        if (active) {
          setMetrics(r.metrics);
          setPlaybooks(r.playbooks);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="admin-card">
        <h2>业务数据洞察</h2>
        <p>
          选择已审核的指标，确认租户、时间和维度后查询。问题匹配只帮助选择指标，不会生成 SQL 或自动办理业务。
        </p>
        {!metrics.length && (
          <p>尚未启用分析指标。管理员可在部署配置的 Analytics 中登记只读分析接口、指标口径与环境凭据引用。</p>
        )}
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        {playbooks.length > 0 && (
          <div className="ws-actions">
            {playbooks.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setMetricId(p.metricId);
                  setDays(p.days);
                  setDimensions(p.dimensions);
                  setTitle(p.title);
                  setQuestion(p.purpose);
                  setPlanned(true);
                  setKey(crypto.randomUUID());
                }}
              >
                {p.title} · v{p.version} · 只读
              </button>
            ))}
          </div>
        )}
        {metrics.length > 0 && (
          <>
            <form
              className="admin-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const r = await request<{ candidates: { metricId: string; score: number }[] }>(
                    path + '/analytics/plan',
                    { question },
                  );
                  if (r.candidates[0]?.score === 1) {
                    setMetricId(r.candidates[0].metricId);
                    setDimensions([]);
                  }
                  setPlanned(true);
                });
              }}
            >
              <label>
                想了解什么
                <input
                  required
                  minLength={2}
                  maxLength={500}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>
              <button disabled={busy}>匹配可用指标</button>
            </form>
            {planned && <p>请核对下面的指标和参数；没有可靠匹配时请自行选择。</p>}
            <form
              className="ws-ticket-filters"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const r = await request<{ report: AnalyticsReport }>(path + '/analytics/query', {
                    metricId,
                    tenant,
                    days,
                    dimensions,
                  });
                  setReport(r.report);
                });
              }}
            >
              <label>
                指标
                <select
                  required
                  value={metricId}
                  onChange={(e) => {
                    setMetricId(e.target.value);
                    setDimensions([]);
                    setKey(crypto.randomUUID());
                  }}
                >
                  <option value="">请选择</option>
                  {metrics.map((m) => (
                    <option key={m.definition.id} value={m.definition.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                租户编号
                <input
                  required
                  maxLength={128}
                  value={tenant}
                  onChange={(e) => {
                    setTenant(e.target.value);
                    setKey(crypto.randomUUID());
                  }}
                />
              </label>
              <label>
                最近完整天数
                <input
                  type="number"
                  min={1}
                  max={Math.min(90, metric?.definition.maxDays ?? 90)}
                  value={days}
                  onChange={(e) => {
                    setDays(+e.target.value);
                    setKey(crypto.randomUUID());
                  }}
                />
              </label>
              <button disabled={busy || !metric}>确认并查询</button>
            </form>
            {metric && (
              <>
                <p>
                  {metric.definition.definition} · {metric.definition.version}
                </p>
                <div className="ws-actions">
                  {metric.definition.dimensions.map((d) => (
                    <label key={d}>
                      <input
                        type="checkbox"
                        checked={dimensions.includes(d)}
                        disabled={!dimensions.includes(d) && dimensions.length >= 3}
                        onChange={(e) => {
                          setDimensions(
                            e.target.checked ? [...dimensions, d] : dimensions.filter((x) => x !== d),
                          );
                          setKey(crypto.randomUUID());
                        }}
                      />
                      {d}
                    </label>
                  ))}
                </div>
                <small>示例：{metric.questions.join(' / ')}</small>
              </>
            )}
          </>
        )}
      </section>
      {report && <AnalyticsReportView data={report} />}{' '}
      {metric && (
        <>
          <section className="admin-card">
            <h3>保存分析快照</h3>
            <label>
              标题
              <input
                required
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
            </label>
            <button
              disabled={busy || !tenant}
              onClick={() =>
                void act(async () => {
                  const r = await request<{ report: AnalyticsReport }>(path + '/analytics/query', {
                    metricId,
                    tenant,
                    days,
                    dimensions,
                    title,
                    requestKey: key,
                  });
                  setReport(r.report);
                  await onSaved();
                })
              }
            >
              重新计算并保存
            </button>
          </section>
          <ReportSchedules
            request={request}
            path={path}
            tenant={tenant}
            days={days}
            metricId={metricId}
            dimensions={dimensions}
            onReport={onReport}
          />
        </>
      )}
    </>
  );
}
