import { EvidenceContent } from './knowledge-generation.js';
import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Evidence = {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  content_hash: string | null;
  provenance_state: string;
};
export type LinkedEvidence = Evidence & {
  relation: string;
  note: string;
  confirmed: boolean;
  snapshot_id: string;
  source_name: string;
  source_revision: string;
  observed_at: string | null;
  source_enabled: boolean;
  linked_by: string;
};
type Snapshot = {
  id: string;
  name: string;
  source_revision: string;
  observed_at: string | null;
  evidence_count: number;
  provenance_state: string;
};
type SnapshotPage = { snapshots: Snapshot[]; nextOffset: number | null };
type Detail = Snapshot & {
  fingerprint: string | null;
  source_enabled: boolean;
  generation: { mode?: string; model?: { identity?: string; name?: string } };
  reference_count: number;
  evidence: Evidence[];
  nextOffset: number | null;
};
const relations: Record<string, string> = {
  context: '背景依据',
  supports: '支持主题说明',
  contradicts: '反驳主题说明',
};
const observed = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN') : '未知（原记录缺失）';

export function TopicEvidence({
  request,
  base,
  evidence,
  truncated,
  canEdit,
  busy,
  mutate,
}: {
  request: Request;
  base: string;
  evidence: LinkedEvidence[];
  truncated: boolean;
  canEdit: boolean;
  busy: boolean;
  mutate: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [page, setPage] = useState<SnapshotPage>(),
    [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<Detail>(),
    [evidenceOffset, setEvidenceOffset] = useState(0);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [picked, setPicked] = useState(''),
    [relation, setRelation] = useState('context'),
    [note, setNote] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const path = base + '/snapshots';
  useEffect(() => {
    let active = true;
    request<SnapshotPage>(path)
      .then((p) => {
        if (active) setPage(p);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path, request]);
  async function load(work: () => Promise<void>) {
    setLoading(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function snapshots(next: number) {
    setPage(await request<SnapshotPage>(path + '?offset=' + next));
    setOffset(next);
  }
  async function inspect(id: string, next = 0) {
    setDetail(await request<Detail>(path + '/' + id + '?offset=' + next));
    setEvidenceOffset(next);
    setPicked('');
  }
  const disabled = busy || loading;
  return (
    <section className="ws-evidence ws-topic-evidence">
      <span className="ws-label">SOURCE SNAPSHOTS / EVIDENCE</span>
      <h3>主题证据链</h3>
      <p className="admin-muted">
        来源版本仅代表当时扫描内容，线上部署版本尚未关联。文件引用提供核对位置，不自动证明业务结论。
      </p>
      {!evidence.length && <p>暂无直接关联的证据。文档归类不会自动确认其证据支持当前主题。</p>}
      {evidence.map((e) => (
        <article className="ws-reference" key={e.id}>
          <b>
            {relations[e.relation]} · {e.path} · L{e.start_line}–{e.end_line}
          </b>
          <small>
            {e.source_name} · 来源版本 {e.source_revision}
          </small>
          <p>{e.note}</p>
          <EvidenceContent request={request} base={base} id={e.id} />
          <small>
            {e.confirmed ? '人工确认关联' : '关联待核实'} · {e.linked_by}
          </small>
          <small>
            观察时间：{observed(e.observed_at)} · {e.content_hash ? '有内容指纹' : '内容指纹未知'}
          </small>
          {!e.source_enabled && <p>来源已停用；此处保留历史核对依据。</p>}
          <div className="ws-actions">
            <button
              disabled={disabled}
              className="ws-secondary"
              onClick={() => void load(() => inspect(e.snapshot_id))}
            >
              查看原始快照
            </button>
            {canEdit && (
              <>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void mutate({
                      action: 'evidence-review',
                      evidenceId: e.id,
                      confirmed: !e.confirmed,
                      relation: e.relation,
                      note: e.note,
                    })
                  }
                >
                  {e.confirmed ? '改为待核实' : '确认此关联'}
                </button>
                <button
                  disabled={disabled}
                  className="ws-secondary"
                  onClick={() => void mutate({ action: 'evidence-unlink', evidenceId: e.id })}
                >
                  移除关联
                </button>
              </>
            )}
          </div>
        </article>
      ))}
      {truncated && <p>显示最近 200 条关联；完整关联分页尚待补充。</p>}
      <details>
        <summary>浏览来源快照与文件依据</summary>
        {error && <p role="alert">读取未完成：{error}</p>}
        <label>
          来源快照
          <select
            aria-label="来源快照"
            disabled={disabled || !page}
            value={page?.snapshots.some((s) => s.id === detail?.id) ? detail!.id : ''}
            onChange={(e) => {
              if (e.target.value) void load(() => inspect(e.target.value));
            }}
          >
            <option value="">选择已完成的扫描快照</option>
            {page?.snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.source_revision.slice(0, 12)} · {s.evidence_count} 条引用
              </option>
            ))}
          </select>
        </label>
        {page && !page.snapshots.length && (
          <p>暂无来源快照。请先连接资料并完成扫描；人工文档不会伪造源码证据。</p>
        )}
        <div className="ws-actions">
          <button disabled={disabled || offset === 0} onClick={() => void load(() => snapshots(offset - 50))}>
            上一页快照
          </button>
          <button
            disabled={disabled || page?.nextOffset == null}
            onClick={() => void load(() => snapshots(page!.nextOffset!))}
          >
            下一页快照
          </button>
        </div>
      </details>
      {detail && (
        <div className="ws-section">
          <h4>{detail.name} / 固定快照</h4>
          <p>
            来源版本：<code>{detail.source_revision}</code>
          </p>
          <p className="admin-muted">
            观察时间：{observed(detail.observed_at)} ·{' '}
            {detail.provenance_state === 'legacy' ? '历史记录，部分信息未知' : '已记录来源信息'}
          </p>
          <p className="admin-muted">
            生成方式：{detail.generation.mode ?? '未知'} · 模型：
            {detail.generation.model?.name ?? detail.generation.model?.identity ?? '未记录或未使用'}
          </p>
          {!detail.source_enabled && <p>来源已停用；快照仅供内部历史核对。</p>}
          {detail.reference_count > detail.evidence_count && (
            <p role="status">
              {detail.reference_count - detail.evidence_count} 条旧引用因定位无效或版本不一致未建立证据关系。
            </p>
          )}
          <p>{detail.evidence_count} 条可追溯引用。相同文件被不同文章引用时分别保留。</p>
          {detail.evidence.map((e) => (
            <div className="ws-reference" key={e.id}>
              <b>
                {e.path} · L{e.start_line}–{e.end_line}
              </b>
              <small>内容指纹：{e.content_hash ?? '未知'}</small>
              <EvidenceContent request={request} base={base} id={e.id} />
              {canEdit && (
                <button
                  disabled={disabled || evidence.some((v) => v.id === e.id)}
                  className="ws-secondary"
                  onClick={() => setPicked(e.id)}
                >
                  {evidence.some((v) => v.id === e.id)
                    ? '已关联'
                    : picked === e.id
                      ? '已选择这条依据'
                      : '选择这条依据'}
                </button>
              )}
            </div>
          ))}
          <div className="ws-actions">
            <button
              disabled={disabled || !evidenceOffset}
              onClick={() => void load(() => inspect(detail.id, evidenceOffset - 50))}
            >
              上一页依据
            </button>
            <button
              disabled={disabled || detail.nextOffset == null}
              onClick={() => void load(() => inspect(detail.id, detail.nextOffset!))}
            >
              下一页依据
            </button>
          </div>
          {picked && canEdit && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate({ action: 'evidence-link', evidenceId: picked, relation, note, confirmed });
              }}
            >
              <label>
                关联类型
                <select value={relation} onChange={(e) => setRelation(e.target.value)}>
                  {Object.entries(relations).map(([key, text]) => (
                    <option key={key} value={key}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                关联说明
                <textarea
                  required
                  minLength={2}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="说明这段来源与主题的关系，以及仍需核实的条件。"
                />
              </label>
              <label className="ws-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                我已核对这条关联（不代表已验证生产行为）
              </label>
              <button disabled={disabled}>保存证据关联</button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
