import { GitCredentials } from './git-credentials.js';
import { DeploymentFeedSettings } from './deployment-settings.js';
import { TicketSyncSettings } from './ticket-sync-settings.js';
import { AnalyticsSettings } from './analytics-settings.js';
import { useEffect, useRef, useState } from 'react';
import type { QueryConfig, BridgeConfig } from '@agent18/actions';
import type { Config } from '../../../scripts/config.js';
import type { DoctorReport } from '../../../scripts/lib/doctor.js';
import type { SupportCase, CaseMessage } from '@agent18/contracts';
import { ProductMark } from './setup.js';
import { ObservationCenter, CaptureView } from './observations.js';
import { QueryRegistration } from './query-registration.js';
import { OperatorBootstrap } from './operator-bootstrap.js';

type Project = Config['projects'][number];
type InboxCase = SupportCase & { tenantId: string; subject: string };
type OwnerRequest = <T>(path: string, body?: unknown, key?: string) => Promise<T>;
export function OperationsCenter({
  token,
  projects,
  coreUrl,
  onWizard,
}: {
  token: string;
  projects: { key: string; displayName?: string }[];
  coreUrl: string;
  onWizard: () => void;
}) {
  const [page, setPage] = useState<'overview' | 'connect' | 'inbox' | 'guide' | 'observe'>('overview'),
    [selected, setSelected] = useState(projects[0]?.key ?? ''),
    [report, setReport] = useState<DoctorReport>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const request: OwnerRequest = async (path, body, key) => {
    const response = await fetch('/owner/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(100000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.code ?? 'REQUEST_FAILED');
    return data;
  };
  const act = async (fn: () => Promise<void>) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => act(async () => setReport(await request<DoctorReport>('doctor')));
  useEffect(() => {
    void refresh();
  }, []);
  const failures = report?.checks.filter((c) => c.status === 'fail').length ?? 0;
  return (
    <div className="ops-shell">
      <aside className="ops-sidebar">
        <ProductMark href={coreUrl} />
        <span className="experience-kicker">WORKSPACE</span>
        <h2>接入工作台</h2>
        <nav>
          {(
            [
              ['overview', '◈', '运行总览'],
              ['connect', '↔', '系统与能力'],
              ['inbox', '◎', '客户问题'],
              ['observe', '◉', '巡检与排查'],
              ['guide', '▤', '接入与运维'],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              key={id}
              className={page === id ? 'active' : ''}
              onClick={() => {
                setPage(id);
                setError('');
                setNotice('');
              }}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="ops-sidebar-bottom">
          <span className="experience-badge">LOCAL OWNER</span>
          <p>
            管理配置、知识和客户支持。
            <br />
            当前页面仅限部署者访问。
          </p>
          <button onClick={onWizard}>打开初始化与知识向导 ↗</button>
        </div>
      </aside>
      <main className="ops-main">
        <header className="ops-top">
          <span>
            agent18 <span>/</span>{' '}
            {page === 'overview'
              ? '运行总览'
              : page === 'connect'
                ? '系统与能力'
                : page === 'inbox'
                  ? '客户问题'
                  : page === 'observe'
                    ? '巡检与排查'
                    : '接入与运维'}
          </span>
          <select aria-label="当前项目" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.displayName || p.key}
              </option>
            ))}
          </select>
        </header>
        {error && (
          <p className="experience-alert" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="experience-notice" role="status">
            {notice}
          </p>
        )}
        {page === 'overview' && (
          <>
            <OperatorBootstrap token={token} coreUrl={coreUrl} />
            <div className="ops-heading">
              <div>
                <span className="experience-kicker">OPERATE WITH CONFIDENCE</span>
                <h1>每一条连接，都有迹可循。</h1>
                <p>从系统接入到客户问题，在这里检查真实运行状态。</p>
              </div>
              <button className="experience-primary" disabled={busy} onClick={() => void refresh()}>
                {busy ? '正在检查…' : '重新诊断 ↻'}
              </button>
            </div>
            <div className="ops-metrics">
              <article>
                <span>运行检查</span>
                <strong>{report ? (failures === 0 ? '就绪' : failures + ' 项待处理') : '检查中'}</strong>
                <small>{report ? new Date(report.checkedAt).toLocaleString() : '连接本地部署服务'}</small>
              </article>
              <article>
                <span>已接入项目</span>
                <strong>{projects.length.toString().padStart(2, '0')}</strong>
                <small>项目之间独立配置身份与能力</small>
              </article>
              <article>
                <span>开放的业务能力</span>
                <strong>
                  {report
                    ? report.projects
                        .reduce((n, p) => n + p.queries + p.actions, 0)
                        .toString()
                        .padStart(2, '0')
                    : '—'}
                </strong>
                <small>已启用查询与办理的总数</small>
              </article>
            </div>
            <div className="ops-two">
              <section className="ops-card">
                <div className="ops-card-head">
                  <h2>部署健康检查</h2>
                  <span>实时读取</span>
                </div>
                {report?.checks.map((c) => (
                  <article key={c.id} className="ops-check">
                    <span className={'ops-status ' + c.status}>
                      {c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '×'}
                    </span>
                    <div>
                      <b>{c.title}</b>
                      <p>{c.detail}</p>
                      {c.status === 'fail' && c.fix && <small>{c.fix}</small>}
                    </div>
                  </article>
                ))}
              </section>
              <div>
                <section className="ops-card ops-next">
                  <span className="experience-kicker">YOUR NEXT STEP</span>
                  <h2>让助手真正懂你的业务。</h2>
                  <p>导入接口定义，选择可查询字段和用户角色。知识、查询和办理沿用同一套身份边界。</p>
                  <button className="experience-primary" onClick={() => setPage('connect')}>
                    管理系统与能力 →
                  </button>
                </section>
                <section className="ops-card">
                  <h3>从哪里开始？</h3>
                  <button className="ops-link" onClick={onWizard}>
                    连接文档与代码，生成知识 ↗
                  </button>
                  <button className="ops-link" onClick={() => setPage('inbox')}>
                    跟进客户提交的问题 ↗
                  </button>
                  <a className="ops-link" href={coreUrl + '/docs'} target="_blank" rel="noreferrer">
                    阅读完整接入手册 ↗
                  </a>
                </section>
              </div>
            </div>
          </>
        )}
        {page === 'connect' && (
          <>
            <ConnectionEditor
              key={selected}
              projectKey={selected}
              request={request}
              onSaved={() => setNotice('配置已保存。点击“应用到运行服务”后生效。')}
            />
            <AnalyticsSettings key={'analytics-' + selected} projectKey={selected} request={request} />
            <TicketSyncSettings key={'sync-' + selected} projectKey={selected} request={request} />
            <DeploymentFeedSettings key={'deployment-' + selected} projectKey={selected} request={request} />
            <GitCredentials request={request} />
          </>
        )}
        {page === 'inbox' && <OwnerInbox key={selected} projectKey={selected} request={request} />}
        {page === 'observe' && <ObservationCenter key={selected} projectKey={selected} request={request} />}
        {page === 'guide' && (
          <>
            <div className="ops-heading">
              <div>
                <span className="experience-kicker">FROM CLONE TO SERVICE</span>
                <h1>接得进去，也能长期运行。</h1>
                <p>把部署、业务接入和故障处理变成一套可执行的流程。</p>
              </div>
            </div>
            <div className="ops-guide-grid">
              {[
                [
                  '01',
                  '准备你的系统',
                  '后端按已登录会话签发短期 Support Token；登记项目、租户、公钥和网站 Origin。',
                  'guides/integration',
                ],
                [
                  '02',
                  '构建专属知识',
                  '导入文档和代码。检查构建草稿、引用与受众后发布；使用 watch 持续发现版本变化。',
                  'guides/knowledge',
                ],
                [
                  '03',
                  '开放业务能力',
                  '导入 OpenAPI 查询，配置字段与角色；写操作实现预览、执行和回执协议。',
                  'guides/business-queries',
                ],
                [
                  '04',
                  '部署与维护',
                  '进行运行诊断、备份与恢复演练；按公开部署指南配置 HTTPS 和真实身份。',
                  'guides/operations',
                ],
              ].map(([number, title, description, path]) => (
                <a
                  className="ops-card"
                  href={coreUrl + '/docs/' + path}
                  target="_blank"
                  rel="noreferrer"
                  key={number}
                >
                  <span className="experience-kicker">{number}</span>
                  <h2>{title}</h2>
                  <p>{description}</p>
                  <span>打开指南 ↗</span>
                </a>
              ))}
            </div>
            <section className="ops-card">
              <h2>常用运维命令</h2>
              <pre>
                pnpm doctor{`\n`}pnpm knowledge watch 300{`\n`}pnpm backup{`\n`}pnpm release:check
              </pre>
              <p>诊断不调用模型；自动知识更新只生成草稿；备份保存到本地受限目录。</p>
            </section>
          </>
        )}
        <footer className="ops-footer">
          agent18 · 开源、可审查、由你掌控{' '}
          <a href={coreUrl + '/docs'} target="_blank" rel="noreferrer">
            开发者文档 ↗
          </a>
        </footer>
      </main>
    </div>
  );
}
function ConnectionEditor({
  projectKey,
  request,
  onSaved,
}: {
  projectKey: string;
  request: OwnerRequest;
  onSaved: () => void;
}) {
  const [project, setProject] = useState<Project>(),
    [tenants, setTenants] = useState(''),
    [origins, setOrigins] = useState(''),
    [keys, setKeys] = useState(''),
    [issuer, setIssuer] = useState(''),
    [audience, setAudience] = useState(''),
    [baseUrl, setBaseUrl] = useState(''),
    [dockerUrl, setDockerUrl] = useState(''),
    [operations, setOperations] = useState<QueryConfig['operations']>([]),
    [bridge, setBridge] = useState(''),
    [document, setDocument] = useState(''),
    [skipped, setSkipped] = useState<{ path: string; reason: string }[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const perform = async (fn: () => Promise<void>) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void perform(async () => {
      const r = await request<{ project: Project; tenants: { id: string; name: string }[] }>(
        'projects/' + projectKey,
      );
      setProject(r.project);
      setTenants(r.tenants.map((t) => t.id).join('\n'));
      setOrigins(r.project.allowedOrigins.join('\n'));
      setKeys(JSON.stringify(r.project.jwks, null, 2));
      setIssuer(r.project.issuer);
      setAudience(r.project.audience);
      setBaseUrl(r.project.businessQueries?.baseUrl ?? '');
      setOperations(r.project.businessQueries?.operations ?? []);
      setBridge(r.project.businessBridge ? JSON.stringify(r.project.businessBridge, null, 2) : '');
    });
  }, []);
  const importDocument = async (raw: string) => {
    const result = await request<{
      operations: QueryConfig['operations'];
      skipped: { path: string; reason: string }[];
    }>('openapi/import', { document: JSON.parse(raw) });
    setOperations((current) => [
      ...current.filter((q) => !result.operations.some((n) => n.id === q.id)),
      ...result.operations,
    ]);
    setSkipped(result.skipped);
    setNotice(`已导入 ${result.operations.length} 个查询候选。勾选启用并审核角色、字段后保存。`);
  };
  const update = (id: string, patch: Partial<QueryConfig['operations'][number]>) =>
    setOperations((v) => v.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const save = () =>
    perform(async () => {
      await request('projects/' + projectKey + '/business', {
        ...(baseUrl ? { businessQueries: { baseUrl, operations } } : {}),
        ...(dockerUrl ? { dockerQueriesBaseUrl: dockerUrl } : {}),
        ...(bridge.trim() ? { businessBridge: JSON.parse(bridge) as BridgeConfig } : {}),
      });
      onSaved();
      setNotice('业务能力已保存。应用到运行服务后生效。');
    });
  return (
    <>
      <div className="ops-heading">
        <div>
          <span className="experience-kicker">CONNECT YOUR SAAS</span>
          <h1>系统与能力</h1>
          <p>用现有身份连接真实业务，把可以做的事明确交给助手。</p>
        </div>
        <button
          className="experience-primary"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await request('apply', {
                displayName: (await request<{ displayName: string }>('state')).displayName,
              });
              setNotice('运行服务已应用最新设置。');
            })
          }
        >
          应用到运行服务 ↗
        </button>
      </div>
      {error && (
        <p className="experience-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="experience-notice" role="status">
          {notice}
        </p>
      )}
      <details className="ops-card">
        <summary>
          <b>登录身份与允许的网站</b>
          <span>{projectKey} · 编辑连接</span>
        </summary>
        <div className="setup-form-grid">
          <label>
            Issuer
            <input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          </label>
          <label>
            Audience
            <input value={audience} onChange={(e) => setAudience(e.target.value)} />
          </label>
          <label>
            网站 Origin（每行一个）
            <textarea value={origins} onChange={(e) => setOrigins(e.target.value)} rows={3} />
          </label>
          <label>
            租户标识（每行一个，新增或更新）
            <textarea value={tenants} onChange={(e) => setTenants(e.target.value)} rows={3} />
          </label>
        </div>
        <label>
          公开 JWKS
          <textarea className="ops-code" rows={7} value={keys} onChange={(e) => setKeys(e.target.value)} />
        </label>
        <p className="muted-text">
          租户列表用于注册，不会删除已有业务数据。身份和业务权限仍由 SaaS 后端决定。
        </p>
        <button
          className="experience-primary"
          disabled={busy || !project}
          onClick={() =>
            void perform(async () => {
              await request('projects/' + projectKey + '/identity', {
                project: {
                  ...project!,
                  issuer,
                  audience,
                  jwks: JSON.parse(keys),
                  allowedOrigins: origins
                    .split('\n')
                    .map((v) => v.trim())
                    .filter(Boolean),
                },
                organizationName: project!.displayName ?? projectKey,
                projectName: project!.displayName ?? projectKey,
                tenants: tenants
                  .split('\n')
                  .map((v) => v.trim())
                  .filter(Boolean)
                  .map((id) => ({ id, name: id })),
              });
              onSaved();
              setNotice('身份配置已保存。请应用到运行服务。');
            })
          }
        >
          保存身份配置
        </button>
      </details>
      <section className="ops-card">
        <div className="ops-card-head">
          <div>
            <span className="experience-kicker">READ · OPENAPI</span>
            <h2>以用户身份查询业务</h2>
          </div>
          <span className="experience-badge">GET / 审核 POST</span>
        </div>
        <p>导入 OpenAPI 3.0 / 3.1 JSON，选择可以开放的接口。导入不访问服务器，也不会自动启用。</p>
        <div className="setup-form-grid">
          <label>
            SaaS API 基础地址
            <input
              type="url"
              placeholder="https://api.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label>
            容器内访问地址（可选）
            <input
              type="url"
              placeholder="与外部地址相同可留空"
              value={dockerUrl}
              onChange={(e) => setDockerUrl(e.target.value)}
            />
          </label>
        </div>
        <details className="ops-import">
          <summary>
            导入接口定义 <span>文件或 JSON</span>
          </summary>
          <label>
            选择 OpenAPI JSON 文件
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void perform(async () => {
                    if (f.size > 500000) throw new Error('文件不能超过 500 KB');
                    const text = await f.text();
                    setDocument(text);
                    await importDocument(text);
                  });
              }}
            />
          </label>
          <textarea
            className="ops-code"
            aria-label="OpenAPI JSON"
            rows={7}
            value={document}
            onChange={(e) => setDocument(e.target.value)}
            placeholder='{"openapi":"3.1.0","info":{...},"paths":{...}}'
          />
          <div className="ops-buttons">
            <button
              className="experience-primary"
              disabled={busy || !document.trim()}
              onClick={() => void perform(() => importDocument(document))}
            >
              分析接口定义
            </button>
            {projectKey === 'invoice-demo' && (
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const doc = JSON.stringify(await request('examples/openapi'), null, 2);
                    setDocument(doc);
                    await importDocument(doc);
                    if (!baseUrl) {
                      setBaseUrl('http://127.0.0.1:4319');
                      setDockerUrl('http://identity-demo:4319');
                    }
                  })
                }
              >
                载入演示 SaaS 定义
              </button>
            )}
          </div>
          {skipped.length > 0 && (
            <div className="ops-skipped">
              {skipped.map((s) => (
                <p key={s.path}>
                  <code>{s.path}</code> · {s.reason}
                </p>
              ))}
            </div>
          )}
        </details>
        <QueryRegistration
          request={request}
          onAdd={(query) => {
            setOperations((items) => [...items.filter((item) => item.id !== query.id), query]);
          }}
        />
        {!operations.length ? (
          <div className="build-empty">导入业务接口后，查询能力会列在这里。</div>
        ) : (
          <div className="ops-query-list">
            {operations.map((q) => (
              <article key={q.id} className="ops-query">
                <header>
                  <label>
                    <input
                      type="checkbox"
                      checked={q.enabled}
                      onChange={(e) => update(q.id, { enabled: e.target.checked })}
                    />
                    <b>{q.title}</b>
                  </label>
                  <code>
                    {q.method ?? 'GET'} {q.path}
                  </code>
                </header>
                <p>{q.description}</p>
                <div className="setup-form-grid">
                  <label>
                    允许角色（逗号分隔）
                    <input
                      value={q.roles.join(',')}
                      onChange={(e) =>
                        update(q.id, { roles: e.target.value.split(',').map((v) => v.trim()) })
                      }
                    />
                  </label>
                  <label>
                    返回的字段（逗号分隔）
                    <input
                      value={q.columns.map((c) => c.path).join(',')}
                      onChange={(e) =>
                        update(q.id, {
                          columns: e.target.value
                            .split(',')
                            .map((v) => v.trim())
                            .map((path) => ({
                              path,
                              label: q.columns.find((c) => c.path === path)?.label ?? path,
                            })),
                        })
                      }
                    />
                  </label>
                </div>
                <small>
                  参数：
                  {q.fields.map((f) => `${f.name} (${f.in})${f.required ? '（必填）' : ''}`).join('、') ||
                    '无'}{' '}
                  · 返回上限 50 条 · 未选字段不会返回给客户
                </small>
                <button
                  className="ops-remove"
                  onClick={() => setOperations((v) => v.filter((item) => item.id !== q.id))}
                >
                  移除此查询
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      <details className="ops-card">
        <summary>
          <b>经确认办理业务</b>
          <span>WRITE · 三阶段业务桥接</span>
        </summary>
        <p>由你的后端实现 prepare、execute、status。注册允许的操作、角色和参数，保存后即可在助手中办理。</p>
        <textarea
          className="ops-code"
          rows={12}
          aria-label="业务桥接配置"
          value={bridge}
          onChange={(e) => setBridge(e.target.value)}
          placeholder='{"url":"https://api.example.com/agent18/bridge","actions":[]}'
        />
        <p>停用某项操作请设 enabled: false；停用全部操作请保存 actions: []。空白表示保留原设置。</p>
      </details>
      <div className="ops-save">
        <span>保存配置 → 应用到运行服务 → 从你的 SaaS 验证身份与业务</span>
        <button className="experience-primary" disabled={busy} onClick={() => void save()}>
          {busy ? '正在处理…' : '保存业务能力 →'}
        </button>
      </div>
    </>
  );
}
function OwnerInbox({ projectKey, request }: { projectKey: string; request: OwnerRequest }) {
  const [cases, setCases] = useState<InboxCase[]>([]),
    [selected, setSelected] = useState<InboxCase>(),
    [messages, setMessages] = useState<CaseMessage[]>([]),
    [body, setBody] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const refresh = async () => {
    try {
      setCases((await request<{ cases: InboxCase[] }>('projects/' + projectKey + '/cases')).cases);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    let active = true;
    setMessages([]);
    setBody('');
    key.current = crypto.randomUUID();
    if (selected)
      void request<{ messages: CaseMessage[] }>(`projects/${projectKey}/cases/${selected.id}/messages`)
        .then((r) => {
          if (active) setMessages(r.messages);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [selected?.id]);
  return (
    <>
      <div className="ops-heading">
        <div>
          <span className="experience-kicker">CUSTOMER CONVERSATIONS</span>
          <h1>让每一个问题有后续。</h1>
          <p>查看当前项目最近 100 个问题。回复会出现在客户的“我的问题”中。</p>
        </div>
        <button disabled={busy} onClick={() => void refresh()}>
          刷新列表 ↻
        </button>
      </div>
      {error && (
        <p className="experience-alert" role="alert">
          {error}
        </p>
      )}
      <div className="ops-inbox">
        <section className="ops-card ops-case-list">
          {cases.length ? (
            cases.map((c) => (
              <button
                key={c.id}
                className={selected?.id === c.id ? 'selected' : ''}
                disabled={busy}
                onClick={() => setSelected(c)}
              >
                <span>
                  {c.status === 'resolved' ? '已解决' : c.status === 'needs_human' ? '待跟进' : '处理中'}
                </span>
                <b>{c.title}</b>
                <small>
                  {c.tenantId} · {c.subject}
                </small>
              </button>
            ))
          ) : (
            <div className="build-empty">当前项目还没有客户问题。</div>
          )}
        </section>
        <section className="ops-card">
          {!selected ? (
            <div className="build-empty">从左侧选择问题，查看说明并回复。</div>
          ) : (
            <>
              <span className="experience-kicker">
                {selected.tenantId} / {selected.subject}
              </span>
              <h2>{selected.title}</h2>
              <p className="ops-description">{selected.description}</p>
              <CaptureView key={selected.id} projectKey={projectKey} caseId={selected.id} request={request} />
              <div className="case-thread">
                {messages.map((m) => (
                  <article key={m.id} className={'case-message ' + m.author}>
                    <b>{m.author === 'support' ? '支持团队' : '客户'}</b>
                    <p>{m.body}</p>
                    <small>{new Date(m.createdAt).toLocaleString()}</small>
                  </article>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError('');
                  void (async () => {
                    try {
                      await request(
                        `projects/${projectKey}/cases/${selected.id}/messages`,
                        { body },
                        key.current,
                      );
                      setBody('');
                      key.current = crypto.randomUUID();
                      setMessages(
                        (
                          await request<{ messages: CaseMessage[] }>(
                            `projects/${projectKey}/cases/${selected.id}/messages`,
                          )
                        ).messages,
                      );
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                <label>
                  回复客户
                  <textarea
                    rows={4}
                    required
                    maxLength={4000}
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      key.current = crypto.randomUUID();
                    }}
                    placeholder="说明处理结论、操作方法或需要补充的信息"
                  />
                </label>
                <button className="experience-primary" disabled={busy}>
                  发送回复
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </>
  );
}
