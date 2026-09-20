import { DeploymentWorkspace } from './deployments.js';
import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Job = {
  id: string;
  case_id: string | null;
  kind: string;
  state: string;
  reason: string | null;
  attempts: number;
  created_at: string;
  tenant_id: string;
};
type Data = {
  enabled: boolean;
  autoInvestigate: boolean;
  intervalSeconds: number | null;
  checks: { id: string; title: string; kind: string }[];
  jobs: Job[];
  nextOffset: number | null;
  incidents: { id: string; check_id: string; state: string; occurrences: number; last_job_id: string }[];
};
type Report = {
  job: Job;
  report: {
    summary: string;
    completedAt: string;
    results: {
      checkId: string;
      title: string;
      state: string;
      error?: string;
      evidence: { id: string; summary: string; observedAt: string }[];
    }[];
    analysis: { mode: string; hypotheses: { text: string; evidenceIds: string[] }[]; nextSteps: string[] };
  } | null;
};
export function OperationsWorkspace({
  request,
  base,
  allowed,
}: {
  request: Request;
  base: string;
  allowed: boolean;
}) {
  const [data, setData] = useState<Data>(),
    [detail, setDetail] = useState<Report>(),
    [error, setError] = useState(''),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [caseId, setCaseId] = useState(''),
    [requestKey, setRequestKey] = useState(crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const path = base + '/operations';
  useEffect(() => {
    let active = true;
    if (allowed)
      request<Data>(path + '?offset=' + offset)
        .then((x) => {
          if (active) setData(x);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [path, request, offset, revision, allowed]);
  async function open(id: string) {
    setError('');
    try {
      setDetail(await request<Report>(path + '/' + id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!allowed)
    return (
      <section className="admin-card">
        <h2>需要工程角色</h2>
        <p>原始日志和运行证据还需显式租户授权。</p>
      </section>
    );
  return (
    <>
      <DeploymentWorkspace request={request} base={base} />
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="admin-notice">{notice}</p>}
      <section className="admin-card">
        <h2>调查与监控</h2>
        <p>展示已配置检查产生的真实运行记录。项目级巡检需要全项目租户授权；工单调查按获准租户隔离。</p>
        <div className="ws-status-row">
          <span className="ws-pill">{data?.enabled ? '监控已启用' : '监控未启用'}</span>
          <span>调度间隔 {data?.intervalSeconds ?? '—'} 秒</span>
          <button
            onClick={() => {
              setRevision((x) => x + 1);
              if (detail) void open(detail.job.id);
            }}
          >
            刷新
          </button>
        </div>
        <div className="ws-ticket-queue">
          {data?.checks.map((c) => (
            <article className="ws-reference" key={c.id}>
              <b>{c.title}</b>
              <p>
                {c.kind} · {c.id}
              </p>
            </article>
          ))}
        </div>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void request<{ id: string }>(path + '/investigate', { caseId, requestKey })
              .then((r) => {
                setNotice('只读调查已排队：' + r.id);
                setRevision((x) => x + 1);
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            重新调查工单
            <input
              required
              value={caseId}
              placeholder="工单 UUID"
              onChange={(e) => {
                setCaseId(e.target.value);
                setRequestKey(crypto.randomUUID());
              }}
            />
          </label>
          <button disabled={busy || !data?.enabled || !data.autoInvestigate}>提交只读调查</button>
          <small>使用已审核的固定检查配置；调查完成不会自动解决工单。</small>
        </form>
      </section>
      <div className="ws-ticket-columns">
        <section className="admin-card">
          <h3>运行队列</h3>
          {data?.jobs.map((j) => (
            <button className="ws-reference" key={j.id} onClick={() => void open(j.id)}>
              <b>
                {j.kind === 'case' ? '工单调查' : '定期巡检'} · {j.state}
              </b>
              <p>
                {j.tenant_id} · {new Date(j.created_at).toLocaleString()}
              </p>
              <small>{j.reason ?? '等待运行结果'}</small>
            </button>
          ))}
          {data && !data.jobs.length && <p>没有当前授权范围内的运行记录。</p>}
          <div className="ws-actions">
            <button disabled={!offset} onClick={() => setOffset(offset - 50)}>
              上一页
            </button>
            <button disabled={data?.nextOffset == null} onClick={() => setOffset(data!.nextOffset!)}>
              下一页
            </button>
          </div>
        </section>
        <section className="admin-card">
          <h3>持续跟踪的异常</h3>
          {data?.incidents.map((i) => (
            <article className="ws-reference" key={i.id}>
              <b>
                {i.check_id} · {i.state}
              </b>
              <p>累计 {i.occurrences} 次异常采样</p>
              <button onClick={() => void open(i.last_job_id)}>最近检查</button>
            </article>
          ))}
          {!data?.incidents.length && <p>暂无可见项目异常。</p>}
        </section>
      </div>
      {detail && (
        <section className="admin-card">
          <h2>调查报告</h2>
          <p>
            {detail.job.id} · {detail.job.state}
          </p>
          {!detail.report ? (
            <p>报告尚未生成：{detail.job.reason ?? '等待后台任务处理'}</p>
          ) : (
            <>
              <h3>{detail.report.summary}</h3>
              <small>
                {detail.report.completedAt} ·{' '}
                {detail.report.analysis.mode === 'model' ? '模型辅助分析' : '规则分析'}
              </small>
              {detail.report.results.map((r) => (
                <div className="ws-reference" key={r.checkId}>
                  <b>
                    {r.title} · {r.state}
                  </b>
                  {r.error && <p>{r.error}</p>}
                  {r.evidence.map((e) => (
                    <article key={e.id}>
                      <p>{e.summary}</p>
                      <small>
                        {e.id} · {e.observedAt}
                      </small>
                    </article>
                  ))}
                </div>
              ))}
              <h3>待验证假设</h3>
              {detail.report.analysis.hypotheses.map((h, i) => (
                <div className="ws-reference" key={i}>
                  <p>{h.text}</p>
                  <small>引用：{h.evidenceIds.join(' / ')}</small>
                </div>
              ))}
              <h3>下一步排查</h3>
              <ol>
                {detail.report.analysis.nextSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
    </>
  );
}
