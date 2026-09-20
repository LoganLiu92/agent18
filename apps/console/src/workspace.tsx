import { IntegrationReadiness } from './integration-readiness.js';
import { PublicationSets } from './knowledge-curation.js';
import { KnowledgePlayground } from './knowledge-playground.js';
import { KnowledgeMaintenance } from './knowledge-maintenance.js';
import { RetentionSettings } from './retention-settings.js';
import { InsightsWorkspace } from './insights-workspace.js';
import { OperationsWorkspace } from './operations-workspace.js';
import { SupportWorkspace } from './support-workspace.js';
import { EvidenceContent } from './knowledge-generation.js';
import { KnowledgeFreshness } from './knowledge-freshness.js';
import { useEffect, useState } from 'react';
import { SourceCenter } from './source-center.js';
import { KnowledgeMap } from './knowledge-map.js';
import type { OperatorRole } from '../../server/src/operators/service.js';
export type WorkspacePage = 'projects' | 'knowledge' | 'integrations' | 'support' | 'operations' | 'insights';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Project = { key: string; name: string; roles: OperatorRole[] };
const categories: Record<string, string> = {
  overview: '产品与领域',
  workflows: '业务流程',
  api: 'API 与数据',
  architecture: '工程架构',
  configuration: '配置与部署',
  troubleshooting: '运维与排障',
};
const states: Record<string, string> = {
  draft: '草稿',
  in_review: '待审核',
  approved: '审核通过',
  published: '已发布',
};
const actionNames: Record<string, string> = {
  created: '创建文档',
  save: '保存修订',
  submit: '提交审核',
  return: '退回修改',
  approve: '审核通过',
  publish: '发布版本',
  revoke: '撤回发布',
  restore: '从历史修订恢复草稿',
  generated: '分层生成导入',
  'customer-derived': '创建独立客户版本',
  import: '从来源证据创建草稿',
};
type Source = {
  id: string;
  name: string;
  key: string;
  audience: string;
  enabled: boolean;
  active_build_id: string | null;
  revision: string | null;
  observed_at: string | null;
  mode: string | null;
  articles: number;
  latest_state: string | null;
};
type Article = {
  id: string;
  title: string;
  category: string;
  revision: string;
  created_at: string;
  source_name: string;
  audience: string;
  body?: string;
  refs?: { path: string; startLine: number; endLine: number; revision: string }[];
  provenance?: {
    source?: { kind?: string };
    snapshot?: { observedAt?: string };
    deployment?: { status?: string };
  };
};
type Document = {
  id: string;
  title: string;
  category: string;
  audience: 'internal' | 'customer';
  state: string;
  version: number;
  published_build_id: string | null;
  updated_at: string;
  body?: string;
  evidence?: { id?: string; path: string; startLine: number; endLine: number; revision: string }[];
  derived_from_version?: number;
  derivation?: { id: string; title: string; version: number; state: string } | null;
  derivationChanged?: boolean;
  history?: {
    version: number;
    action: string;
    reason?: string;
    restored_from?: number;
    created_at: string;
    actor: string;
  }[];
};
type Knowledge = {
  sources: Source[];
  articles: Article[];
  documents: Document[];
  counts: { sources: number; articles: number; reviews: number; drafts: number };
  truncated: boolean;
};
type Overview = {
  name: string;
  knowledge: string;
  integrations: { key: string; name: string; configured: boolean; detail: string }[];
};
const when = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '尚无记录';
export function Workspace({
  page,
  project,
  administrator,
  request,
  navigate,
}: {
  page: WorkspacePage;
  project: Project;
  administrator: boolean;
  request: Request;
  navigate: (p: WorkspacePage) => void;
}) {
  const [overview, setOverview] = useState<Overview>(),
    [data, setData] = useState<Knowledge>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [tab, setTab] = useState('topics'),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState('all'),
    [article, setArticle] = useState<Article>(),
    [doc, setDoc] = useState<Document>(),
    [creating, setCreating] = useState(false),
    [guide, setGuide] = useState(false);
  const canRead =
    administrator ||
    project.roles.some((r) => ['engineer', 'knowledge_editor', 'knowledge_publisher'].includes(r));
  const canEdit = administrator || project.roles.includes('knowledge_editor'),
    canPublish = administrator || project.roles.includes('knowledge_publisher');
  const base = 'projects/' + encodeURIComponent(project.key),
    knowledge = base + '/knowledge';
  async function refresh() {
    setData(await request<Knowledge>(knowledge));
  }
  useEffect(() => {
    let active = true;
    setError('');
    setData(undefined);
    setOverview(undefined);
    setDoc(undefined);
    setArticle(undefined);
    void Promise.all([
      request<Overview>(base + '/workspace'),
      canRead ? request<Knowledge>(knowledge) : Promise.resolve(undefined),
    ])
      .then(([o, k]) => {
        if (active) {
          setOverview(o);
          setData(k);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
    // The workspace is keyed by project; request captures the current operator session.
  }, [project.key]);
  async function act(fn: () => Promise<void>) {
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
  }
  async function openArticle(id: string) {
    await act(async () => {
      setDoc(undefined);
      setCreating(false);
      setArticle(await request<Article>(knowledge + '/articles/' + id));
    });
  }
  async function openDoc(id: string) {
    await act(async () => {
      setArticle(undefined);
      setCreating(false);
      setDoc(await request<Document>(knowledge + '/documents/' + id));
      await refresh();
    });
  }
  async function transition(action: string, extra: { reason?: string; fromVersion?: number } = {}) {
    if (!doc) return;
    await act(async () => {
      await request(knowledge + '/documents/' + doc.id, { version: doc.version, action, ...extra });
      setDoc(await request<Document>(knowledge + '/documents/' + doc.id));
      await refresh();
      setNotice(actionNames[action] + '，记录已保存。');
    });
  }
  const heading =
    page === 'projects'
      ? ['WORKSPACE OVERVIEW', '工作空间', '把产品知识、客户支持与运行证据连接起来。']
      : page === 'knowledge'
        ? ['KNOWLEDGE CENTER', '知识中心', '整理产品知识，保留来源依据，让每一次发布都有记录。']
        : page === 'integrations'
          ? ['INTEGRATIONS', '集成与接入', '查看本项目已加载的能力配置，按需扩展连接。']
          : page === 'support'
            ? ['SUPPORT', '客户支持', '持续对话、问题工单与处理结果，围绕同一问题组织。']
            : page === 'operations'
              ? ['OPERATIONS', '运行与排查', '从客户问题连接日志、指标与调查证据。']
              : ['INSIGHTS', '业务洞察', '查看支持指标与趋势，保存可追溯报告；业务指标通过获准接口接入。'];
  return (
    <>
      <div className="ws-heading">
        <div>
          <p className="admin-kicker">{heading[0]}</p>
          <h1>{heading[1]}</h1>
          <p className="admin-muted">{heading[2]}</p>
        </div>
        <div className="ws-actions">
          {page === 'knowledge' && canEdit && (
            <button
              disabled={busy}
              onClick={() => {
                setCreating(true);
                setDoc(undefined);
                setArticle(undefined);
                setTab('documents');
              }}
            >
              ＋ 新建文档
            </button>
          )}
          <button className="ws-secondary" onClick={() => setGuide(!guide)}>
            {guide ? '收起引导' : '接入指南 ↗'}
          </button>
        </div>
      </div>
      {error && (
        <div className="admin-error" role="alert">
          {error}
          <button
            className="ws-secondary"
            onClick={() =>
              void act(async () => {
                setOverview(await request<Overview>(base + '/workspace'));
                if (canRead) await refresh();
              })
            }
          >
            重试加载
          </button>
        </div>
      )}
      {page === 'knowledge' && overview?.knowledge === 'fixture' && (
        <div className="admin-notice">
          当前客户入口使用演示资料。文档可以在此管理和发布；部署者需将本项目知识模式切换为 indexed
          后，客户检索才会使用这些发布内容。
        </div>
      )}
      {notice && (
        <div className="admin-notice" role="status">
          {notice}
        </div>
      )}
      {guide && (
        <section className="admin-card ws-guide">
          <div>
            <span className="ws-pill">接入路径</span>
            <h2>从部署到持续积累</h2>
            <p className="admin-muted">
              在来源页连接仓库或目录，跟踪扫描任务；部署者需先启动限定读取范围的独立知识索引进程。
            </p>
          </div>
          <ol>
            <li>
              <b>连接代码与资料</b>
              <p>准备 Git 仓库或文档目录，指定分支、扫描范围与可见受众。源码资料默认用于内部知识。</p>
            </li>
            <li>
              <b>构建并检查证据</b>
              <p>
                运行知识构建，在来源和文档页核对生成版本、文件路径与行号。源码版本与线上部署版本分别核验。
              </p>
            </li>
            <li>
              <b>补充、审核、发布</b>
              <p>
                在此新建补充文档。提交审核后，由知识发布人员审核并发布；客户版面向本项目所有租户，请移除内部信息。
              </p>
            </li>
            <li>
              <b>接入网站与运行数据</b>
              <p>配置客户身份桥接和 SDK，再配置业务接口、Loki 与 Prometheus。用真实客户权限验收后上线。</p>
            </li>
          </ol>
          <a href="/docs" target="_blank" rel="noreferrer">
            打开产品文档 →
          </a>
        </section>
      )}
      {page === 'projects' && (
        <>
          <section className="ws-welcome">
            <div>
              <span className="ws-pill">{project.name}</span>
              <h2>让知识成为支持的起点。</h2>
              <p>从现有代码、业务资料和处理经验开始，建立可持续维护的产品知识。</p>
              <button onClick={() => navigate('knowledge')}>进入知识中心 →</button>
            </div>
            <div className="ws-orbit" aria-hidden="true">
              <span>KNOWLEDGE</span>
              <b>18</b>
              <span>SUPPORT · OPERATIONS</span>
            </div>
          </section>
          <div className="ws-metrics">
            {[
              ['知识来源', data?.counts.sources],
              ['当前可用文档', data?.counts.articles],
              ['待审核', data?.counts.reviews],
              ['补充草稿', data?.counts.drafts],
            ].map(([label, value]) => (
              <button
                className="admin-card"
                key={label}
                onClick={() => {
                  navigate('knowledge');
                  setTab(
                    label === '待审核'
                      ? 'reviews'
                      : label === '补充草稿'
                        ? 'documents'
                        : label === '知识来源'
                          ? 'sources'
                          : 'map',
                  );
                }}
              >
                <span>{label}</span>
                <strong>{value ?? '—'}</strong>
                <small>{canRead ? '项目实时记录' : '需要知识访问权限'}</small>
              </button>
            ))}
          </div>
          <div className="admin-grid">
            <section className="admin-card">
              <span className="ws-label">GET STARTED</span>
              <h2>逐步建立产品工作空间</h2>
              {[
                ['01', '连接与索引', '连接已有代码、文档和业务接口。', 'integrations'],
                ['02', '补充与发布', '整理草稿、审核客户知识、管理发布版本。', 'knowledge'],
                ['03', '问题与证据', '接通客户支持和运行证据的管理流程。', 'support'],
              ].map(([n, title, desc, target]) => (
                <button className="ws-step" key={n} onClick={() => navigate(target as WorkspacePage)}>
                  <span>{n}</span>
                  <div>
                    <b>{title}</b>
                    <small>{desc}</small>
                  </div>
                  <span>→</span>
                </button>
              ))}
            </section>
            <section className="admin-card">
              <span className="ws-label">CONNECTIONS</span>
              <h2>当前接入状态</h2>
              {!overview ? (
                <p>正在读取配置…</p>
              ) : (
                overview.integrations.map((i) => (
                  <div className="ws-status-row" key={i.key}>
                    <span>{i.name}</span>
                    <span className={'ws-pill ' + (i.configured ? 'good' : '')}>
                      {i.configured ? '已配置' : '未配置'}
                    </span>
                  </div>
                ))
              )}
              <p className="admin-muted">配置状态来自服务当前加载配置，不代表外部服务健康。</p>
            </section>
          </div>
        </>
      )}
      {page === 'knowledge' &&
        (!canRead ? (
          <section className="admin-card">
            <h2>需要知识访问权限</h2>
            <p>请管理员分配工程排查、知识编辑或知识发布角色。客户仍通过网站入口查看其可见知识。</p>
          </section>
        ) : (
          <>
            <div className="ws-tabs" role="tablist" aria-label="知识中心视图">
              {[
                ['topics', '知识地图'],
                ['map', '知识目录'],
                ['sources', '来源与版本'],
                ['documents', '文档草稿'],
                ['reviews', '审核队列'],
                ['impact', '变更影响'],
                ['conflicts', '知识冲突'],
                ['playground', '检索验证'],
              ].map(([key, label]) => (
                <button
                  role="tab"
                  aria-selected={tab === key}
                  key={key}
                  className={tab === key ? 'active' : ''}
                  onClick={() => {
                    setTab(key!);
                    setDoc(undefined);
                    setArticle(undefined);
                    setCreating(false);
                    setQuery('');
                  }}
                >
                  {label}
                  {key === 'reviews' && !!data?.counts.reviews && <span>{data.counts.reviews}</span>}
                </button>
              ))}
            </div>
            {!data ? (
              <section className="admin-card">正在读取知识中心…</section>
            ) : (
              <>
                {data.truncated && (
                  <p className="admin-notice">
                    当前列表最多展示 200 个来源、200 份草稿和 500 篇索引文档；顶部统计为完整项目数量。
                  </p>
                )}
                {tab === 'reviews' && (
                  <PublicationSets
                    request={request}
                    base={knowledge}
                    canPublish={administrator || project.roles.includes('knowledge_publisher')}
                  />
                )}
                {tab === 'playground' && (
                  <KnowledgePlayground
                    request={request}
                    base={knowledge}
                    canEdit={canEdit}
                    canReview={canPublish}
                  />
                )}
                {(tab === 'conflicts' || tab === 'impact') && (
                  <KnowledgeMaintenance
                    key={tab}
                    request={request}
                    base={knowledge}
                    mode={tab}
                    canEdit={canEdit}
                    canReview={administrator || project.roles.includes('knowledge_publisher')}
                    onDocument={(id) => {
                      setTab('documents');
                      void openDoc(id);
                    }}
                  />
                )}
                {tab === 'topics' && (
                  <KnowledgeMap
                    key={knowledge}
                    request={request}
                    base={knowledge}
                    canEdit={canEdit}
                    documents={data.documents}
                    onDocument={(id) => {
                      setTab('documents');
                      void openDoc(id);
                    }}
                  />
                )}
                {tab === 'sources' && (
                  <SourceCenter
                    request={request}
                    base={knowledge}
                    canConfigure={administrator}
                    onScanChange={refresh}
                    canEdit={canEdit}
                    onDraft={async (id) => {
                      await refresh();
                      setDoc(await request<Document>(knowledge + '/documents/' + id));
                      await refresh();
                      setArticle(undefined);
                      setTab('documents');
                    }}
                  />
                )}
                {tab === 'sources' && (
                  <div className="admin-grid">
                    {data.sources.map((s) => (
                      <section className="admin-card ws-source" key={s.id}>
                        <div className="ws-status-row">
                          <span className="ws-source-icon">{s.key.startsWith('staff-') ? '文' : '⌘'}</span>
                          <span className={'ws-pill ' + (s.enabled && s.active_build_id ? 'good' : '')}>
                            {s.enabled && s.active_build_id ? '已启用版本' : '未启用'}
                          </span>
                        </div>
                        <h2>{s.name}</h2>
                        <p className="admin-muted">
                          {s.audience === 'internal' ? '内部知识' : '客户知识'} · {s.articles} 篇文档
                        </p>
                        <dl>
                          <dt>版本</dt>
                          <dd>{s.revision ?? '尚未发布'}</dd>
                          <dt>构建时间</dt>
                          <dd>{when(s.observed_at)}</dd>
                          <dt>最新构建</dt>
                          <dd>
                            {{ ready: '完成', building: '构建中', failed: '失败' }[s.latest_state ?? ''] ??
                              '无记录'}
                          </dd>
                          <dt>线上部署</dt>
                          <dd>未关联</dd>
                        </dl>
                      </section>
                    ))}
                    {!data.sources.length && (
                      <Empty
                        title="还没有知识来源"
                        text="连接仓库或文档目录并完成索引后，来源版本与文档会出现在这里。也可以先新建补充文档，审核发布后自动进入知识目录。"
                      />
                    )}
                  </div>
                )}
                {(tab === 'map' || tab === 'documents' || tab === 'reviews') && (
                  <div className="ws-knowledge-layout">
                    <section className="admin-card ws-library">
                      <label className="ws-search">
                        <span>搜索当前列表</span>
                        <input
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="按标题查找知识…"
                        />
                      </label>
                      {tab === 'map' && (
                        <div className="ws-categories">
                          {[['all', '全部知识'], ...Object.entries(categories)].map(([key, label]) => (
                            <button
                              className={category === key ? 'active' : ''}
                              key={key}
                              onClick={() => setCategory(key!)}
                            >
                              {label}
                              <span>
                                {data.articles.filter((a) => key === 'all' || a.category === key).length}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="ws-document-list">
                        {(tab === 'map'
                          ? data.articles.filter((a) => category === 'all' || a.category === category)
                          : data.documents.filter(
                              (d) => tab !== 'reviews' || d.state === 'in_review' || d.state === 'approved',
                            )
                        )
                          .filter((a) => a.title.toLowerCase().includes(query.toLowerCase()))
                          .map((a) => (
                            <button
                              disabled={busy}
                              key={a.id}
                              className={article?.id === a.id || doc?.id === a.id ? 'active' : ''}
                              onClick={() => void (tab === 'map' ? openArticle(a.id) : openDoc(a.id))}
                            >
                              <small>
                                {categories[a.category]} ·{' '}
                                {'state' in a ? states[a.state] : a.audience === 'internal' ? '内部' : '客户'}
                              </small>
                              <b>{a.title}</b>
                              <span>{'state' in a ? '修订 ' + a.version : a.source_name}</span>
                            </button>
                          ))}
                      </div>
                      {!(
                        tab === 'map'
                          ? data.articles
                          : data.documents.filter(
                              (d) => tab !== 'reviews' || ['in_review', 'approved'].includes(d.state),
                            )
                      ).length && (
                        <p className="admin-muted">
                          {tab === 'reviews'
                            ? '没有待处理的审核。'
                            : '暂无文档。连接资料或新建补充文档开始。'}
                        </p>
                      )}
                    </section>
                    <section className="admin-card ws-reader">
                      {creating ? (
                        <DocumentForm
                          busy={busy}
                          onCancel={() => setCreating(false)}
                          onSave={(value) =>
                            void act(async () => {
                              const created = await request<{ id: string }>(knowledge + '/documents', value);
                              setDoc(await request<Document>(knowledge + '/documents/' + created.id));
                              setCreating(false);
                              await refresh();
                              setNotice('草稿已保存，尚未发布。');
                            })
                          }
                        />
                      ) : doc ? (
                        <>
                          <div className="ws-status-row">
                            <span className="ws-pill">{states[doc.state]}</span>
                            <small>
                              修订 {doc.version} · {when(doc.updated_at)}
                            </small>
                          </div>
                          <h2>{doc.title}</h2>
                          {doc.published_build_id && doc.state !== 'published' && (
                            <p className="admin-notice">
                              已有线上版本。当前草稿的修改需重新审核发布后才生效。
                            </p>
                          )}
                          <p className="admin-muted">
                            {categories[doc.category]} /{' '}
                            {doc.audience === 'internal' ? '仅内部' : '发布受众 · 本项目所有客户'}
                          </p>
                          {doc.derivation && (
                            <p className="admin-notice">
                              客户版本独立审核。来源：{doc.derivation.title} · 修订 {doc.derived_from_version}
                              。
                              {doc.derivationChanged
                                ? '内部文档已产生新修订，请重新核对本篇内容。'
                                : '来源修订未变化。'}
                            </p>
                          )}
                          <div className="ws-prose">{doc.body}</div>
                          {canEdit &&
                            doc.audience === 'internal' &&
                            ['approved', 'published'].includes(doc.state) && (
                              <details>
                                <summary>编写独立客户版本</summary>
                                <p className="admin-muted">
                                  以已审核的内部文档为依据，重新编写客户标题和操作说明。请移除源码、日志、内部地址和敏感信息；新文档需要独立审核发布。
                                </p>
                                <CustomerDraftForm
                                  busy={busy}
                                  create={(value) =>
                                    void act(async () => {
                                      const result = await request<{ id: string }>(
                                        knowledge + '/documents/' + doc.id + '/customer-draft',
                                        { version: doc.version, category: doc.category, ...value },
                                      );
                                      setTab('documents');
                                      setDoc(await request<Document>(knowledge + '/documents/' + result.id));
                                      await refresh();
                                      setNotice('客户草稿已创建，需要独立审核发布。');
                                    })
                                  }
                                />
                              </details>
                            )}
                          <KnowledgeFreshness
                            key={'freshness-' + doc.id + doc.version}
                            request={request}
                            path={knowledge + '/documents/' + doc.id}
                          />
                          {!!doc.evidence?.length && (
                            <div className="ws-evidence">
                              <span className="ws-label">审核依据 · 来源快照</span>
                              {doc.evidence.map((r, i) => (
                                <div className="ws-reference" key={i}>
                                  <b>
                                    {r.path} · L{r.startLine}–{r.endLine}
                                  </b>
                                  <small>{r.revision}</small>
                                  {r.id && /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(r.id) && (
                                    <EvidenceContent request={request} base={knowledge} id={r.id} />
                                  )}
                                </div>
                              ))}
                              <p className="admin-muted">
                                人工修改不等于重新验证源码依据，请在发布前核对引用是否仍支持当前正文。
                              </p>
                            </div>
                          )}
                          <div className="ws-actions">
                            {canEdit && doc.state === 'draft' && (
                              <button disabled={busy} onClick={() => void transition('submit')}>
                                提交审核
                              </button>
                            )}
                            {canPublish && doc.state === 'in_review' && (
                              <button disabled={busy} onClick={() => void transition('approve')}>
                                审核通过
                              </button>
                            )}
                            {canPublish && ['in_review', 'approved'].includes(doc.state) && (
                              <ReturnReview
                                key={doc.id + doc.version}
                                busy={busy}
                                onReturn={(reason) => void transition('return', { reason })}
                              />
                            )}
                            {canPublish && doc.state === 'approved' && (
                              <button disabled={busy} onClick={() => void transition('publish')}>
                                {doc.audience === 'customer' ? '发布到本项目所有客户' : '发布内部版本'}
                              </button>
                            )}
                            {canPublish && doc.published_build_id && (
                              <button
                                className="ws-secondary"
                                disabled={busy}
                                onClick={() => void transition('revoke')}
                              >
                                撤回线上版本
                              </button>
                            )}
                          </div>
                          {canEdit && (
                            <details>
                              <summary>编辑新修订</summary>
                              <DocumentForm
                                key={doc.id + doc.version}
                                initial={doc}
                                busy={busy}
                                onSave={(value) =>
                                  void act(async () => {
                                    await request(knowledge + '/documents/' + doc.id, {
                                      version: doc.version,
                                      action: 'save',
                                      content: value,
                                    });
                                    setDoc(await request<Document>(knowledge + '/documents/' + doc.id));
                                    await refresh();
                                    setNotice('新修订已保存，需要重新审核。');
                                  })
                                }
                              />
                            </details>
                          )}
                          <RevisionCompare
                            key={doc.id + doc.version}
                            document={doc}
                            request={request}
                            path={knowledge + '/documents/' + doc.id}
                            canEdit={canEdit}
                            busy={busy}
                            restore={(fromVersion) => void transition('restore', { fromVersion })}
                          />
                          <h3>修订与流转记录</h3>
                          <div className="ws-history">
                            {doc.history?.map((h, i) => (
                              <div key={i}>
                                <span className="ws-dot" />
                                <div>
                                  <b>{actionNames[h.action] ?? h.action}</b>
                                  {h.reason && <p className="ws-review-reason">退回原因：{h.reason}</p>}
                                  {h.restored_from && (
                                    <p className="admin-muted">来源：修订 {h.restored_from}</p>
                                  )}
                                  <small>
                                    {h.actor} · 修订 {h.version} · {when(h.created_at)}
                                  </small>
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : article ? (
                        <>
                          <div className="ws-status-row">
                            <span className="ws-pill good">当前启用版本</span>
                            <small>{article.audience === 'internal' ? '内部知识' : '客户知识'}</small>
                          </div>
                          <h2>{article.title}</h2>
                          <p className="admin-muted">
                            {categories[article.category]} · {article.source_name}
                          </p>
                          <div className="ws-prose">{article.body}</div>
                          <div className="ws-evidence">
                            <span className="ws-label">SOURCE EVIDENCE</span>
                            <h3>来源依据</h3>
                            <p>
                              来源版本 <code>{article.revision}</code>
                            </p>
                            <p className="admin-muted">线上部署版本：未关联；来源版本不代表生产环境。</p>
                            {article.refs?.length ? (
                              article.refs.map((r, i) => (
                                <div className="ws-reference" key={i}>
                                  <b>{r.path}</b>
                                  <small>
                                    L{r.startLine}–{r.endLine} · {r.revision}
                                  </small>
                                </div>
                              ))
                            ) : (
                              <p className="admin-muted">
                                该文档没有文件行级证据；人工补充文档可在草稿页查看修订与审核记录。
                              </p>
                            )}
                          </div>
                        </>
                      ) : (
                        <Empty
                          title={tab === 'reviews' ? '让每一次发布都有依据' : '选择一篇文档开始'}
                          text={
                            tab === 'reviews'
                              ? '核对正文与受众，再审核当前修订。通过审核后仍需主动发布。'
                              : '左侧按知识层次组织已索引内容；来源、修订与文件证据保留在文档详情中。'
                          }
                        />
                      )}
                    </section>
                  </div>
                )}
              </>
            )}
          </>
        ))}
      {page === 'integrations' && (
        <>
          <div className="admin-grid">
            {overview?.integrations.map((i) => (
              <section key={i.key} className="admin-card ws-source">
                <div className="ws-status-row">
                  <span className="ws-source-icon">↗</span>
                  <span className={'ws-pill ' + (i.configured ? 'good' : '')}>
                    {i.configured ? '已配置' : '未配置'}
                  </span>
                </div>
                <h2>{i.name}</h2>
                <p>{i.detail}</p>
                <button className="ws-secondary" onClick={() => setGuide(true)}>
                  查看接入步骤
                </button>
              </section>
            ))}
          </div>
          <section className="admin-card ws-section">
            <h2>接入由部署者管理</h2>
            <p>
              连接地址、密钥和扫描路径通过本地初始化向导或部署配置管理，不在普通工作人员页面暴露。保存配置后需要在目标环境验证接口、授权与证据关联。
            </p>
            <p className="admin-muted">RAGFlow、MCP、第三方文档平台连接器尚未接入本工作空间。</p>
          </section>
        </>
      )}
      {page === 'integrations' && (
        <IntegrationReadiness request={request} base={base} canRecord={administrator} />
      )}
      {page === 'integrations' && administrator && <RetentionSettings request={request} base={base} />}
      {page === 'support' && (
        <SupportWorkspace
          request={request}
          base={base}
          administrator={administrator}
          canRead={administrator || project.roles.some((r) => ['support', 'engineer'].includes(r))}
          canCreateKnowledge={canEdit}
        />
      )}
      {page === 'operations' && (
        <OperationsWorkspace
          request={request}
          base={base}
          allowed={administrator || project.roles.includes('engineer')}
        />
      )}
      {page === 'insights' && (
        <InsightsWorkspace
          request={request}
          base={base}
          allowed={administrator || project.roles.some((r) => ['support', 'engineer'].includes(r))}
        />
      )}
    </>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="ws-empty">
      <div aria-hidden="true">▤</div>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
type DraftContent = { title: string; body: string; category: string; audience: 'internal' | 'customer' };
function DocumentForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial?: Document;
  busy: boolean;
  onSave: (v: DraftContent) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState<DraftContent>({
    title: initial?.title ?? '',
    body: initial?.body ?? '',
    category: initial?.category ?? 'overview',
    audience: initial?.audience ?? 'internal',
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <h2>{initial ? '编辑文档' : '补充产品知识'}</h2>
      <p className="admin-muted">保存为草稿。审核与发布由具备知识发布权限的人员完成。</p>
      <label>
        文档标题
        <input
          required
          minLength={2}
          maxLength={200}
          value={value.title}
          onChange={(e) => setValue({ ...value, title: e.target.value })}
        />
      </label>
      <div className="admin-form-grid">
        <label>
          知识层次
          <select value={value.category} onChange={(e) => setValue({ ...value, category: e.target.value })}>
            {Object.entries(categories).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          发布受众
          <select
            disabled={!!initial}
            value={value.audience}
            onChange={(e) => setValue({ ...value, audience: e.target.value as DraftContent['audience'] })}
          >
            <option value="internal">内部工作人员</option>
            <option value="customer">本项目所有客户</option>
          </select>
        </label>
      </div>
      {value.audience === 'customer' && (
        <p className="admin-notice">
          客户版本面向本项目所有租户。请审核标题和正文，移除文件路径、内部代码及业务敏感信息；来源引用的隐藏不会自动处理正文。
        </p>
      )}
      <label>
        正文
        <textarea
          required
          rows={12}
          minLength={10}
          maxLength={60000}
          value={value.body}
          onChange={(e) => setValue({ ...value, body: e.target.value })}
          placeholder="写下业务规则、操作说明或排障经验，并注明依据。"
        />
      </label>
      <div className="ws-actions">
        <button disabled={busy}>{busy ? '保存中…' : '保存草稿'}</button>
        {onCancel && (
          <button type="button" className="ws-secondary" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}

function ReturnReview({ busy, onReturn }: { busy: boolean; onReturn: (reason: string) => void }) {
  const [opened, setOpened] = useState(false),
    [reason, setReason] = useState('');
  return (
    <div className="ws-return">
      {!opened ? (
        <button className="ws-secondary" disabled={busy} onClick={() => setOpened(true)}>
          退回修改
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onReturn(reason);
          }}
        >
          <label>
            退回原因
            <textarea
              required
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="说明需要补充的依据或修改的内容"
            />
          </label>
          <div className="ws-actions">
            <button disabled={busy || !reason.trim()}>确认退回</button>
            <button type="button" className="ws-secondary" onClick={() => setOpened(false)}>
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
function RevisionCompare({
  document: doc,
  request,
  path,
  canEdit,
  busy,
  restore,
}: {
  document: Document;
  request: Request;
  path: string;
  canEdit: boolean;
  busy: boolean;
  restore: (version: number) => void;
}) {
  type Revision = {
    version: number;
    action: string;
    actor: string;
    created_at: string;
    snapshot: DraftContent;
    reason?: string;
  };
  const [selected, setSelected] = useState(''),
    [revision, setRevision] = useState<Revision>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setRevision(undefined);
    setError('');
    if (!selected) return;
    setLoading(true);
    void request<Revision>(path + '/revisions/' + selected)
      .then((value) => {
        if (active) setRevision(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected, path]);
  return (
    <details className="ws-revisions">
      <summary>历史修订与内容对照</summary>
      <label>
        选择历史修订
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">请选择…</option>
          {doc.history?.map((h) => (
            <option key={h.version} value={h.version}>
              修订 {h.version} · {actionNames[h.action] ?? h.action} · {when(h.created_at)}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {loading && <p>读取历史内容…</p>}
      {revision && (
        <>
          <div className="ws-compare">
            <section>
              <span className="ws-pill">历史修订 {revision.version}</span>
              <h3>{revision.snapshot.title}</h3>
              <small>
                {categories[revision.snapshot.category]} ·{' '}
                {revision.snapshot.audience === 'internal' ? '内部' : '客户'}
              </small>
              <div className="ws-prose">{revision.snapshot.body}</div>
            </section>
            <section>
              <span className="ws-pill">当前修订 {doc.version}</span>
              <h3>{doc.title}</h3>
              <small>
                {categories[doc.category]} · {doc.audience === 'internal' ? '内部' : '客户'}
              </small>
              <div className="ws-prose">{doc.body}</div>
            </section>
          </div>
          <p className="admin-muted">
            {revision.snapshot.body === doc.body &&
            revision.snapshot.title === doc.title &&
            revision.snapshot.category === doc.category &&
            revision.snapshot.audience === doc.audience
              ? '正文、标题、分类和受众一致；流转状态可能不同。'
              : '当前内容与所选历史修订有变化，请核对标题、分类、受众和正文。'}
          </p>
          {canEdit && revision.version !== doc.version && (
            <button disabled={busy || loading} onClick={() => restore(revision.version)}>
              以此修订创建新草稿
            </button>
          )}
          <p className="admin-muted">恢复会创建新修订并重新审核，现行线上版本继续保留。</p>
        </>
      )}
    </details>
  );
}

function CustomerDraftForm({
  busy,
  create,
}: {
  busy: boolean;
  create: (value: { title: string; body: string }) => void;
}) {
  const [title, setTitle] = useState(''),
    [body, setBody] = useState('');
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        create({ title, body });
      }}
    >
      <label>
        客户文档标题
        <input
          required
          minLength={2}
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        客户版正文
        <textarea
          required
          minLength={10}
          maxLength={60000}
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <button disabled={busy}>保存独立客户草稿</button>
    </form>
  );
}
