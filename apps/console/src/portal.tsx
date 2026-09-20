import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Agent18, type Session, type SupportCase } from '@agent18/web-sdk';
import { CustomerHistory } from './customer-history.js';
import { KnowledgeHub } from './knowledge.js';
import { BusinessAssistant, type ActionReference } from './actions.js';
import { BusinessQueries } from './queries.js';
import { CaseConversation } from './conversation.js';
import { ProductMark } from './setup.js';
import './experience.css';

export function StandalonePortal() {
  const [actionReference, setActionReference] = useState<ActionReference>();
  const [client, setClient] = useState<Agent18>(),
    [session, setSession] = useState<Session>(),
    [name, setName] = useState('支持中心'),
    [error, setError] = useState(''),
    [page, setPage] = useState<'knowledge' | 'queries' | 'actions' | 'cases' | 'history'>('knowledge');
  useEffect(() => {
    const params = new URLSearchParams(location.search),
      project = params.get('project'),
      origin = params.get('origin'),
      channel = params.get('channel');
    if (!project || !origin || !channel || !window.opener) {
      setError('请从你的业务系统中点击“支持中心”打开此页面。登录身份会安全地传递到这里。');
      return;
    }
    let active = true,
      sdk: Agent18 | undefined;
    const pending = new Map<
      string,
      {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== window.opener || event.origin !== origin || !data || data.channel !== channel)
        return;
      const request = pending.get(data.requestId);
      if (!request) return;
      if (data.type === 'agent18:token' && typeof data.token === 'string' && data.token.length <= 8192) {
        clearTimeout(request.timer);
        pending.delete(data.requestId);
        request.resolve(data.token);
      } else if (data.type === 'agent18:identity-error') {
        clearTimeout(request.timer);
        pending.delete(data.requestId);
        request.reject(new Error('登录身份已失效，请返回业务系统重新登录。'));
      }
    };
    window.addEventListener('message', handler);
    void (async () => {
      const response = await fetch('/public/projects/' + encodeURIComponent(project));
      if (!response.ok) throw new Error('此项目尚未配置支持入口。');
      const info = await response.json();
      if (!active) return;
      if (
        !Array.isArray(info.allowedOrigins) ||
        !info.allowedOrigins.includes(origin) ||
        new URL(origin).origin !== origin
      )
        throw new Error('打开此页面的网站尚未获得接入授权。');
      setName(info.displayName);
      let pendingToken: Promise<string> | undefined;
      sdk = new Agent18({
        baseUrl: location.origin,
        projectKey: project,
        getToken: async () => {
          pendingToken ??= new Promise<string>((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const timer = setTimeout(() => {
              pending.delete(requestId);
              reject(new Error('未能获取登录身份，请从业务系统重新打开支持中心。'));
            }, 15000);
            pending.set(requestId, { resolve, reject, timer });
            window.opener?.postMessage(
              { type: 'agent18:request-token', channel, projectKey: project, requestId },
              origin,
            );
          }).finally(() => {
            pendingToken = undefined;
          });
          return pendingToken;
        },
      });
      const verified = await sdk.session();
      if (active) {
        setSession(verified);
        setClient(sdk);
      }
    })().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
      window.removeEventListener('message', handler);
      sdk?.destroy();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('页面已关闭'));
      }
      pending.clear();
    };
  }, []);
  return (
    <div className="portal-shell">
      <header className="portal-header">
        <ProductMark />
        <span className="portal-divider" />
        <b>{name}</b>
        {session && (
          <span className="portal-identity">
            <i />
            {session.principal.subject} · 当前登录用户
          </span>
        )}
      </header>
      <main className="portal-main">
        <section className="portal-hero">
          <span className="experience-kicker">YOUR PRODUCT COMPANION</span>
          <h1>需要帮助？从这里开始。</h1>
          <p>查找答案、完成业务操作，或者把问题交给支持团队。</p>
        </section>
        {error ? (
          <section className="portal-auth-card">
            <span>↗</span>
            <h2>从业务系统安全进入</h2>
            <p>{error}</p>
            <small>支持页面不会要求你重新提供账号密码，也不会通过网址接收登录 Token。</small>
          </section>
        ) : !client ? (
          <div className="portal-loading">
            <span className="loading-dot" />
            正在验证你的登录身份…
          </div>
        ) : (
          <>
            <nav className="portal-tabs">
              {(
                [
                  ['knowledge', '▤', '知识与答案'],
                  ['history', '◷', '历史对话'],
                  ['queries', '⌕', '查业务'],
                  ['actions', '↔', '办业务'],
                  ['cases', '◎', '我的问题'],
                ] as const
              ).map(([id, icon, label]) => (
                <button className={page === id ? 'selected' : ''} key={id} onClick={() => setPage(id)}>
                  <span>{icon}</span>
                  {label}
                </button>
              ))}
            </nav>
            {page === 'knowledge' && (
              <KnowledgeHub client={client} model={session?.capabilities.model === 'configured'} />
            )}{' '}
            {page === 'history' && <CustomerHistory client={client} />}
            {page === 'queries' && (
              <BusinessQueries
                client={client}
                onAction={(reference) => {
                  setActionReference(reference);
                  setPage('actions');
                }}
              />
            )}
            {page === 'actions' && (
              <>
                <div className="portal-action-note">
                  <b>经你确认，由业务系统执行。</b>
                  <span>沿用当前用户权限；执行结果以业务回执为准。</span>
                </div>
                <BusinessAssistant
                  reference={actionReference}
                  client={client}
                  model={session?.capabilities.model === 'configured'}
                />
              </>
            )}
            {page === 'cases' && <PortalCases client={client} />}
          </>
        )}
      </main>
      <footer className="experience-footer">Powered by agent18 · 让支持发生在需要的地方</footer>
    </div>
  );
}
function PortalCases({ client }: { client: Agent18 }) {
  const [selectedCase, setSelectedCase] = useState('');
  const [cases, setCases] = useState<SupportCase[]>([]),
    [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    void client
      .listCases()
      .then((r) => {
        if (active) setCases(r.cases);
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [client]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const reported = await client.reportCase({ title, description }, key.current);
      setSelectedCase(reported.case.id);
      key.current = crypto.randomUUID();
      setTitle('');
      setDescription('');
      setCases((await client.listCases()).cases);
      setMessage('问题已记录，支持团队会结合资料继续跟进。');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="portal-cases">
      <section className="setup-card">
        <h2>告诉我们发生了什么</h2>
        <p>提供操作步骤和实际表现，帮助支持团队更快理解问题。</p>
        <form onSubmit={submit}>
          <label>
            问题标题
            <input
              required
              minLength={3}
              maxLength={180}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                key.current = crypto.randomUUID();
              }}
              placeholder="例如：订单提交后没有更新状态"
            />
          </label>
          <label>
            详细说明
            <textarea
              required
              minLength={3}
              maxLength={4000}
              rows={6}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                key.current = crypto.randomUUID();
              }}
              placeholder="描述操作步骤、预期结果和实际表现。请勿填写密码或密钥。"
            />
          </label>
          <button className="experience-primary" disabled={busy}>
            {busy ? '正在提交…' : '提交问题 →'}
          </button>
        </form>
        {message && <p role="status">{message}</p>}
      </section>
      <section className="setup-card">
        <h2>我的问题记录</h2>
        {selectedCase && (
          <>
            <button className="case-back" onClick={() => setSelectedCase('')}>
              ← 返回问题列表
            </button>
            <CaseConversation
              key={selectedCase}
              client={client}
              caseId={selectedCase}
              onChanged={() =>
                void client
                  .listCases()
                  .then((r) => setCases(r.cases))
                  .catch((e) => setMessage(e.message))
              }
            />
          </>
        )}
        {!selectedCase &&
          (cases.length ? (
            cases.map((c) => (
              <article className="portal-case" key={c.id}>
                <button className="case-title" onClick={() => setSelectedCase(c.id)}>
                  {c.title} ↗
                </button>
                <span className="experience-badge">
                  {c.status === 'resolved' ? '已解决' : c.status === 'needs_human' ? '等待跟进' : '已收到'}
                </span>
                <p>{c.description}</p>
                <small>{new Date(c.createdAt).toLocaleString()}</small>
              </article>
            ))
          ) : (
            <div className="build-empty">还没有问题记录。每次求助，都会保存在这里。</div>
          ))}
      </section>
    </div>
  );
}
