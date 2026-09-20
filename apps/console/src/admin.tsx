import { useEffect, useState } from 'react';
import type { OperatorAccount, OperatorRole } from '../../server/src/operators/service.js';
import './admin.css';
import { Workspace, type WorkspacePage } from './workspace.js';

const workspacePages = [
  'projects',
  'knowledge',
  'integrations',
  'support',
  'operations',
  'insights',
  'accounts',
  'password',
  'audit',
] as const;
type AdminPage = (typeof workspacePages)[number];
const initialPage = () => {
  const page = new URLSearchParams(location.search).get('page');
  return workspacePages.includes(page as AdminPage) ? (page as AdminPage) : 'projects';
};
const roles: Record<OperatorRole, string> = {
  viewer: '查看项目',
  support: '客服处理',
  engineer: '工程排查',
  knowledge_editor: '知识编辑',
  knowledge_publisher: '知识发布',
};
type Project = { key: string; name: string; roles: OperatorRole[] };
type Session = { account: OperatorAccount; csrf: string; projects: Project[] };
type Account = OperatorAccount & { memberships: { projectKey: string; roles: OperatorRole[] }[] };
type Request = <T>(path: string, body?: unknown) => Promise<T>;
const messages: Record<string, string> = {
  OPERATOR_LOGIN_FAILED: '用户名或密码不正确，或账号已停用。',
  OPERATOR_LOGIN_REQUIRED: '登录已失效，请重新登录。',
  OPERATOR_FORBIDDEN: '你没有执行此操作的权限。',
  OPERATOR_TRY_LATER: '请求较多，请稍后再试。',
  OPERATOR_LAST_ADMIN: '必须保留至少一位可用的管理员。',
  OPERATOR_USERNAME_UNAVAILABLE: '此用户名已被使用。',
  OPERATOR_PASSWORD_INVALID: '当前密码不正确。',
  OPERATOR_CSRF_REQUIRED: '会话校验已失效，请刷新页面后重试。',
  KNOWLEDGE_AUDIENCE_IMMUTABLE: '文档受众已固定。请从已审核的内部文档创建独立客户版本。',
  KNOWLEDGE_EVIDENCE_HASH_MISMATCH: '证据原文指纹不一致，请重新扫描核对，当前操作未完成。',
  KNOWLEDGE_TOPIC_NOT_CONFIRMED: '请先确认主题范围，再生成文档。',
  GENERATION_INPUT_TOO_LARGE: '所选原文超过本次生成预算，请减少选择的证据。',
  KNOWLEDGE_SOURCE_URL_INVALID: 'Git 地址必须为 HTTPS，不能包含凭据、参数或自定义端口。',
  KNOWLEDGE_SOURCE_EXISTS: '来源标识已存在，请使用新的标识。',
  KNOWLEDGE_NOT_FOUND: '文档不存在或无权访问。',
  KNOWLEDGE_VERSION_CONFLICT: '文档已被其他人更新，请重新打开最新修订。',
  KNOWLEDGE_STATE_CONFLICT: '当前状态不支持此操作，请重新打开文档。',
  KNOWLEDGE_SECRET_DETECTED: '正文中检测到疑似密钥，请移除后再保存。',
  SOURCE_JOB_ACTIVE: '该来源正在排队或扫描，请先等待完成或取消任务。',
  SOURCE_IDENTITY_IMMUTABLE: '来源标识和类型不可更改，请创建独立连接。',
  TICKET_VERSION_CONFLICT: '工单已被其他人更新，请刷新后重新操作。',
  TICKET_NOT_FOUND: '工单不存在或不在你的授权范围。',
  TICKET_STATE_CONFLICT: '当前工单状态不允许此操作，请刷新核对。',
  TICKET_RESOLUTION_REQUIRED: '请填写内部解决说明和可向客户展示的结果。',
  IDEMPOTENCY_CONFLICT: '此次请求与已保存内容不同，请刷新后重新提交。',
  KNOWLEDGE_EVAL_SOURCE_INVALID: '评测只能选择当前已发布、面向全部客户的来源。',
  KNOWLEDGE_EVAL_LIMIT: '评测集已达到 100 题，请先归档不再使用的问题。',
  INVALID_REQUEST: '提交内容不符合要求，请检查必填项和长度。',
};
export function AdminWorkspace() {
  const [session, setSession] = useState<Session>(),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [page, setPage] = useState<AdminPage>(initialPage);
  const [projectKey, setProjectKey] = useState(
    () => new URLSearchParams(location.search).get('project') ?? '',
  );
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('page', page);
    if (projectKey) url.searchParams.set('project', projectKey);
    history.replaceState(null, '', url);
  }, [page, projectKey]);
  const [accounts, setAccounts] = useState<Account[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('all'),
    [accountQuery, setAccountQuery] = useState({ search: '', status: 'all' });
  const request: Request = async (path, body) => {
    const r = await fetch('/operator/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers:
        body === undefined
          ? {}
          : { 'content-type': 'application/json', 'x-operator-csrf': session?.csrf ?? '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 401) setSession(undefined);
      throw new Error(messages[data.error?.code] ?? data.error?.code ?? '请求失败');
    }
    return data;
  };
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/operator/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (r) => {
        if (r.status === 401) return;
        if (!r.ok) throw new Error('后台暂时不可用，请检查服务。');
        setSession(await r.json());
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });
    return () => controller.abort();
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refreshAccounts(query = accountQuery, after?: string) {
    const params = new URLSearchParams({ ...query, ...(after ? { after } : {}) });
    const data = await request<{ accounts: Account[]; nextCursor: string | null }>('accounts?' + params);
    setAccounts((previous) => (after ? [...previous, ...data.accounts] : data.accounts));
    setAccountQuery(query);
    setNextCursor(data.nextCursor);
  }
  useEffect(() => {
    if (page !== 'accounts' || !session?.account.administrator || session.account.mustChangePassword) return;
    let active = true;
    void request<{ accounts: Account[]; nextCursor: string | null }>('accounts')
      .then((data) => {
        if (active) {
          setAccounts(data.accounts);
          setNextCursor(data.nextCursor);
          setAccountQuery({ search: '', status: 'all' });
          setSearch('');
          setStatus('all');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [page, session?.csrf]);
  const banners = (
    <>
      {error && (
        <div role="alert" className="admin-error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="admin-notice">
          {notice}
        </div>
      )}
    </>
  );
  if (!loaded)
    return (
      <main className="admin-login">
        <p>正在读取登录状态…</p>
      </main>
    );
  if (!session)
    return (
      <main className="admin-login">
        <section className="admin-intro">
          <a className="admin-brand" href="/">
            agent18
          </a>
          <p className="admin-kicker">你的产品 · 你的工作空间</p>
          <h1>
            让知识与支持
            <br />
            持续积累。
          </h1>
          <p>使用 Agent18 独立账号登录后台，管理自己的项目和工作人员。网站客户仍使用原有登录方式。</p>
        </section>
        <form
          className="admin-card"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request('login', { username, password });
              setPassword('');
              const next = await request<Session>('session');
              setSession(next);
              setAccounts([]);
              setPage(next.account.mustChangePassword ? 'password' : 'projects');
            });
          }}
        >
          <h2>登录工作空间</h2>
          {banners}
          <label>
            用户名
            <input
              autoFocus
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
          <p className="admin-muted">首次使用：部署者在本地初始化向导中创建管理员。后台不开放自行注册。</p>
        </form>
      </main>
    );
  const currentPage = session.account.mustChangePassword
    ? 'password'
    : !session.account.administrator && ['accounts', 'audit'].includes(page)
      ? 'projects'
      : page;
  const project = session.projects.find((p) => p.key === projectKey) ?? session.projects[0];
  return (
    <div className="admin-shell">
      <aside>
        <a className="admin-brand" href="/admin">
          agent18
        </a>
        <span className="ws-edition">PRODUCT WORKSPACE</span>
        <label className="ws-project-select">
          当前项目
          <select
            value={project?.key ?? ''}
            disabled={session.account.mustChangePassword}
            onChange={(e) => setProjectKey(e.target.value)}
          >
            {session.projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <p className="admin-kicker">工作空间</p>
        <nav aria-label="后台导航">
          {(
            [
              ['projects', '◈', '工作概览'],
              ['knowledge', '▤', '知识中心'],
              ['support', '▱', '客户支持'],
              ['operations', '⌁', '运行与排查'],
              ['insights', '↗', '业务洞察'],
              ['integrations', '⊞', '集成与接入'],
            ] as const
          ).map(([key, icon, label]) => (
            <button
              key={key}
              disabled={session.account.mustChangePassword}
              className={currentPage === key ? 'selected' : ''}
              onClick={() => setPage(key)}
            >
              <span className="ws-nav-icon" aria-hidden="true">
                {icon}
              </span>
              {label}
            </button>
          ))}
          <p className="admin-kicker">管理与治理</p>
          {session.account.administrator && (
            <button
              disabled={busy || session.account.mustChangePassword}
              className={currentPage === 'accounts' ? 'selected' : ''}
              onClick={() => setPage('accounts')}
            >
              工作人员
            </button>
          )}
          {session.account.administrator && (
            <button
              disabled={busy || session.account.mustChangePassword}
              className={currentPage === 'audit' ? 'selected' : ''}
              onClick={() => setPage('audit')}
            >
              操作审计
            </button>
          )}
          <button
            className={currentPage === 'password' ? 'selected' : ''}
            onClick={() => setPage('password')}
          >
            账号与密码
          </button>
        </nav>
        <div className="admin-identity">
          <b>{session.account.displayName}</b>
          <small>{session.account.administrator ? '部署管理员' : '工作人员'}</small>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await request('logout', {});
                setSession(undefined);
                setAccounts([]);
                setPassword('');
              })
            }
          >
            退出登录
          </button>
        </div>
      </aside>
      <main>
        <header>
          <span>
            工作空间 <span className="ws-slash">/</span> {project?.name ?? '项目'}
          </span>
          <span>{session.account.username}</span>
        </header>
        <div className="admin-content">
          {banners}
          {(
            ['projects', 'knowledge', 'support', 'operations', 'insights', 'integrations'] as string[]
          ).includes(currentPage) &&
            (project ? (
              <Workspace
                key={project.key}
                page={currentPage as WorkspacePage}
                project={project}
                administrator={session.account.administrator}
                request={request}
                navigate={setPage}
              />
            ) : (
              <section className="admin-card">
                <h1>还没有可访问的项目</h1>
                <p>请联系管理员分配项目和角色后重新登录。</p>
              </section>
            ))}
          {currentPage === 'password' && (
            <PasswordForm
              request={request}
              busy={busy}
              act={act}
              required={session.account.mustChangePassword}
              onChanged={() => {
                setSession(undefined);
                setPassword('');
                setNotice('密码已更新，请使用新密码登录。');
              }}
            />
          )}
          {currentPage === 'accounts' && (
            <>
              <p className="admin-kicker">TEAM</p>
              <h1>工作人员</h1>
              <p className="admin-muted">
                新账号首次登录须修改临时密码。权限修改、停用和密码重置会立即使旧会话失效。
              </p>
              <CreateAccount
                busy={busy}
                act={act}
                request={request}
                onCreated={async () => {
                  await refreshAccounts();
                  setNotice('账号已创建，请分配项目权限。');
                }}
              />
              <form
                className="admin-filter"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() => refreshAccounts({ search, status }));
                }}
              >
                <label>
                  查找工作人员
                  <input
                    value={search}
                    maxLength={100}
                    placeholder="用户名或显示名称"
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <label>
                  账号状态
                  <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="all">全部</option>
                    <option value="enabled">可登录</option>
                    <option value="disabled">已停用</option>
                  </select>
                </label>
                <button disabled={busy}>筛选账号</button>
              </form>
              {!accounts.length && <p role="status">没有符合条件的工作人员。</p>}
              <div className="admin-grid">
                {accounts.map((a) => (
                  <AccountEditor
                    key={a.id}
                    account={a}
                    projects={session.projects}
                    request={request}
                    busy={busy}
                    act={act}
                    refresh={async () => {
                      await refreshAccounts();
                      setNotice('账号已更新，旧会话已失效。');
                    }}
                    self={a.id === session.account.id}
                    onSelfChanged={() => {
                      setSession(undefined);
                      setNotice('你的账号已更新，请重新登录。');
                    }}
                  />
                ))}
              </div>
              {nextCursor && (
                <button
                  className="admin-more"
                  disabled={busy}
                  onClick={() => void act(() => refreshAccounts(accountQuery, nextCursor))}
                >
                  加载更多账号
                </button>
              )}
            </>
          )}
          {currentPage === 'audit' && <AuditLog request={request} busy={busy} act={act} />}
        </div>
      </main>
    </div>
  );
}
type FormProps = { request: Request; busy: boolean; act: (fn: () => Promise<void>) => Promise<void> };
function PasswordForm({
  request,
  busy,
  act,
  required,
  onChanged,
}: FormProps & { required: boolean; onChanged: () => void }) {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [repeat, setRepeat] = useState('');
  return (
    <section className="admin-card admin-narrow">
      <h1>{required ? '设置你的密码' : '修改密码'}</h1>
      <p>密码至少 15 个字符。修改后所有已登录会话都会退出。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            if (next !== repeat) throw new Error('两次新密码不一致。');
            await request('password', { currentPassword: current, password: next });
            setCurrent('');
            setNext('');
            setRepeat('');
            onChanged();
          });
        }}
      >
        <label>
          当前密码
          <input
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            required
            minLength={15}
            maxLength={128}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label>
          确认新密码
          <input
            type="password"
            required
            minLength={15}
            maxLength={128}
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <button disabled={busy}>保存并重新登录</button>
      </form>
    </section>
  );
}
function CreateAccount({ request, busy, act, onCreated }: FormProps & { onCreated: () => Promise<void> }) {
  const [username, setUsername] = useState(''),
    [displayName, setDisplayName] = useState(''),
    [password, setPassword] = useState('');
  return (
    <details className="admin-card">
      <summary>添加工作人员</summary>
      <form
        className="admin-form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await request('accounts', { username, displayName, password });
            setUsername('');
            setDisplayName('');
            setPassword('');
            await onCreated();
          });
        }}
      >
        <label>
          用户名
          <input
            required
            minLength={3}
            maxLength={80}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          显示名称
          <input
            required
            maxLength={100}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label>
          临时密码
          <input
            type="password"
            required
            minLength={15}
            maxLength={128}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button disabled={busy}>创建账号</button>
      </form>
    </details>
  );
}
function AccountEditor({
  account,
  projects,
  request,
  busy,
  act,
  refresh,
  self,
  onSelfChanged,
}: FormProps & {
  account: Account;
  projects: Project[];
  refresh: () => Promise<void>;
  self: boolean;
  onSelfChanged: () => void;
}) {
  const [enabled, setEnabled] = useState(account.enabled),
    [admin, setAdmin] = useState(account.administrator),
    [memberships, setMemberships] = useState(account.memberships),
    [password, setPassword] = useState('');
  useEffect(() => {
    setEnabled(account.enabled);
    setAdmin(account.administrator);
    setMemberships(account.memberships);
  }, [account]);
  return (
    <section className="admin-card">
      <h2>
        {account.displayName}
        {self ? '（你）' : ''}
      </h2>
      <p className="admin-muted">
        {account.username} · {account.enabled ? '可登录' : '已停用'}
        {account.mustChangePassword ? ' · 待修改密码' : ''}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await request('accounts/' + account.id, { enabled, administrator: admin, memberships });
            if (self) onSelfChanged();
            else await refresh();
          });
        }}
      >
        <label className="admin-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          允许登录
        </label>
        <label className="admin-check">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          部署管理员（所有项目与账号管理）
        </label>
        {!admin &&
          projects.map((p) => (
            <fieldset key={p.key}>
              <legend>{p.name}</legend>
              {Object.entries(roles).map(([r, label]) => (
                <label className="admin-check" key={r}>
                  <input
                    type="checkbox"
                    checked={
                      memberships.find((m) => m.projectKey === p.key)?.roles.includes(r as OperatorRole) ??
                      false
                    }
                    onChange={(e) =>
                      setMemberships((old) => {
                        const existing = old.find((m) => m.projectKey === p.key)?.roles ?? [];
                        const next = e.target.checked
                          ? [...existing, r as OperatorRole]
                          : existing.filter((v) => v !== r);
                        return [
                          ...old.filter((m) => m.projectKey !== p.key),
                          ...(next.length ? [{ projectKey: p.key, roles: next }] : []),
                        ];
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          ))}
        <button disabled={busy}>保存权限并使旧会话失效</button>
      </form>
      <details>
        <summary>重置临时密码</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request('accounts/' + account.id + '/password', { password });
              setPassword('');
              if (self) onSelfChanged();
              else await refresh();
            });
          }}
        >
          <label>
            新临时密码
            <input
              type="password"
              required
              minLength={15}
              maxLength={128}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button disabled={busy}>重置密码</button>
        </form>
      </details>
    </section>
  );
}

type AuditEvent = {
  id: string;
  action: string;
  actorId: string | null;
  actorUsername: string | null;
  targetId: string | null;
  targetUsername: string | null;
  requestId: string;
  createdAt: string;
};
const auditActions: Record<string, string> = {
  'operator.bootstrap': '初始化管理员',
  'operator.login': '登录',
  'operator.logout': '退出登录',
  'operator.create': '创建账号',
  'operator.permissions': '修改权限或状态',
  'operator.password': '修改密码',
  'operator.password.reset': '重置密码',
  'operator.local_recovery': '部署者本地恢复',
  'operator.restore.sessions_revoked': '备份恢复后撤销会话',
};
function AuditLog({ request, busy, act }: FormProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]),
    [next, setNext] = useState<string | null>(null),
    [action, setAction] = useState(''),
    [applied, setApplied] = useState(''),
    [loaded, setLoaded] = useState(false);
  async function load(filter: string, before?: string) {
    const params = new URLSearchParams({
      ...(filter ? { action: filter } : {}),
      ...(before ? { before } : {}),
    });
    const data = await request<{ events: AuditEvent[]; nextCursor: string | null }>('audit?' + params);
    setEvents((old) => (before ? [...old, ...data.events] : data.events));
    setNext(data.nextCursor);
    setApplied(filter);
    setLoaded(true);
  }
  useEffect(() => {
    void act(() => load(''));
  }, []);
  return (
    <>
      <p className="admin-kicker">AUDIT</p>
      <h1>操作审计</h1>
      <p className="admin-muted">查看账号管理与会话操作记录。密码和会话凭据不会显示在记录中。</p>
      <form
        className="admin-filter"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => load(action));
        }}
      >
        <label>
          操作类型
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">全部操作</option>
            {Object.entries(auditActions).map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy}>查询记录</button>
      </form>
      {!loaded && <p>正在读取审计记录…</p>}
      {loaded && !events.length && <p role="status">没有符合条件的审计记录。</p>}
      <div className="admin-audit-list">
        {events.map((event) => (
          <article className="admin-card" key={event.id}>
            <div className="admin-audit-heading">
              <h2>{auditActions[event.action] ?? event.action}</h2>
              <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
            </div>
            <dl>
              <dt>操作者</dt>
              <dd>
                {event.actorUsername ??
                  (event.action === 'operator.local_recovery' ? '部署者（本地维护）' : '部署维护流程')}
              </dd>
              <dt>目标账号</dt>
              <dd>{event.targetUsername ?? event.targetId ?? '全部会话'}</dd>
              <dt>请求编号</dt>
              <dd>{event.requestId}</dd>
            </dl>
          </article>
        ))}
      </div>
      {next && (
        <button className="admin-more" disabled={busy} onClick={() => void act(() => load(applied, next))}>
          加载更早记录
        </button>
      )}
    </>
  );
}
