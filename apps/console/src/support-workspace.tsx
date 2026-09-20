import { TicketSyncPanel } from './ticket-sync.js';
import { SupportNotifications, SlaSettings } from './support-followup.js';
import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
export const ticketStates: Record<string, string> = {
  new: '新建',
  open: '处理中',
  investigating: '调查中',
  waiting_customer: '等待客户',
  waiting_internal: '等待内部',
  resolved: '已解决',
  closed: '已关闭',
};
const priorities: Record<string, string> = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
type Ticket = {
  id: string;
  title: string;
  description: string;
  tenant_id: string;
  subject: string;
  ticket_status: string;
  priority: string;
  assignee_id: string | null;
  assignee?: string;
  team: string;
  ticket_version: number;
  created_at: string;
  updated_at: string;
  context: Record<string, unknown>;
  resolution?: { summary: string; rootCause: string; verification: string; publicSummary: string };
  public_resolution: string | null;
  firstResponseSla: {
    targetMinutes: number;
    elapsedMinutes: number;
    completed: boolean;
    breached: boolean;
  } | null;
  sla: { targetMinutes: number; elapsedMinutes: number; paused: boolean; breached: boolean } | null;
};
type Detail = {
  ticket: Ticket;
  messages: { id: string; author_kind: string; body: string; created_at: string }[];
  notes: { id: string; body: string; author: string; created_at: string }[];
  events: { id: string; action: string; actor: string | null; detail: unknown; created_at: string }[];
  truncated: boolean;
  assignees: { id: string; display_name: string }[];
  engineering: boolean;
  actorId: string;
  transitions: string[];
};
type Page = {
  tickets: Ticket[];
  nextOffset: number | null;
  grant: { all_tenants: boolean; tenant_ids: string[] };
  tenants: { tenant_id: string; display_name: string }[];
};
const when = (value: string) => new Date(value).toLocaleString('zh-CN');
export function SupportWorkspace({
  request,
  base,
  administrator,
  canRead,
  canCreateKnowledge,
}: {
  request: Request;
  base: string;
  administrator: boolean;
  canRead: boolean;
  canCreateKnowledge: boolean;
}) {
  const [page, setPage] = useState<Page>(),
    [detail, setDetail] = useState<Detail>(),
    [offset, setOffset] = useState(0),
    [status, setStatus] = useState('all'),
    [priority, setPriority] = useState('all'),
    [tenant, setTenant] = useState(''),
    [search, setSearch] = useState(''),
    [mine, setMine] = useState(false),
    [query, setQuery] = useState(''),
    [team, setTeam] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const path = base + '/tickets';
  const filters = new URLSearchParams({
    status,
    team,
    priority,
    tenant,
    search: query,
    mine: String(mine),
    offset: String(offset),
  }).toString();
  async function refresh() {
    setPage(await request<Page>(path + '?' + filters));
  }
  useEffect(() => {
    let active = true;
    if (canRead)
      request<Page>(path + '?' + filters)
        .then((v) => {
          if (active) setPage(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [path, filters, request, canRead]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      if (['NOT_FOUND', 'OPERATOR_FORBIDDEN'].includes((e as Error).message)) setDetail(undefined);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setDetail(await request<Detail>(path + '/' + id));
  }
  async function update(input: Record<string, unknown>) {
    if (!detail) return;
    const id = detail.ticket.id;
    await request(path + '/' + id, { version: detail.ticket.ticket_version, ...input });
    await open(id);
    setNotice('工单已更新，操作记录已保存。');
  }
  return (
    <>
      {administrator && (
        <>
          <TenantAccess request={request} base={base} changed={() => void refresh()} />
          <SlaSettings request={request} base={base} />
        </>
      )}
      {canRead && (
        <SupportNotifications
          request={request}
          base={base}
          revision={detail?.ticket.ticket_version ?? 0}
          open={(id) => void perform(() => open(id))}
        />
      )}
      {!canRead ? (
        <section className="admin-card">
          <h2>需要客服或工程角色</h2>
          <p>知识编辑身份不会自动获得客户工单和运行证据。</p>
        </section>
      ) : (
        <>
          {error && (
            <p className="admin-error" role="alert">
              {error === 'TICKET_VERSION_CONFLICT' ? '工单已更新，请刷新详情后重新操作。' : error}
            </p>
          )}
          {notice && <p className="admin-notice">{notice}</p>}
          {page && !page.grant.all_tenants && !page.grant.tenant_ids.length && (
            <p className="admin-notice">
              尚未获得任何租户范围。请管理员显式授予本项目允许访问的租户；管理员也需设置自己的范围。
            </p>
          )}
          <form
            className="ws-ticket-filters"
            onSubmit={(e) => {
              e.preventDefault();
              setOffset(0);
              setQuery(search);
            }}
          >
            <label>
              团队队列
              <input
                maxLength={100}
                placeholder="按团队精确筛选"
                value={team}
                onChange={(e) => {
                  setTeam(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <label>
              搜索工单
              <input
                value={search}
                maxLength={100}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="按标题搜索"
              />
            </label>
            <label>
              状态
              <select
                value={status}
                onChange={(e) => {
                  setOffset(0);
                  setStatus(e.target.value);
                }}
              >
                <option value="all">全部状态</option>
                {Object.entries(ticketStates).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              优先级
              <select
                value={priority}
                onChange={(e) => {
                  setOffset(0);
                  setPriority(e.target.value);
                }}
              >
                <option value="all">全部优先级</option>
                {Object.entries(priorities).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              租户
              <select
                value={tenant}
                onChange={(e) => {
                  setOffset(0);
                  setTenant(e.target.value);
                }}
              >
                <option value="">获准的全部租户</option>
                {page?.tenants.map((t) => (
                  <option key={t.tenant_id} value={t.tenant_id}>
                    {t.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="ws-check">
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => {
                  setMine(e.target.checked);
                  setOffset(0);
                }}
              />
              分配给我
            </label>
            <button disabled={busy}>筛选</button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (detail) await open(detail.ticket.id);
                })
              }
            >
              刷新
            </button>
          </form>
          <div className="ws-ticket-queue">
            {page?.tickets.map((t) => (
              <button
                className={detail?.ticket.id === t.id ? 'selected' : ''}
                key={t.id}
                onClick={() => void perform(() => open(t.id))}
              >
                <span className="ws-pill">{ticketStates[t.ticket_status]}</span>
                <b>{t.title}</b>
                <small>
                  {t.tenant_id} · {priorities[t.priority]} · {t.assignee ?? '待分配'}
                </small>
              </button>
            ))}
          </div>
          {page && !page.tickets.length && (
            <section className="admin-card">
              当前筛选范围内没有工单。客户在网站助手确认问题报告后，工单会出现在这里。
            </section>
          )}
          <div className="ws-actions">
            <button disabled={busy || offset === 0} onClick={() => setOffset(offset - 50)}>
              上一页工单
            </button>
            <button disabled={busy || page?.nextOffset == null} onClick={() => setOffset(page!.nextOffset!)}>
              下一页工单
            </button>
          </div>
          {detail && (
            <section className="admin-card ws-ticket-detail">
              <div className="ws-status-row">
                <span className="ws-pill">{ticketStates[detail.ticket.ticket_status]}</span>
                <small>
                  修订 {detail.ticket.ticket_version} · {when(detail.ticket.updated_at)}
                </small>
              </div>
              <h2>{detail.ticket.title}</h2>
              {detail.ticket.firstResponseSla && (
                <p className={detail.ticket.firstResponseSla.breached ? 'admin-error' : 'admin-notice'}>
                  首次公开回复 · {detail.ticket.firstResponseSla.elapsedMinutes} /{' '}
                  {detail.ticket.firstResponseSla.targetMinutes} 分钟 ·{' '}
                  {detail.ticket.firstResponseSla.completed ? '已回复' : '计时中'}
                  {detail.ticket.firstResponseSla.breached ? ' · 已超时' : ''}
                </p>
              )}
              {detail.ticket.sla && (
                <p className={detail.ticket.sla.breached ? 'admin-error' : 'admin-notice'}>
                  SLA · {detail.ticket.sla.elapsedMinutes} / {detail.ticket.sla.targetMinutes} 分钟 ·{' '}
                  {detail.ticket.sla.paused ? '计时暂停' : '计时中'}
                  {detail.ticket.sla.breached ? ' · 已超时' : ''}
                </p>
              )}
              <small>工单 {detail.ticket.id}</small>
              <TicketSyncPanel
                request={request}
                base={base}
                ticketId={detail.ticket.id}
                version={detail.ticket.ticket_version}
                onChanged={() => open(detail.ticket.id)}
              />
              <div className="ws-ticket-columns">
                <section>
                  <h3>客户沟通</h3>
                  <small>
                    {detail.ticket.tenant_id} / {detail.ticket.subject}
                  </small>
                  <div className="ws-prose">{detail.ticket.description}</div>
                  {detail.messages.map((m) => (
                    <article className="ws-reference" key={m.id}>
                      <b>{m.author_kind === 'customer' ? '客户' : '支持团队'}</b>
                      <p>{m.body}</p>
                      <small>{when(m.created_at)}</small>
                    </article>
                  ))}
                  <TicketReply
                    key={'reply-' + detail.ticket.id}
                    busy={busy}
                    send={(body, requestKey) => perform(() => update({ action: 'reply', body, requestKey }))}
                  />
                </section>
                <section>
                  <h3>上下文与调查</h3>
                  <ContextCapsule context={detail.ticket.context} />
                  {detail.engineering ? (
                    <TicketInvestigation
                      key={detail.ticket.id}
                      request={request}
                      path={path + '/' + detail.ticket.id}
                    />
                  ) : (
                    <p className="admin-muted">原始运行证据仅对具备工程权限及对应租户范围的工作人员开放。</p>
                  )}
                  <h3>内部备注</h3>
                  {detail.notes.map((n) => (
                    <article className="ws-reference" key={n.id}>
                      <p>{n.body}</p>
                      <small>
                        {n.author} · {when(n.created_at)}
                      </small>
                    </article>
                  ))}
                  <TicketReply
                    key={'note-' + detail.ticket.id}
                    busy={busy}
                    internal
                    send={(body, requestKey) => perform(() => update({ action: 'note', body, requestKey }))}
                  />
                </section>
                <section>
                  <h3>处理与分配</h3>
                  <TicketAssignment
                    key={'assign-' + detail.ticket.id + detail.ticket.ticket_version}
                    detail={detail}
                    busy={busy}
                    save={(v) => void perform(() => update({ action: 'assign', ...v }))}
                  />
                  <TicketTransition
                    key={'state-' + detail.ticket.id + detail.ticket.ticket_version}
                    detail={detail}
                    busy={busy}
                    save={(v) => void perform(() => update({ action: 'status', ...v }))}
                  />
                  {detail.ticket.resolution && (
                    <section className="ws-evidence">
                      <h3>解决方案</h3>
                      <p>{detail.ticket.resolution.summary}</p>
                      <small>
                        原因验证：
                        {
                          (
                            {
                              hypothesis: '待验证假设',
                              supported: '有证据支持',
                              verified: '人工核实',
                            } as Record<string, string>
                          )[detail.ticket.resolution.verification]
                        }
                      </small>
                      <p>{detail.ticket.resolution.rootCause}</p>
                      <b>客户公开说明</b>
                      <p>{detail.ticket.public_resolution}</p>
                      {canCreateKnowledge && ['resolved', 'closed'].includes(detail.ticket.ticket_status) && (
                        <TicketKnowledge request={request} base={base} ticket={detail.ticket} />
                      )}
                    </section>
                  )}
                  <details>
                    <summary>流转记录</summary>
                    {detail.events.map((e) => (
                      <div className="ws-reference" key={e.id}>
                        <b>
                          {e.action} · {e.actor ?? '系统'}
                        </b>
                        <small>{when(e.created_at)}</small>
                        <pre className="ws-source-text">{JSON.stringify(e.detail, null, 2)}</pre>
                      </div>
                    ))}
                  </details>
                </section>
              </div>
              <TicketHistory request={request} path={path + '/' + detail.ticket.id} key={detail.ticket.id} />
              {detail.truncated && (
                <p>部分历史超过显示上限，保留在数据库中；较早记录可通过下方历史分页查看。</p>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
function TicketReply({
  busy,
  internal = false,
  send,
}: {
  busy: boolean;
  internal?: boolean;
  send: (body: string, key: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState(''),
    [key, setKey] = useState(crypto.randomUUID());
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send(body, key).then((ok) => {
          if (ok) {
            setBody('');
            setKey(crypto.randomUUID());
          }
        });
      }}
    >
      <label>
        {internal ? '内部备注（客户不可见）' : '公开回复（客户可见）'}
        <textarea
          required
          maxLength={4000}
          rows={4}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setKey(crypto.randomUUID());
          }}
        />
      </label>
      <button disabled={busy || !body.trim()}>{internal ? '保存内部备注' : '发送公开回复'}</button>
      <small>重复提交相同内容和请求键不会生成第二条消息。</small>
    </form>
  );
}
function TicketAssignment({
  detail,
  busy,
  save,
}: {
  detail: Detail;
  busy: boolean;
  save: (value: { assigneeId: string | null; team: string; priority: string }) => void;
}) {
  const [assignee, setAssignee] = useState(detail.ticket.assignee_id ?? ''),
    [team, setTeam] = useState(detail.ticket.team),
    [priority, setPriority] = useState(detail.ticket.priority);
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        save({ assigneeId: assignee || null, team, priority });
      }}
    >
      <label>
        负责人
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">未分配</option>
          {detail.assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name}
            </option>
          ))}
        </select>
      </label>
      <label>
        团队
        <input maxLength={100} value={team} onChange={(e) => setTeam(e.target.value)} />
      </label>
      <label>
        优先级
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          {Object.entries(priorities).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy}>保存分配</button>
    </form>
  );
}
function TicketTransition({
  detail,
  busy,
  save,
}: {
  detail: Detail;
  busy: boolean;
  save: (value: Record<string, unknown>) => void;
}) {
  const [status, setStatus] = useState(detail.transitions[0] ?? 'open'),
    [reason, setReason] = useState(''),
    [summary, setSummary] = useState(''),
    [rootCause, setRootCause] = useState(''),
    [verification, setVerification] = useState('hypothesis'),
    [publicSummary, setPublicSummary] = useState('');
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        save({
          status,
          reason,
          ...(status === 'resolved'
            ? { resolution: { summary, rootCause, verification, publicSummary } }
            : {}),
        });
      }}
    >
      <h4>状态变更</h4>
      <label>
        转入状态
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {detail.transitions.map((s) => (
            <option key={s} value={s}>
              {ticketStates[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        处理理由
        <textarea
          required
          minLength={2}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {status === 'resolved' && (
        <>
          <label>
            内部解决方案
            <textarea
              required
              minLength={10}
              maxLength={4000}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </label>
          <label>
            原因与验证依据
            <textarea maxLength={4000} value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
          </label>
          <label>
            原因验证状态
            <select value={verification} onChange={(e) => setVerification(e.target.value)}>
              <option value="hypothesis">待验证假设</option>
              <option value="supported">有证据支持</option>
              <option value="verified">人工核实</option>
            </select>
          </label>
          <label>
            客户公开解决说明
            <textarea
              required
              minLength={10}
              maxLength={4000}
              value={publicSummary}
              onChange={(e) => setPublicSummary(e.target.value)}
            />
          </label>
        </>
      )}
      <button disabled={busy}>确认状态变更</button>
    </form>
  );
}
export function ContextCapsule({ context }: { context: Record<string, unknown> }) {
  return (
    <div className="ws-evidence">
      <b>上报上下文</b>
      <p className="admin-muted">客户页面提供的排查线索，不作为身份、权限或根因证明。</p>
      <dl>
        {[
          'pagePath',
          'route',
          'entity',
          'requestId',
          'traceId',
          'environment',
          'appVersion',
          'frontendVersion',
        ].map((key) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              {context[key] === undefined
                ? '未提供'
                : typeof context[key] === 'object'
                  ? JSON.stringify(context[key])
                  : String(context[key])}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
function TicketInvestigation({ request, path }: { request: Request; path: string }) {
  const [data, setData] = useState<{
      runs: { id: string; state: string; outcome: string | null; tool_id: string }[];
      evidence: { id: string; payload: { summary: string; source: string; observedAt: string } }[];
      reports: { job_id: string; payload: unknown }[];
      capture: unknown;
    }>(),
    [error, setError] = useState('');
  return (
    <div>
      <button
        onClick={() => {
          setError('');
          void request<NonNullable<typeof data>>(path + '/investigation')
            .then(setData)
            .catch((e) => setError(e.message));
        }}
      >
        读取运行证据
      </button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p className="admin-muted">调查任务完成不代表问题已经解决；根因结论需要人工核实。</p>
          {data.runs.map((r) => (
            <div className="ws-reference" key={r.id}>
              <b>
                {r.tool_id} · {r.state}
              </b>
              <p>{r.outcome ?? '尚无结果'}</p>
            </div>
          ))}
          {data.evidence.map((e) => (
            <div className="ws-reference" key={e.id}>
              <p>{e.payload.summary}</p>
              <small>
                {e.payload.source} · {e.payload.observedAt}
              </small>
            </div>
          ))}
          {data.reports.map((r) => (
            <details key={r.job_id}>
              <summary>调查报告与假设依据</summary>
              <pre className="ws-source-text">{JSON.stringify(r.payload, null, 2)}</pre>
            </details>
          ))}
          {!data.runs.length && !data.reports.length && <p>暂无调查结果。</p>}
          {data.capture != null && (
            <details>
              <summary>客户授权提交的页面上下文</summary>
              <pre className="ws-source-text">{JSON.stringify(data.capture, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
function TicketKnowledge({ request, base, ticket }: { request: Request; base: string; ticket: Ticket }) {
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [result, setResult] = useState('');
  return (
    <details>
      <summary>沉淀为内部知识草稿</summary>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void request<{ id: string }>(base + '/tickets/' + ticket.id + '/knowledge', {
            version: ticket.ticket_version,
            title,
            body,
          })
            .then(() => setResult('内部草稿已创建，请到知识中心审核；客户版需独立编写。'))
            .catch((e) => setResult(e.message));
        }}
      >
        <p>请整理可复用的处理经验，移除客户身份、实例编号及私密业务数据。</p>
        <label>
          知识标题
          <input
            required
            minLength={2}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          可复用的解决步骤
          <textarea
            required
            minLength={10}
            maxLength={12000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <button>创建内部草稿</button>
        <p role="status">{result}</p>
      </form>
    </details>
  );
}
export function TenantAccess({
  request,
  base,
  changed,
}: {
  request: Request;
  base: string;
  changed: () => void;
}) {
  type Access = {
    tenants: { tenant_id: string; display_name: string }[];
    accounts: {
      id: string;
      display_name: string;
      username: string;
      all_tenants: boolean;
      tenant_ids: string[];
    }[];
  };
  const [data, setData] = useState<Access>(),
    [account, setAccount] = useState(''),
    [all, setAll] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [message, setMessage] = useState('');
  async function load() {
    setData(await request<Access>(base + '/support/access'));
  }
  return (
    <details className="admin-card ws-section">
      <summary
        onClick={() => {
          if (!data) void load().catch((e) => setMessage(e.message));
        }}
      >
        管理工单租户访问范围
      </summary>
      <p>
        角色与租户范围同时生效。空范围不允许读取工单；全项目范围需要显式勾选。修改人员角色后须重新授予租户范围。
      </p>
      {data && (
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void request(base + '/support/access/' + account, {
              allTenants: all,
              tenantIds: all ? [] : selected,
            })
              .then(async () => {
                await load();
                changed();
                setMessage('范围已保存，后续请求立即按新范围校验。');
              })
              .catch((e) => setMessage(e.message));
          }}
        >
          <label>
            工作人员
            <select
              required
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                const a = data.accounts.find((a) => a.id === e.target.value);
                setAll(a?.all_tenants ?? false);
                setSelected(a?.tenant_ids ?? []);
              }}
            >
              <option value="">选择工作人员</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name} · {a.username}
                </option>
              ))}
            </select>
          </label>
          <label className="ws-check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            允许访问本项目所有租户（含后续新租户）
          </label>
          {!all && (
            <fieldset>
              <legend>允许的租户</legend>
              {data.tenants.map((t) => (
                <label className="ws-check" key={t.tenant_id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(t.tenant_id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, t.tenant_id]
                          : selected.filter((id) => id !== t.tenant_id),
                      )
                    }
                  />
                  {t.display_name} · {t.tenant_id}
                </label>
              ))}
            </fieldset>
          )}
          <button disabled={!account}>保存访问范围</button>
        </form>
      )}
      <p role="status">{message}</p>
    </details>
  );
}
function TicketHistory({ request, path }: { request: Request; path: string }) {
  const [kind, setKind] = useState('messages'),
    [offset, setOffset] = useState(0),
    [data, setData] = useState<{
      records: {
        id: string;
        body?: string;
        actor: string | null;
        action?: string;
        detail?: unknown;
        created_at: string;
      }[];
      nextOffset: number | null;
    }>(),
    [error, setError] = useState('');
  async function load(nextKind = kind, next = offset) {
    try {
      setData(
        await request<NonNullable<typeof data>>(
          path + '/history?' + new URLSearchParams({ kind: nextKind, offset: String(next) }),
        ),
      );
      setOffset(next);
      setError('');
    } catch (e) {
      setData(undefined);
      setError((e as Error).message);
    }
  }
  return (
    <details className="ws-section">
      <summary>完整沟通与流转历史（分页）</summary>
      <label>
        记录类型
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            void load(e.target.value, 0);
          }}
        >
          <option value="messages">公开消息</option>
          <option value="notes">内部备注</option>
          <option value="events">流转记录</option>
        </select>
      </label>
      <button onClick={() => void load()}>加载记录</button>
      {data?.records.map((r) => (
        <article key={r.id} className="ws-reference">
          <b>
            {r.actor ?? '系统'} · {when(r.created_at)}
          </b>
          <p>{r.body ?? r.action}</p>
          {r.detail != null && <pre className="ws-source-text">{JSON.stringify(r.detail, null, 2)}</pre>}
        </article>
      ))}
      <div className="ws-actions">
        <button disabled={!offset} onClick={() => void load(kind, offset - 100)}>
          较新记录
        </button>
        <button disabled={data?.nextOffset == null} onClick={() => void load(kind, data!.nextOffset!)}>
          较早记录
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
