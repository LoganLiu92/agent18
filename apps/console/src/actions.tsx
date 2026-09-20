import { useEffect, useState, type FormEvent } from 'react';
import { Agent18, type ActionDefinition, type ActionProposal } from '@agent18/web-sdk';
const states = {
  proposed: '等待你确认',
  executing: '已发出，等待回执',
  succeeded: '操作成功',
  rejected: '业务系统拒绝',
  uncertain: '结果待确认',
  expired: '预览已过期',
};
export type ActionReference = {
  queryId: string;
  requestId: string;
  retrievedAt: string;
  row: Record<string, string | number | boolean | null>;
};
export function BusinessAssistant({
  client,
  model,
  reference,
}: {
  client: Agent18;
  model: boolean;
  reference?: ActionReference;
}) {
  const [actions, setActions] = useState<ActionDefinition[]>([]),
    [selected, setSelected] = useState(''),
    [args, setArgs] = useState<Record<string, string | number | boolean>>({});
  const [proposal, setProposal] = useState<ActionProposal>(),
    [history, setHistory] = useState<ActionProposal[]>([]),
    [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([client.listActions(), client.listActionHistory()])
      .then(([r, h]) => {
        if (active) {
          setActions(r.actions);
          setHistory(h.proposals);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [client]);
  const action = actions.find((a) => a.id === selected);
  async function perform(fn: () => Promise<ActionProposal>) {
    setBusy(true);
    setError('');
    try {
      const next = await fn();
      setProposal(next);
      setHistory((h) => [next, ...h.filter((x) => x.id !== next.id)].slice(0, 20));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function prepare(e: FormEvent) {
    e.preventDefault();
    if (action) void perform(() => client.prepareAction(action.id, args));
  }
  return (
    <div className="action-workspace">
      <section className="panel action-form">
        <span className="eyebrow">BUSINESS ASSISTANT</span>
        <h2>用你的身份，完成业务操作</h2>
        <p className="muted-text">选择操作或描述需求。先核对预览，再确认执行。</p>
        {reference && (
          <details open>
            <summary>来自查询的办理参考</summary>
            <p>
              {reference.queryId} · {new Date(reference.retrievedAt).toLocaleString()} · {reference.requestId}
            </p>
            {Object.entries(reference.row).map(([k, v]) => (
              <p key={k}>
                {k}：{String(v ?? '—')}
              </p>
            ))}
            <small>这是当时查得的记录；请选择获准操作并填写参数，业务系统将重新核对当前状态。</small>
          </details>
        )}
        {model && (
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(() => client.planAction(query));
            }}
          >
            <input
              required
              minLength={2}
              maxLength={300}
              aria-label="操作需求"
              placeholder="例如：帮我关闭邮件通知"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="button primary" disabled={busy}>
              生成预览
            </button>
          </form>
        )}
        <form onSubmit={prepare} className="report-form">
          <label>
            可用业务操作
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setProposal(undefined);
                setArgs(
                  Object.fromEntries(
                    (actions.find((a) => a.id === e.target.value)?.fields ?? [])
                      .filter((f) => f.type === 'boolean')
                      .map((f) => [f.name, false]),
                  ),
                );
              }}
            >
              <option value="">选择一个操作</option>
              {actions.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </label>
          {action && (
            <>
              <p>{action.description}</p>
              {action.fields.map((f) => (
                <label key={f.name}>
                  {f.label}
                  {f.type === 'boolean' ? (
                    <select
                      value={String(args[f.name] ?? false)}
                      onChange={(e) => setArgs({ ...args, [f.name]: e.target.value === 'true' })}
                    >
                      <option value="true">开启</option>
                      <option value="false">关闭</option>
                    </select>
                  ) : f.enum ? (
                    <select
                      required={f.required}
                      value={String(args[f.name] ?? '')}
                      onChange={(e) => setArgs({ ...args, [f.name]: e.target.value })}
                    >
                      <option value="">请选择</option>
                      {f.enum.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type === 'number' ? 'number' : 'text'}
                      required={f.required}
                      maxLength={500}
                      value={String(args[f.name] ?? '')}
                      onChange={(e) =>
                        setArgs({
                          ...args,
                          [f.name]: f.type === 'number' ? Number(e.target.value) : e.target.value,
                        })
                      }
                    />
                  )}
                </label>
              ))}
              <button className="button primary" disabled={busy}>
                预览这项操作 ↗
              </button>
            </>
          )}
        </form>
        {!actions.length && <p>当前身份没有已接入的业务操作。接入后，可用操作会出现在这里。</p>}
        {error && <p role="alert">请求未完成：{error}</p>}
      </section>
      <section className="panel action-preview">
        <h2>操作预览与回执</h2>
        {proposal ? (
          <>
            <span className={'badge ' + (proposal.state === 'succeeded' ? 'green' : 'amber')}>
              {states[proposal.state]}
            </span>
            <h3>{actions.find((a) => a.id === proposal.actionId)?.title ?? proposal.actionId}</h3>
            <p className="preview-summary">{proposal.preview.summary}</p>
            <dl>
              {Object.entries(proposal.arguments).map(([k, v]) => (
                <div key={k}>
                  <dt>
                    {actions.find((a) => a.id === proposal.actionId)?.fields.find((f) => f.name === k)
                      ?.label ?? k}
                  </dt>
                  <dd>{typeof v === 'boolean' ? (v ? '开启' : '关闭') : String(v)}</dd>
                </div>
              ))}
            </dl>
            <small className="muted-text">
              预览有效期至 {new Date(proposal.expiresAt).toLocaleTimeString()}
            </small>
            {proposal.state === 'proposed' && (
              <div className="run-actions">
                <button
                  className="button primary"
                  disabled={busy || new Date(proposal.expiresAt).getTime() <= Date.now()}
                  onClick={() => void perform(() => client.confirmAction(proposal.id))}
                >
                  {busy ? '正在确认…' : '确认执行此操作'}
                </button>
                <button className="button secondary" disabled={busy} onClick={() => setProposal(undefined)}>
                  暂不执行
                </button>
              </div>
            )}
            {['executing', 'uncertain'].includes(proposal.state) && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void perform(() => client.reconcileAction(proposal.id))}
              >
                查询业务回执
              </button>
            )}
            {proposal.result && (
              <div className="action-receipt">
                <b>{states[proposal.state]}</b>
                <p>{proposal.result.message}</p>
                {proposal.result.receiptId && <small>回执 {proposal.result.receiptId}</small>}
              </div>
            )}
          </>
        ) : (
          <div className="empty">
            <h3>每次操作，都由你确认</h3>
            <p>生成预览后，具体变更和执行结果会显示在这里。</p>
          </div>
        )}
        {!!history.length && (
          <div className="action-history">
            <h4>我的最近操作</h4>
            {history.map((p) => (
              <button key={p.id} onClick={() => void perform(() => client.getAction(p.id))}>
                <span>{actions.find((a) => a.id === p.actionId)?.title ?? p.actionId}</span>
                <small>{states[p.state]}</small>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
