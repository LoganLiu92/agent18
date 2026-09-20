import { useEffect, useState } from 'react';
import type { LinkedEvidence } from './topic-evidence.js';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
const labels: Record<string, string> = {
  overview: '产品与领域',
  workflows: '业务流程',
  api: 'API 与数据',
  architecture: '工程架构',
  configuration: '配置与部署',
  troubleshooting: '运维与排障',
};
const states: Record<string, string> = {
  queued: '等待处理',
  running: '正在生成',
  succeeded: '生成完成',
  failed: '生成失败',
  cancelled: '已取消',
};
const errors: Record<string, string> = {
  MODEL_NOT_CONFIGURED: 'Worker 尚未配置模型。配置完成后重新生成。',
  GENERATION_EVIDENCE_UNAVAILABLE: '所选依据缺少固定原文或人工确认，请重新扫描并核对关联。',
  GENERATION_TOPIC_CHANGED: '主题定义或证据关联已变化，请按当前主题重新生成。',
  GENERATION_ACTOR_REVOKED: '发起人的编辑权限已失效。',
  GENERATION_REFERENCES_INVALID: '模型引用无效，结果未保存为草稿。',
  GENERATION_OUTPUT_INVALID: '模型输出不符合文档要求。',
  WORKER_INTERRUPTED: 'Worker 中断，请重新生成。',
};
type Job = {
  id: string;
  state: string;
  error_code: string | null;
  article_count?: number;
  imported_count?: number;
  created_at: string;
  topic: { version: number };
  categories: string[];
};
type Detail = Job & {
  input: { topic: { version: number }; evidence: { id: string; path: string; revision: string }[] };
  result?: {
    output: {
      articles: { title: string; body: string; category: string; evidenceIds: string[] }[];
      gaps: string[];
    };
    model: { name: string | null; identity: string };
    calls: number;
    tokens: number | null;
  };
  imported: { id: string; generation_index: number }[];
};
export function KnowledgeGeneration({
  request,
  base,
  topic,
  canEdit,
  onDocument,
}: {
  request: Request;
  base: string;
  topic: {
    id: string;
    version: number;
    state: string;
    required_categories: string[];
    evidence: LinkedEvidence[];
  };
  canEdit: boolean;
  onDocument: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<{ jobs: Job[]; nextOffset: number | null }>(),
    [offset, setOffset] = useState(0),
    [detail, setDetail] = useState<Detail>();
  const [selected, setSelected] = useState<string[]>([]),
    [layers, setLayers] = useState<string[]>(topic.required_categories);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const path = base + '/topics/' + topic.id + '/generations';
  useEffect(() => {
    let active = true;
    const refresh = () =>
      request<{ jobs: Job[]; nextOffset: number | null }>(path + '?offset=' + offset)
        .then((v) => {
          if (active) setJobs(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [request, path, offset]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setJobs(await request(path + '?offset=' + offset));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect(id: string) {
    setDetail(await request(base + '/generations/' + id));
  }
  const candidates = topic.evidence.filter((e) => e.confirmed && e.content_hash);
  return (
    <section className="ws-evidence">
      <span className="ws-label">LAYERED KNOWLEDGE GENERATION</span>
      <h3>分层文档生成</h3>
      <p className="admin-muted">
        选择已核对的固定证据，生成内部候选文档。每次最多 12 条依据、6 个层次、1
        次模型调用。生成完成后逐篇导入草稿，再审核发布。
      </p>
      {error && <p role="alert">{errors[error] ?? error}</p>}
      {canEdit && (
        <details>
          <summary>选择依据并生成</summary>
          {topic.state !== 'confirmed' && <p>请先确认主题范围，再生成文档。</p>}
          {!candidates.length && <p>请先关联并人工确认证据。旧快照没有固定原文时，需要重新扫描。</p>}
          <fieldset>
            <legend>生成层次</legend>
            {topic.required_categories.map((category) => (
              <label className="ws-check" key={category}>
                <input
                  type="checkbox"
                  checked={layers.includes(category)}
                  onChange={(e) =>
                    setLayers(e.target.checked ? [...layers, category] : layers.filter((c) => c !== category))
                  }
                />
                {labels[category]}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>依据（已选 {selected.length} / 12）</legend>
            {candidates.map((e) => (
              <label className="ws-check" key={e.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(e.id)}
                  disabled={!selected.includes(e.id) && selected.length >= 12}
                  onChange={(v) =>
                    setSelected(v.target.checked ? [...selected, e.id] : selected.filter((id) => id !== e.id))
                  }
                />
                <span>
                  {e.path} · L{e.start_line}–{e.end_line} ·{' '}
                  {e.relation === 'contradicts' ? '反驳' : e.relation === 'supports' ? '支持' : '背景'}
                  <small>{e.note}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <button
            disabled={busy || topic.state !== 'confirmed' || !selected.length || !layers.length}
            onClick={() =>
              void perform(async () => {
                const job = await request<{ id: string }>(base + '/topics/' + topic.id + '/generate', {
                  version: topic.version,
                  categories: layers,
                  evidenceIds: selected,
                });
                setOffset(0);
                await inspect(job.id);
              })
            }
          >
            创建生成任务
          </button>
        </details>
      )}
      <p className="admin-muted">
        任务由知识 Worker 处理。长时间等待表示尚未被 Worker 领取；失败后可按当前依据重新生成。
      </p>
      {jobs?.jobs.map((job) => (
        <div className="ws-reference" key={job.id}>
          <b>
            {states[job.state]}
            {job.state === 'succeeded'
              ? ` · 已导入 ${job.imported_count ?? 0}/${job.article_count ?? 0}`
              : ''}
          </b>
          <small>
            {new Date(job.created_at).toLocaleString('zh-CN')} · 主题版本 {job.topic.version}
          </small>
          {job.error_code && <p>{errors[job.error_code] ?? job.error_code}</p>}
          <div className="ws-actions">
            <button
              className="ws-secondary"
              disabled={busy}
              onClick={() => void perform(() => inspect(job.id))}
            >
              查看任务结果
            </button>
            {canEdit && ['queued', 'running'].includes(job.state) && (
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await request(base + '/generations/' + job.id + '/cancel', {});
                    if (detail?.id === job.id) await inspect(job.id);
                  })
                }
              >
                取消任务
              </button>
            )}
          </div>
        </div>
      ))}
      {jobs && !jobs.jobs.length && <p>暂无生成任务。</p>}
      <div className="ws-actions">
        <button disabled={busy || offset === 0} onClick={() => setOffset(offset - 20)}>
          上一页任务
        </button>
        <button disabled={busy || jobs?.nextOffset == null} onClick={() => setOffset(jobs!.nextOffset!)}>
          下一页任务
        </button>
      </div>
      {detail && (
        <div className="ws-section">
          <h4>任务详情 · {states[detail.state]}</h4>
          <button
            className="ws-secondary"
            disabled={busy}
            onClick={() => void perform(() => inspect(detail.id))}
          >
            刷新结果
          </button>
          {detail.input.topic.version !== topic.version && (
            <p role="status">主题已变化。已导入草稿保留原依据；未导入的结果需重新生成。</p>
          )}
          {detail.result && (
            <>
              <p className="admin-muted">
                模型：{detail.result.model.name ?? detail.result.model.identity} · 调用 {detail.result.calls}{' '}
                次 · Token {detail.result.tokens ?? '未提供'}
              </p>
              {detail.result.output.gaps.length > 0 && (
                <div className="admin-notice">
                  <b>待补充与冲突</b>
                  <ul>
                    {detail.result.output.gaps.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.result.output.articles.map((a, index) => {
                const imported = detail.imported.find((v) => v.generation_index === index);
                return (
                  <article className="ws-reference" key={index}>
                    <h4>{a.title}</h4>
                    <small>{labels[a.category]} · 内部草稿候选</small>
                    <details>
                      <summary>预览正文与依据</summary>
                      <div className="ws-prose">{a.body}</div>
                      {a.evidenceIds.map((id) => {
                        const e = detail.input.evidence.find((v) => v.id === id);
                        return (
                          <p key={id}>
                            {e?.path} · {e?.revision}
                          </p>
                        );
                      })}
                    </details>
                    {imported ? (
                      <button onClick={() => onDocument(imported.id)}>打开已导入草稿</button>
                    ) : (
                      canEdit && (
                        <button
                          disabled={busy || topic.version !== detail.input.topic.version}
                          onClick={() =>
                            void perform(async () => {
                              await request(base + '/generations/' + detail.id + '/import', { index });
                              await inspect(detail.id);
                            })
                          }
                        >
                          导入审核草稿
                        </button>
                      )
                    )}
                  </article>
                );
              })}
            </>
          )}
        </div>
      )}
    </section>
  );
}
export function EvidenceContent({ request, base, id }: { request: Request; base: string; id: string }) {
  const [content, setContent] = useState<{
      status: string;
      body: string | null;
      path: string;
      start_line: number;
      end_line: number;
      content_hash: string;
    }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        className="ws-secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void request<NonNullable<typeof content>>(base + '/evidence/' + id + '/content')
            .then(setContent)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        核对固定原文
      </button>
      {error && <p role="alert">{error}</p>}
      {content &&
        (content.status === 'verified' ? (
          <details open>
            <summary>
              原文指纹已校验 · {content.path} · L{content.start_line}–{content.end_line}
            </summary>
            <pre className="ws-source-text">{content.body}</pre>
            <small>固定扫描片段（已去除首尾空白）；不是当前分支或线上版本。</small>
          </details>
        ) : (
          <p>此旧快照未保存原文。请重新扫描创建新快照；不会用当前文件替代历史证据。</p>
        ))}
    </div>
  );
}
