import { useEffect, useState } from 'react';
const labels: Record<string, string> = {
  identity: '网站客户身份与租户隔离',
  knowledge: '知识发布与问答回归',
  query: '业务查询与字段权限',
  action: '业务预览、确认与回读',
  observability: '日志、指标及请求关联',
  analytics: '指标口径与权威统计对账',
};
const states: Record<string, string> = {
  passed: '通过',
  failed: '失败',
  not_applicable: '不适用',
  stale: '配置已变化，需复验',
  unverified: '未验证',
};
type Data = {
  configHash: string;
  items: {
    kind: string;
    status: string;
    last: { created_at: string; note: string; evidence_ref: string } | null;
  }[];
};
export function IntegrationReadiness({
  request,
  base,
  canRecord,
}: {
  request: <T>(path: string, body?: unknown) => Promise<T>;
  base: string;
  canRecord: boolean;
}) {
  const [environment, setEnvironment] = useState('production'),
    [data, setData] = useState<Data>(),
    [kind, setKind] = useState('identity'),
    [status, setStatus] = useState('passed'),
    [note, setNote] = useState(''),
    [evidenceRef, setEvidenceRef] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setData(undefined);
    request<Data>(base + '/integrations/readiness?environment=' + environment)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, base, environment, revision]);
  return (
    <section className="admin-card">
      <h2>接入验收检查表</h2>
      <p>
        配置存在不代表验证成功。使用下方业务入口完成真实检查后，由管理员记录结果和证据编号；此表是人工验收记录，不冒充自动健康探测。配置变更后既有结果显示过期。
      </p>
      <label>
        验收环境
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          <option value="production">生产</option>
          <option value="staging">预发布</option>
          <option value="development">开发</option>
        </select>
      </label>
      {data?.items.map((i) => (
        <article className="ws-reference" key={i.kind}>
          <b>
            {labels[i.kind]} · {states[i.status]}
          </b>
          {i.last && (
            <>
              <p>{i.last.note}</p>
              <small>
                {i.last.evidence_ref} · {new Date(i.last.created_at).toLocaleString()}
              </small>
            </>
          )}
        </article>
      ))}
      {canRecord && data && (
        <details>
          <summary>记录已执行的验收</summary>
          <form
            className="admin-form"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              void request(base + '/integrations/readiness', {
                environment,
                kind,
                status,
                note,
                evidenceRef,
                configHash: data.configHash,
              })
                .then(() => {
                  setRevision((v) => v + 1);
                  setNote('');
                  setEvidenceRef('');
                  setError('验收记录已保存。');
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              检查项
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(labels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              结果
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {['passed', 'failed', 'not_applicable'].map((k) => (
                  <option key={k} value={k}>
                    {states[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              实际样本、结果及限制
              <textarea
                required
                minLength={10}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <label>
              报告 / 请求 / 工单证据编号
              <input
                required
                minLength={5}
                maxLength={500}
                value={evidenceRef}
                onChange={(e) => setEvidenceRef(e.target.value)}
              />
            </label>
            <button disabled={busy}>保存验收记录</button>
          </form>
        </details>
      )}
      {error && <p role="status">{error}</p>}
    </section>
  );
}
