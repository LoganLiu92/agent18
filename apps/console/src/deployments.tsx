import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
export function DeploymentWorkspace({ request, base }: { request: Request; base: string }) {
  type Row = {
    id: string;
    service: string;
    environment: string;
    source_name: string;
    commit_hash: string;
    artifact_digest: string;
    deployed_at: string;
    evidence_url: string;
    note: string;
    attestation: string;
    pipeline: string | null;
    revoked_at: string | null;
    activeAtTime: boolean;
  };
  type Page = { canAttest: boolean; records: Row[]; sources: { id: string; name: string }[] };
  const [data, setData] = useState<Page>(),
    [environment, setEnvironment] = useState('production'),
    [service, setService] = useState(''),
    [at, setAt] = useState(''),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [input, setInput] = useState({
      service: '',
      sourceId: '',
      commit: '',
      artifactDigest: '',
      deployedAt: '',
      evidenceUrl: '',
      note: '',
    }),
    [reason, setReason] = useState(''),
    [eventId, setEventId] = useState(crypto.randomUUID());
  const path = base + '/deployments';
  useEffect(() => {
    let active = true;
    let query = new URLSearchParams({ environment, service });
    if (at) query.set('at', new Date(at).toISOString());
    request<Page>(path + '?' + query)
      .then((p) => {
        if (active) setData(p);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path, environment, service, at, revision]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-card">
      <h2>部署版本与源码</h2>
      <p>
        按事故发生时间查找服务版本。记录区分员工人工证明与签名流水线证明；提交记录不等于已证明根因。撤销记录后不会推断此前版本仍在线。
      </p>
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="ws-ticket-filters">
        <label>
          环境
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="production">生产</option>
            <option value="staging">预发布</option>
            <option value="development">开发</option>
          </select>
        </label>
        <label>
          服务筛选
          <input value={service} onChange={(e) => setService(e.target.value)} />
        </label>
        <label>
          事故时间（留空查询现在）
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
      </div>
      {data?.records.map((r) => (
        <article className="ws-reference" key={r.id}>
          <b>
            {r.service} · {r.revoked_at ? '记录已撤销' : r.activeAtTime ? '所选时刻最近部署' : '历史部署'}
          </b>
          <small>
            {r.source_name} · {r.commit_hash} · {new Date(r.deployed_at).toLocaleString()}
          </small>
          <p>
            {r.attestation === 'operator' ? '员工人工证明' : '签名流水线 ' + r.pipeline} · {r.note}
          </p>
          <small>{r.artifact_digest}</small>
          <a href={r.evidence_url} target="_blank" rel="noreferrer">
            查看部署证明
          </a>
          {data.canAttest && !r.revoked_at && (
            <button
              disabled={busy || reason.trim().length < 5}
              onClick={() => void act(() => request(path + '/' + r.id + '/revoke', { reason }))}
            >
              撤销此记录
            </button>
          )}
        </article>
      ))}
      {data?.records.length === 0 && <p>所选范围没有可信部署记录，线上源码版本未知。</p>}
      {data?.canAttest && (
        <details>
          <summary>人工登记 / 撤销部署证明</summary>
          <label>
            撤销理由
            <input minLength={5} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <form
            className="admin-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await request(path, {
                  ...input,
                  eventId,
                  environment,
                  deployedAt: new Date(input.deployedAt).toISOString(),
                });
                setEventId(crypto.randomUUID());
              });
            }}
          >
            <label>
              服务名
              <input
                required
                value={input.service}
                onChange={(e) => {
                  setInput({ ...input, service: e.target.value });
                  setEventId(crypto.randomUUID());
                }}
              />
            </label>
            <label>
              已接入 Git 来源
              <select
                required
                value={input.sourceId}
                onChange={(e) => {
                  setInput({ ...input, sourceId: e.target.value });
                  setEventId(crypto.randomUUID());
                }}
              >
                <option value="">请选择</option>
                {data.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {(['commit', 'artifactDigest', 'deployedAt', 'evidenceUrl', 'note'] as const).map((k) => (
              <label key={k}>
                {
                  {
                    commit: '完整 Commit SHA',
                    artifactDigest: '制品 sha256 摘要',
                    deployedAt: '实际部署完成时间',
                    evidenceUrl: '部署证明 HTTPS 地址（无查询参数）',
                    note: '核对说明',
                  }[k]
                }
                <input
                  required
                  type={k === 'deployedAt' ? 'datetime-local' : k === 'evidenceUrl' ? 'url' : 'text'}
                  value={input[k]}
                  onChange={(e) => {
                    setInput({ ...input, [k]: e.target.value });
                    setEventId(crypto.randomUUID());
                  }}
                />
              </label>
            ))}
            <button disabled={busy}>保存人工证明记录</button>
          </form>
        </details>
      )}
    </section>
  );
}
