import { ReportSchedules } from './report-schedules.js';
import { AnalyticsWorkspace, AnalyticsReportView, type AnalyticsReport } from './analytics-workspace.js';
import { useEffect, useState } from 'react';
import { ticketStates } from './support-workspace.js';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Insight = {
  definitionVersion: string;
  generatedAt: string;
  start: string;
  end: string;
  timezone: string;
  scope: { allTenants: boolean; tenantIds: string[] };
  byStatus: { status: string; count: number }[];
  daily: { day: string; created: number; resolved: number }[];
  resolution: { sample: number; averageHours: number | null };
  backlog: number;
  definitions: Record<string, string>;
};
export function InsightsWorkspace({
  request,
  base,
  allowed,
}: {
  request: Request;
  base: string;
  allowed: boolean;
}) {
  const [analyticsSnapshot, setAnalyticsSnapshot] = useState<AnalyticsReport>();
  const [mode, setMode] = useState<'support' | 'business'>('support');
  const [days, setDays] = useState(30),
    [tenant, setTenant] = useState(''),
    [title, setTitle] = useState('客服运营分析'),
    [data, setData] = useState<Insight>(),
    [saved, setSaved] = useState<{ id: string; title: string; created_at: string }[]>([]),
    [offset, setOffset] = useState(0),
    [nextOffset, setNextOffset] = useState<number | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [requestKey, setRequestKey] = useState(crypto.randomUUID());
  const path = base + '/insights';
  async function reports() {
    const p = await request<{ reports: typeof saved; nextOffset: number | null }>(
      path + '/reports?offset=' + offset,
    );
    setSaved(p.reports);
    setNextOffset(p.nextOffset);
  }
  async function perform(fn: () => Promise<void>) {
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
  async function openReport(id: string) {
    const r = await request<{ payload: Insight | AnalyticsReport }>(path + '/reports/' + id);
    if ('kind' in r.payload && r.payload.kind === 'analytics') {
      setAnalyticsSnapshot(r.payload);
      setData(undefined);
    } else {
      setData(r.payload as Insight);
      setAnalyticsSnapshot(undefined);
    }
    setNotice('正在查看保存时的快照，非实时统计。');
  }
  async function refresh() {
    setData(await request<Insight>(path + '?' + new URLSearchParams({ days: String(days), tenant })));
  }
  useEffect(() => {
    let active = true;
    if (allowed)
      request<{ reports: typeof saved; nextOffset: number | null }>(path + '/reports?offset=' + offset)
        .then((p) => {
          if (active) {
            setSaved(p.reports);
            setNextOffset(p.nextOffset);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [path, request, allowed, offset]);
  if (!allowed)
    return (
      <section className="admin-card">
        <h2>需要客服或工程角色</h2>
        <p>统计结果沿用工单租户授权，知识编辑权限不会自动开放客户数据。</p>
      </section>
    );
  const total = data?.byStatus.reduce((a, b) => a + b.count, 0) ?? 0;
  function download() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ title, ...data }, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agent18-support-insight.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      {error && (
        <p className="admin-error" role="alert">
          {error === 'INSIGHT_SCOPE_REQUIRED' ? '请先在工单工作台配置租户访问范围。' : error}
        </p>
      )}
      {notice && <p className="admin-notice">{notice}</p>}
      <div className="ws-actions">
        <button onClick={() => setMode('support')}>客服运营</button>
        <button onClick={() => setMode('business')}>业务与网站分析</button>
      </div>
      {mode === 'business' && (
        <AnalyticsWorkspace request={request} base={base} onSaved={reports} onReport={openReport} />
      )}
      {mode === 'support' && (
        <section className="admin-card">
          <h2>客服运营洞察</h2>
          <p>
            根据真实工单生成固定口径统计，保留时间范围、授权范围和定义版本。业务销售等指标需要另行登记已审核的业务分析接口。
          </p>
          <form
            className="ws-ticket-filters"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(refresh);
            }}
          >
            <label>
              最近天数
              <input
                type="number"
                min={1}
                max={90}
                required
                value={days}
                onChange={(e) => {
                  setDays(+e.target.value);
                  setRequestKey(crypto.randomUUID());
                }}
              />
            </label>
            <label>
              租户编号（空表示获准范围）
              <input
                maxLength={128}
                value={tenant}
                onChange={(e) => {
                  setTenant(e.target.value);
                  setRequestKey(crypto.randomUUID());
                }}
              />
            </label>
            <button disabled={busy}>生成分析</button>
          </form>
        </section>
      )}
      {analyticsSnapshot && <AnalyticsReportView data={analyticsSnapshot} />}
      {mode === 'support' && (
        <ReportSchedules request={request} path={path} tenant={tenant} days={days} onReport={openReport} />
      )}
      {data && (
        <section className="admin-card">
          <h2>当前统计结果</h2>
          <small>
            {data.start} 至 {data.end} · {data.timezone} · {data.definitionVersion}
          </small>
          <p>范围：{data.scope.allTenants ? '项目全部租户' : data.scope.tenantIds.join('、')}</p>
          <div className="ws-stats">
            <article>
              <strong>{total}</strong>
              <span>区间内创建工单</span>
            </article>
            <article>
              <strong>{data.backlog}</strong>
              <span>当前待处理总量</span>
            </article>
            <article>
              <strong>{data.resolution.averageHours ?? '—'}</strong>
              <span>平均解决小时 · {data.resolution.sample} 个有效样本</span>
            </article>
          </div>
          <h3>按创建日查看处理结果</h3>
          <div className="ws-trend">
            {data.daily.map((row) => (
              <div key={row.day}>
                <small>{row.day}</small>
                <meter min={0} max={Math.max(1, ...data.daily.map((r) => r.created))} value={row.created} />
                <span>
                  创建 {row.created} / 当前已解决 {row.resolved}
                </span>
              </div>
            ))}
          </div>
          {!data.daily.length && <p>此范围没有工单数据。</p>}
          <div className="ws-status-row">
            {data.byStatus.map((s) => (
              <span className="ws-pill" key={s.status}>
                {ticketStates[s.status]} {s.count}
              </span>
            ))}
          </div>
          <details>
            <summary>指标口径与限制</summary>
            {Object.entries(data.definitions).map(([k, v]) => (
              <p key={k}>{v}</p>
            ))}
            <p>
              这是描述性统计，不能据此确认业务下降或故障的因果关系。重新打开、删除或改变授权范围会影响后续统计。
            </p>
          </details>
          <button onClick={download}>导出当前 JSON 报告</button>
        </section>
      )}
      <section className="admin-card">
        <h2>保存报告快照</h2>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              const r = await request<{ id: string }>(path + '/reports', { days, tenant, title, requestKey });
              await reports();
              setNotice('报告已按当前筛选重新计算并保存：' + r.id);
            });
          }}
        >
          <label>
            报告标题
            <input
              required
              minLength={2}
              maxLength={120}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setRequestKey(crypto.randomUUID());
              }}
            />
          </label>
          <button disabled={busy}>计算并保存报告</button>
        </form>
        <p>快照仅保存聚合值，不保存客户对话或日志正文；仅创建者在仍具备完整原始范围授权时可查看。</p>
        {saved.map((r) => (
          <article className="ws-reference" key={r.id}>
            <b>{r.title}</b>
            <small>{new Date(r.created_at).toLocaleString()}</small>
            <div className="ws-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await openReport(r.id);
                  })
                }
              >
                打开快照
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await request(path + '/reports/' + r.id + '/delete', {});
                    await reports();
                  })
                }
              >
                删除快照
              </button>
            </div>
          </article>
        ))}
        <div className="ws-actions">
          <button disabled={busy || !offset} onClick={() => setOffset(offset - 50)}>
            上一页
          </button>
          <button disabled={busy || nextOffset === null} onClick={() => setOffset(nextOffset!)}>
            下一页
          </button>
        </div>
      </section>
    </>
  );
}
