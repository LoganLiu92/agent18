import { KnowledgeDiscovery, TopicMerge } from './knowledge-curation.js';
import { useEffect, useState, type FormEvent } from 'react';
import { KnowledgeGeneration } from './knowledge-generation.js';
import { TopicEvidence, type LinkedEvidence } from './topic-evidence.js';

type Request = <T>(path: string, body?: unknown) => Promise<T>;
const layers: Record<string, string> = {
  overview: '产品与领域',
  workflows: '业务流程',
  api: 'API 与数据',
  architecture: '工程架构',
  configuration: '配置与部署',
  troubleshooting: '运维与排障',
};
const statuses: Record<string, string> = { candidate: '待确认', confirmed: '已确认', excluded: '已排除' };
type Topic = {
  id: string;
  domain: string;
  title: string;
  description: string;
  state: string;
  version: number;
  required_categories: string[];
  document_count: number;
};
type TopicDetail = Topic & {
  evidence: LinkedEvidence[];
  evidenceTruncated: boolean;
  documents: {
    id: string;
    title: string;
    category: string;
    audience: string;
    state: string;
    evidence_count: number;
    published_article_id: string | null;
  }[];
  documentsTruncated: boolean;
  coverage: { category: string; internal: boolean; customer: boolean }[];
};
type Page = { topics: Topic[]; nextOffset: number | null };

export function KnowledgeMap({
  request,
  base,
  canEdit,
  documents,
  onDocument,
}: {
  request: Request;
  base: string;
  canEdit: boolean;
  documents: { id: string; title: string; audience: string }[];
  onDocument: (id: string) => void;
}) {
  const [page, setPage] = useState<Page>(),
    [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<TopicDetail>(),
    [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const path = base + '/topics';
  useEffect(() => {
    let active = true;
    request<Page>(path)
      .then((value) => {
        if (active) setPage(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path, request]);
  async function perform(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadPage(next: number) {
    setPage(await request<Page>(path + '?offset=' + next));
    setOffset(next);
  }
  async function select(id: string) {
    setSelected(await request<TopicDetail>(path + '/' + id));
    setCreating(false);
  }
  async function change(body: unknown) {
    if (!selected) return;
    const id = selected.id;
    await request(path + '/' + id, body);
    await select(id);
    await loadPage(offset);
    setNotice('主题已保存。归类与范围确认不会自动生成、发布或撤下文档。');
  }
  return (
    <>
      {canEdit && (
        <KnowledgeDiscovery
          request={request}
          base={base}
          onCreated={async (id) => {
            await loadPage(offset);
            await select(id);
          }}
        />
      )}
      {canEdit && selected && (
        <TopicMerge
          key={selected.id}
          request={request}
          base={base}
          source={selected}
          targets={page?.topics ?? []}
          onMerged={async (id) => {
            await loadPage(offset);
            await select(id);
          }}
        />
      )}
      <section className="admin-card ws-section">
        <div className="ws-status-row">
          <div>
            <span className="ws-label">PRODUCT KNOWLEDGE</span>
            <h2>从业务主题组织知识</h2>
          </div>
          {canEdit && (
            <button
              disabled={busy}
              onClick={() => {
                setCreating(true);
                setSelected(undefined);
              }}
            >
              新建主题
            </button>
          )}
        </div>
        <p className="admin-muted">
          先确认产品范围，再核对来源证据、生成各层文档。业务域与主题目前由人工整理，生成结果需逐篇审核。
        </p>
        <p className="admin-muted">
          主题及来源证据仅供获准工作人员查看。排除主题仅调整范围，不会撤下已发布文档。
        </p>
        {error && <p role="alert">操作未完成：{error}。如版本已变化，请重新选择主题。</p>}
        {notice && <p role="status">{notice}</p>}
      </section>
      <div className="ws-knowledge-layout">
        <section className="admin-card">
          <h3>业务域与主题</h3>
          {!page ? (
            <p>正在读取主题…</p>
          ) : !page.topics.length ? (
            <p className="admin-muted">尚无主题。可从一个业务域开始，如“发票 / 提交流程”。</p>
          ) : (
            [...new Set(page.topics.map((t) => t.domain))].map((domain) => (
              <div key={domain}>
                <h4>{domain}</h4>
                <div className="ws-document-list">
                  {page.topics
                    .filter((t) => t.domain === domain)
                    .map((t) => (
                      <button
                        key={t.id}
                        disabled={busy}
                        className={selected?.id === t.id ? 'active' : ''}
                        onClick={() => void perform(() => select(t.id))}
                      >
                        <small>
                          {statuses[t.state]} · {t.document_count} 份文档
                        </small>
                        {t.title}
                      </button>
                    ))}
                </div>
              </div>
            ))
          )}
          <div className="ws-actions">
            <button disabled={busy || offset === 0} onClick={() => void perform(() => loadPage(offset - 50))}>
              上一页
            </button>
            <button
              disabled={busy || page?.nextOffset == null}
              onClick={() => void perform(() => loadPage(page!.nextOffset!))}
            >
              下一页
            </button>
          </div>
        </section>
        <section className="admin-card ws-reader">
          {creating ? (
            <TopicForm
              busy={busy}
              save={(content) =>
                void perform(async () => {
                  const result = await request<{ id: string }>(path, content);
                  await select(result.id);
                  await loadPage(0);
                  setNotice('主题已创建，可继续关联已有文档。');
                })
              }
            />
          ) : selected ? (
            <>
              <div className="ws-status-row">
                <span className="ws-pill">{statuses[selected.state]}</span>
                <small>修订 {selected.version}</small>
              </div>
              <h2>
                {selected.domain} / {selected.title}
              </h2>
              <p className="ws-prose">{selected.description || '尚未补充适用范围。'}</p>
              <h3>所需文档与发布缺口</h3>
              <p className="admin-muted">
                逐项显示当前有效发布。草稿修改不会改变已发布覆盖；未发布仅表示缺少该受众的文档，不代表功能不存在。
              </p>
              <div className="ws-history">
                {selected.coverage.map((c) => (
                  <div key={c.category}>
                    <div>
                      <b>{layers[c.category]}</b>
                      <small>
                        内部：{c.internal ? '已发布' : '未发布'} · 客户：{c.customer ? '已发布' : '未发布'}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
              <KnowledgeGeneration
                key={'generation-' + selected.id + selected.version}
                request={request}
                base={base}
                topic={selected}
                canEdit={canEdit}
                onDocument={onDocument}
              />
              <TopicEvidence
                key={selected.id + selected.version}
                request={request}
                base={base}
                evidence={selected.evidence}
                truncated={selected.evidenceTruncated}
                canEdit={canEdit}
                busy={busy}
                mutate={(input) => perform(() => change({ ...input, version: selected.version }))}
              />
              <h3>关联文档与来源依据</h3>
              {!selected.documents.length && (
                <p className="admin-muted">
                  还没有关联文档。可先在来源页面将候选转成草稿，或手工补充业务说明。
                </p>
              )}
              <div className="ws-document-list">
                {selected.documents.map((d) => (
                  <div key={d.id} className="ws-section">
                    <button onClick={() => onDocument(d.id)}>
                      <small>
                        {layers[d.category]} · 当前修订{d.audience === 'customer' ? '面向客户' : '仅内部'}
                      </small>
                      {d.title}
                    </button>
                    <p className="admin-muted">
                      {d.evidence_count} 条来源依据 · {d.published_article_id ? '有有效发布' : '暂无有效发布'}
                    </p>
                    {canEdit && (
                      <button
                        className="ws-secondary"
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            change({ action: 'unlink', version: selected.version, documentId: d.id }),
                          )
                        }
                      >
                        移出主题
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {selected.documentsTruncated && <p>仅显示前 200 份关联文档；覆盖统计使用全部有效发布。</p>}
              {canEdit && (
                <>
                  <LinkDocument
                    key={selected.id + selected.version}
                    busy={busy}
                    documents={documents.filter(
                      (d) => !selected.documents.some((linked) => linked.id === d.id),
                    )}
                    link={(documentId) =>
                      void perform(() => change({ action: 'link', version: selected.version, documentId }))
                    }
                  />
                  <details>
                    <summary>调整范围与文档要求</summary>
                    <TopicForm
                      key={selected.id + selected.version}
                      initial={selected}
                      busy={busy}
                      save={(content) =>
                        void perform(() => change({ action: 'save', version: selected.version, content }))
                      }
                    />
                  </details>
                </>
              )}
            </>
          ) : (
            <>
              <h2>选择一个主题</h2>
              <p className="admin-muted">
                主题连接业务范围、分层文档与来源依据。支持关联多个来源产生的文档，不会因文章重命名而丢失关联。
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function LinkDocument({
  documents,
  busy,
  link,
}: {
  documents: { id: string; title: string; audience: string }[];
  busy: boolean;
  link: (id: string) => void;
}) {
  const [id, setId] = useState('');
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (id) link(id);
      }}
    >
      <label>
        关联现有文档
        <select required value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">选择文档</option>
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} · {d.audience === 'customer' ? '客户' : '内部'}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy || !id}>关联文档</button>
    </form>
  );
}
function TopicForm({
  initial,
  busy,
  save,
}: {
  initial?: Topic;
  busy: boolean;
  save: (value: unknown) => void;
}) {
  const [domain, setDomain] = useState(initial?.domain ?? ''),
    [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? ''),
    [state, setState] = useState(initial?.state ?? 'candidate');
  const [required, setRequired] = useState(
    initial?.required_categories ?? ['overview', 'workflows', 'troubleshooting'],
  );
  function submit(e: FormEvent) {
    e.preventDefault();
    save({ domain, title, description, state, requiredCategories: required });
  }
  return (
    <form className="admin-form" onSubmit={submit}>
      <h3>{initial ? '编辑主题' : '新建业务主题'}</h3>
      <label>
        业务域
        <input
          required
          maxLength={100}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="例如：发票"
        />
      </label>
      <label>
        主题名称
        <input
          required
          minLength={2}
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：外币发票提交"
        />
      </label>
      <label>
        适用范围
        <textarea maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        范围确认
        <select value={state} onChange={(e) => setState(e.target.value)}>
          {Object.entries(statuses).map(([key, text]) => (
            <option key={key} value={key}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>所需文档层次（至少一项）</legend>
        {Object.entries(layers).map(([key, text]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={required.includes(key)}
              onChange={(e) =>
                setRequired(e.target.checked ? [...required, key] : required.filter((v) => v !== key))
              }
            />
            {text}
          </label>
        ))}
      </fieldset>
      <button disabled={busy || !required.length}>{busy ? '保存中…' : '保存主题'}</button>
    </form>
  );
}
