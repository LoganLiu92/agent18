import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Agent18, Agent18Error, type CaseDetail, type Session, type SupportCase } from '@agent18/web-sdk';
import './style.css';
import { KnowledgeHub } from './knowledge.js';
import { BusinessAssistant } from './actions.js';

type Page = 'cases' | 'knowledge' | 'actions' | 'connections';
const profiles = [
  { id: 'aurora', name: 'Aurora Studio', user: 'alice' },
  { id: 'northwind', name: 'Northwind Labs', user: 'nina' },
  { id: 'colleague', name: 'Aurora · 同租户用户', user: 'bob' },
  { id: 'other', name: 'Aurora · 另一项目', user: 'alice' },
];
const reasons: Record<string, string> = {
  CASE_AND_OUTBOX_COMMITTED: '问题报告与调查任务已持久化',
  READ_APPROVED: '只读检索通过策略检查',
  CITATIONS_VALIDATED: '引用来源与权限检查通过',
  NO_MATCHING_SOURCE: '没有匹配的资料',
  POLICY_DENIED: '策略拒绝了工具请求',
  POLICY_UNAVAILABLE: '策略服务暂不可用，等待重试',
  RETRIEVAL_COMPLETE_NEEDS_HUMAN: '资料检索已完成，等待支持人员跟进',
  NO_SOURCE_NEEDS_HUMAN: '未找到相关资料，需要人工跟进',
  CANCELLED_BY_CUSTOMER: '已停止本次调查，问题记录与历史证据继续保留',
  RETRY_RUN_CREATED: '已创建新的调查任务，历史记录继续保留',
  ATTEMPT_STARTED: '开始本次执行',
  KNOWLEDGE_LOOKUP_STARTED: '开始检索关联资料',
  ATTEMPT_BUDGET_EXHAUSTED: '自动尝试次数已用尽，可重新发起或交由支持人员处理',
  CAPABILITY_EXPIRED: '任务授权已过期，本次调查已停止',
  PREVIOUS_EXECUTION_INTERRUPTED: '上次执行被中断，已从持久化记录恢复',
  QUEUE_RETRIES_EXHAUSTED: '后台任务重试已用尽，可重新发起调查',
  QUEUE_COMPLETED_WITHOUT_RESULT: '后台任务未留下完整结果，需要重新调查',
  QUEUE_JOB_MISSING: '后台任务记录不可用，需要重新调查',
  QUEUE_CANCELLED: '后台任务已停止',
  STEP_TIMEOUT: '本次执行超时，系统将按次数限制处理',
  PROVIDER_TIMEOUT: '资料服务响应超时',
  RUN_CANCELLED: '本次调查已取消',
  INTERNAL_EXECUTION_ERROR: '执行暂时未能完成',
  PROVIDER_RESULT_REJECTED: '资料结果未通过校验，已停止使用',
};
const states = {
  pending: '等待处理',
  running: '正在检索',
  completed: '检索完成',
  blocked: '已阻止',
  cancelled: '已取消',
  failed: '执行失败',
};
const stepStates = {
  started: '开始',
  succeeded: '完成',
  failed: '失败',
  cancelled: '取消',
  interrupted: '中断',
};
const when = (date: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    cases: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M8 9h8M8 13h6M8 17h4" />
      </>
    ),
    knowledge: (
      <>
        <path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v15" />
      </>
    ),
    connections: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="1.5" />
        <rect x="15" y="15" width="6" height="6" rx="1.5" />
        <path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v6a3 3 0 0 0 3 3h6" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
    shield: (
      <>
        <path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.cases}
    </svg>
  );
}
function App() {
  const [profile, setProfile] = useState('aurora');
  const [page, setPage] = useState<Page>('cases');
  const [session, setSession] = useState<Session>();
  const [cases, setCases] = useState<SupportCase[]>([]);
  const [detail, setDetail] = useState<CaseDetail>();
  const [selected, setSelected] = useState<string>();
  const [client, setClient] = useState<Agent18>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState('');
  const formKey = useRef(crypto.randomUUID());
  const retryKeys = useRef(new Map<string, string>());
  const generation = useRef(0);
  const handleError = (err: unknown) => {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    setError(
      err instanceof Agent18Error ? `请求未完成：${err.code}` : '服务暂时无法连接，请检查本地服务后重试。',
    );
  };

  useEffect(() => {
    const current = ++generation.current;
    let sdk: Agent18 | undefined;
    const abort = new AbortController();
    setConnecting(true);
    setSession(undefined);
    setCases([]);
    setDetail(undefined);
    setSelected(undefined);
    setError('');
    setClient(undefined);
    setCreating(false);
    setBusy(false);
    const acquire = async () => {
      const response = await fetch('http://localhost:4319/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error('Identity unavailable');
      return response.json() as Promise<{ token: string; projectKey: string }>;
    };
    void (async () => {
      let identity = await acquire(),
        issued = Date.now();
      sdk = new Agent18({
        baseUrl: '',
        projectKey: identity.projectKey,
        getToken: async () => {
          if (Date.now() - issued > 240_000) {
            identity = await acquire();
            issued = Date.now();
          }
          return identity.token;
        },
      });
      sdk.setContext({ pageUrl: '/invoices', entityType: 'invoice' });
      const [nextSession, list] = await Promise.all([sdk.session(), sdk.listCases()]);
      if (current === generation.current) {
        setSession(nextSession);
        setCases(list.cases);
        setClient(sdk);
        setConnecting(false);
      }
    })().catch((err) => {
      if (current === generation.current) {
        handleError(err);
        setConnecting(false);
      }
    });
    return () => {
      abort.abort();
      sdk?.destroy();
    };
  }, [profile]);
  useEffect(() => {
    if (!client || !selected) {
      setDetail(undefined);
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const result = await client.getCase(selected);
        if (active) setDetail(result);
        const list = await client.listCases();
        if (active) setCases(list.cases);
      } catch (err) {
        if (active) handleError(err);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected, client]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!client || busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await client.reportCase({ title, description }, formKey.current);
      if (current !== generation.current) return;
      setCases((await client.listCases()).cases);
      setSelected(result.case.id);
      setCreating(false);
      setTitle('');
      setDescription('');
      formKey.current = crypto.randomUUID();
    } catch (err) {
      if (current === generation.current) handleError(err);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function controlRun(runId: string, action: 'cancel' | 'retry') {
    if (!client || !selected || busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      if (action === 'cancel') await client.cancelRun(runId);
      else {
        if (!retryKeys.current.has(runId)) retryKeys.current.set(runId, crypto.randomUUID());
        await client.retryRun(runId, retryKeys.current.get(runId)!);
      }
      const [next, list] = await Promise.all([client.getCase(selected), client.listCases()]);
      if (current === generation.current) {
        setDetail(next);
        setCases(list.cases);
      }
    } catch (err) {
      if (current === generation.current) handleError(err);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  const visible = cases.filter((item) => item.title.toLowerCase().includes(filter.toLowerCase()));
  const currentProfile = profiles.find((item) => item.id === profile)!;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="agent18 首页">
          <span className="brand-mark">
            a<span>18</span>
          </span>
          <strong>agent18</strong>
        </a>
        <div className="workspace">
          <span className="workspace-icon">A</span>
          <div>
            <b>Support workspace</b>
            <small>本地开发环境</small>
          </div>
          <span className="local-dot" />
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          {(
            [
              ['cases', '我的问题'],
              ['knowledge', '知识库'],
              ['actions', '业务助手'],
              ['connections', '接入状态'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={page === id ? 'nav active' : 'nav'}
              onClick={() => {
                setPage(id);
                setError('');
              }}
            >
              <Icon name={id} />
              {label}
              {id === 'cases' && <span className="nav-count">{cases.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="eyebrow">KNOWLEDGE + ACTIONS</span>
          <p>
            让每一步支持，
            <br />
            都有据可循。
          </p>
          <div className="progress-track">
            <span />
          </div>
          <small>身份 · 权限 · 证据 · 审计</small>
        </div>
        <div className="identity">
          <label htmlFor="profile">演示身份</label>
          <select id="profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <small>
            <span className="avatar">{currentProfile.user[0]?.toUpperCase()}</span>
            {currentProfile.user} <span className="customer-tag">客户身份</span>
          </small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            工作空间 <span className="slash">/</span>{' '}
            {page === 'cases'
              ? '我的问题'
              : page === 'knowledge'
                ? '知识库'
                : page === 'actions'
                  ? '业务助手'
                  : '接入状态'}
          </span>
          <span className="environment">
            <span className={session ? 'status-dot' : 'status-dot muted'} />
            {connecting ? '正在连接' : session ? '本地服务已连接' : '连接不可用'}
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === 'cases'
                  ? 'CUSTOMER SUPPORT'
                  : page === 'knowledge'
                    ? 'KNOWLEDGE EXPLORER'
                    : page === 'actions'
                      ? 'BUSINESS ASSISTANT'
                      : 'CONNECTED FOUNDATIONS'}
              </span>
              <h1>
                {page === 'cases'
                  ? '每个问题，都有下一步。'
                  : page === 'knowledge'
                    ? '从可信资料开始。'
                    : page === 'actions'
                      ? '从了解业务，到帮你完成。'
                      : '按需连接，逐步解锁。'}
              </h1>
              <p>
                {page === 'cases'
                  ? '收集上下文、关联资料，让支持团队接得住每一次求助。'
                  : page === 'knowledge'
                    ? '查看资料原文与来源版本，先确认信息，再作判断。'
                    : page === 'actions'
                      ? '以当前用户身份发起操作，核对预览后由业务系统执行。'
                      : '查看已经运行的基础能力，以及尚未接入的外部系统。'}
              </p>
            </div>
            {page === 'cases' && (
              <button
                className="button primary"
                disabled={!client}
                onClick={() => {
                  formKey.current = crypto.randomUUID();
                  setCreating(true);
                  setSelected(undefined);
                }}
              >
                <Icon name="plus" size={18} />
                报告问题
              </button>
            )}
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError('')} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}
          <div className="notice">
            <Icon name="shield" size={18} />
            <span>
              <b>当前接入</b> · {session?.capabilities.knowledge === 'indexed' ? '已发布知识库' : '演示资料'}{' '}
              · {session?.capabilities.model === 'configured' ? '模型已配置' : '原文检索模式'} ·{' '}
              {session?.capabilities.businessActions ? '业务助手已启用' : '业务接口待接入'}
            </span>
            <button onClick={() => setPage('connections')}>
              查看接入 <Icon name="arrow" size={14} />
            </button>
          </div>
          {page === 'cases' && (
            <>
              <section className="metrics">
                <div>
                  <small>我的问题</small>
                  <strong>{cases.length.toString().padStart(2, '0')}</strong>
                  <span>当前身份可见</span>
                </div>
                <div>
                  <small>等待跟进</small>
                  <strong>
                    {cases
                      .filter((c) => c.status === 'needs_human')
                      .length.toString()
                      .padStart(2, '0')}
                  </strong>
                  <span>资料检索后交由人工</span>
                </div>
                <div className="scope-metric">
                  <small>当前工作范围</small>
                  <strong>{session?.principal.tenantId ?? '—'}</strong>
                  <span>
                    {session
                      ? `${currentProfile.user} · ${profile === 'other' ? 'other-demo' : 'invoice-demo'}`
                      : '正在验证身份'}
                  </span>
                </div>
              </section>
              <div className={'case-layout' + (selected || creating ? ' with-detail' : '')}>
                <section className="panel case-list">
                  <div className="panel-heading">
                    <h2>
                      问题记录 <span>{cases.length}</span>
                    </h2>
                    <div className="filter">
                      <Icon name="search" size={16} />
                      <input
                        aria-label="搜索问题"
                        placeholder="搜索问题…"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      />
                    </div>
                  </div>
                  {visible.length ? (
                    <div className="rows">
                      {visible.map((item) => (
                        <button
                          className={'case-row' + (item.id === selected ? ' selected' : '')}
                          key={item.id}
                          onClick={() => {
                            setSelected(item.id);
                            setCreating(false);
                          }}
                        >
                          <span className="case-icon">
                            <Icon name="cases" />
                          </span>
                          <span className="case-text">
                            <b>{item.title}</b>
                            <small>
                              #{item.id.slice(0, 8)} <span>·</span> {when(item.createdAt)}
                            </small>
                          </span>
                          <span className={'badge ' + (item.status === 'needs_human' ? 'amber' : 'blue')}>
                            {item.status === 'needs_human' ? '待人工跟进' : '已接收'}
                          </span>
                          <Icon name="arrow" size={16} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty">
                      <div className="empty-icon">
                        <Icon name="cases" size={30} />
                      </div>
                      <h3>
                        {connecting ? '正在加载问题…' : filter ? '没有匹配的问题' : '还没有需要跟进的问题'}
                      </h3>
                      <p>
                        {filter
                          ? '试试其他关键词。'
                          : '遇到异常时，记录发生了什么。我们会把上下文和相关资料放到一起。'}
                      </p>
                      {!filter && (
                        <button
                          className="button secondary"
                          disabled={!client}
                          onClick={() => {
                            formKey.current = crypto.randomUUID();
                            setCreating(true);
                          }}
                        >
                          创建第一份报告 <span>↗</span>
                        </button>
                      )}
                    </div>
                  )}
                  <div className="panel-footer">
                    <Icon name="shield" size={14} />
                    仅展示当前项目、租户与用户自己的记录{cases.length === 100 && ' · 最多显示最近 100 条'}
                  </div>
                </section>
                {creating && (
                  <section className="panel detail">
                    <div className="panel-heading">
                      <h2>报告一个问题</h2>
                      <button
                        className="icon-button"
                        aria-label="关闭报告"
                        onClick={() => setCreating(false)}
                      >
                        ×
                      </button>
                    </div>
                    <form className="report-form" onSubmit={submit}>
                      <label>
                        简要描述
                        <input
                          autoFocus
                          required
                          minLength={3}
                          maxLength={180}
                          value={title}
                          onChange={(e) => {
                            setTitle(e.target.value);
                            formKey.current = crypto.randomUUID();
                          }}
                          placeholder="例如：发票提交后提示失败"
                        />
                      </label>
                      <label>
                        发生了什么
                        <textarea
                          required
                          minLength={3}
                          maxLength={4000}
                          value={description}
                          onChange={(e) => {
                            setDescription(e.target.value);
                            formKey.current = crypto.randomUUID();
                          }}
                          placeholder="描述操作步骤、预期结果和实际表现。请勿粘贴密码或密钥。"
                          rows={6}
                        />
                      </label>
                      <div className="attached">
                        <Icon name="connections" size={16} />
                        已附加演示页面上下文 <code>/invoices</code>
                      </div>
                      <button className="button primary" disabled={busy}>
                        {busy ? '正在保存…' : '提交问题报告'}
                        <span>↗</span>
                      </button>
                      <small>提交后会创建持久化任务，检索相关资料并记录处理过程。</small>
                    </form>
                  </section>
                )}
                {selected && !creating && (
                  <section className="panel detail">
                    <div className="panel-heading">
                      <h2>问题详情</h2>
                      <button
                        className="icon-button"
                        aria-label="关闭详情"
                        onClick={() => setSelected(undefined)}
                      >
                        ×
                      </button>
                    </div>
                    {detail ? (
                      <div className="detail-body">
                        <span className="eyebrow">CASE / {detail.case.id.slice(0, 8)}</span>
                        <h3>{detail.case.title}</h3>
                        <p className="description">{detail.case.description}</p>
                        <div className="context-chip">
                          客户端上下文 · {detail.case.context.pagePath ?? '未提供页面'}
                        </div>
                        <h4>处理进度</h4>
                        {detail.runs.map((run) => (
                          <div className="run" key={run.id}>
                            <span className={'run-dot ' + run.state} />
                            <div className="run-content">
                              <b>{states[run.state]}</b>
                              <p>{reasons[run.outcome ?? ''] ?? run.outcome ?? '等待 Worker 领取任务。'}</p>
                              <small className="run-meta">
                                已尝试 {run.attemptCount} / {run.maxAttempts} 次
                                {run.retryOf ? ' · 重新发起的调查' : ''}
                              </small>
                              {(run.canCancel || run.canRetry) && (
                                <div className="run-actions">
                                  {run.canCancel && (
                                    <button
                                      className="button secondary"
                                      disabled={busy}
                                      onClick={() => void controlRun(run.id, 'cancel')}
                                    >
                                      取消调查
                                    </button>
                                  )}
                                  {run.canRetry && (
                                    <button
                                      className="button secondary"
                                      disabled={busy}
                                      onClick={() => void controlRun(run.id, 'retry')}
                                    >
                                      重新调查
                                    </button>
                                  )}
                                </div>
                              )}
                              {run.steps.length > 0 && (
                                <details className="step-history">
                                  <summary>执行记录 · {run.steps.length} 条</summary>
                                  {run.steps.map((step) => (
                                    <div key={step.id} className="step-entry">
                                      <span>
                                        {stepStates[step.state]} · 第 {step.attempt} 次
                                      </span>
                                      <p>{reasons[step.reason] ?? step.reason}</p>
                                      <small>
                                        {when(step.createdAt)}
                                        {step.durationMs !== null ? ` · ${step.durationMs} ms` : ''}
                                      </small>
                                    </div>
                                  ))}
                                </details>
                              )}
                            </div>
                          </div>
                        ))}
                        <h4>
                          关联资料 <span>{detail.evidence.length}</span>
                        </h4>
                        {detail.evidence.length ? (
                          detail.evidence.map((item, index) => (
                            <article className="citation" key={`${item.id}-${index}`}>
                              <small>资料 · {item.version.slice(0, 12)}</small>
                              <b>{item.title}</b>
                              <p>{item.excerpt}</p>
                              <code>{item.source}</code>
                            </article>
                          ))
                        ) : (
                          <p className="muted-text">尚无可展示的引用资料。</p>
                        )}
                        <h4>审计轨迹</h4>
                        <div className="timeline">
                          {detail.audit.map((item) => (
                            <div key={item.id}>
                              <span className={item.decision === 'DENY' ? 'deny' : ''} />
                              <p>
                                {reasons[item.reason] ?? item.reason}
                                <small>
                                  {when(item.createdAt)} · {item.action}
                                </small>
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="empty">正在读取记录…</div>
                    )}
                  </section>
                )}
              </div>
            </>
          )}
          {page === 'knowledge' && client && (
            <KnowledgeHub
              key={profile}
              client={client}
              model={session?.capabilities.model === 'configured'}
            />
          )}
          {page === 'actions' && client && (
            <BusinessAssistant
              key={profile}
              client={client}
              model={session?.capabilities.model === 'configured'}
            />
          )}
          {page === 'connections' && (
            <div className="connection-grid">
              {[
                {
                  name: '身份与租户',
                  icon: 'shield',
                  status: session ? '已验证' : '未连接',
                  text: '本地 SaaS 签发短期 Token。项目、租户和用户范围由服务端验证。',
                  ready: !!session,
                },
                {
                  name: '问题与证据',
                  icon: 'cases',
                  status: '已实现',
                  text: 'PostgreSQL 持久化，Case / Run / Evidence 与审计记录按身份隔离。',
                  ready: true,
                },
                {
                  name: '知识资料',
                  icon: 'knowledge',
                  status: session?.capabilities.knowledge === 'indexed' ? '已接入索引' : '演示资料',
                  text: '配置代码和文档目录，按版本构建、审核并发布知识条目，支持来源追溯。',
                  ready: session?.capabilities.knowledge === 'indexed',
                },
                {
                  name: '权限策略',
                  icon: 'shield',
                  status: '已实现',
                  text: 'OPA 默认拒绝；知识检索和已注册业务操作经过策略检查。策略不可用时停止执行。',
                  ready: true,
                },
                {
                  name: '模型问答',
                  icon: 'connections',
                  status: session?.capabilities.model === 'configured' ? '已配置' : '待配置 API Key',
                  text: '支持部署者自己的模型接口，用于知识整理、带引用问答和业务操作规划。',
                  ready: session?.capabilities.model === 'configured',
                },
                {
                  name: '代码修复与 PR',
                  icon: 'connections',
                  status: '未接入',
                  text: '后续通过独立沙箱、测试证据与人工审批开放工程能力。',
                  ready: false,
                },
              ].map((item) => (
                <section className="panel connection-card" key={item.name}>
                  <div>
                    <span className="connection-icon">
                      <Icon name={item.icon} size={24} />
                    </span>
                    <span className={'badge ' + (item.ready ? 'green' : 'neutral')}>{item.status}</span>
                  </div>
                  <h3>{item.name}</h3>
                  <p>{item.text}</p>
                </section>
              ))}
            </div>
          )}
          <footer className="footer">
            <span>
              agent18 <span className="footer-dot">·</span> Built on evidence.
            </span>
            <span>
              Open source <span className="footer-dot">/</span> 0.3.0
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
