import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Conflict = {
  id: string;
  rule_key: string;
  comparison_scope: string;
  topic_title: string;
  claims: { kind: string; id: string; version: string; value: string }[];
  state: string;
  version: number;
  resolution: string | null;
};
type Impact = {
  id: string;
  title: string;
  state: string;
  topics: string[];
  evidence: { path: string; revision: string; latestRevision: string | null; status: string }[] | null;
  origin_case_id: string | null;
  case_review_required: boolean;
};
export function KnowledgeMaintenance({
  request,
  base,
  mode,
  canEdit,
  canReview,
  onDocument,
}: {
  request: Request;
  base: string;
  mode: 'conflicts' | 'impact';
  canEdit: boolean;
  canReview: boolean;
  onDocument: (id: string) => void;
}) {
  const [conflicts, setConflicts] = useState<Conflict[]>([]),
    [documents, setDocuments] = useState<Impact[]>([]),
    [offset, setOffset] = useState(0),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [state, setState] = useState('open');
  const path = base + '/' + mode;
  useEffect(() => {
    let active = true;
    request<{ conflicts?: Conflict[]; documents?: Impact[]; nextOffset: number | null }>(
      path +
        '?' +
        new URLSearchParams({ offset: String(offset), ...(mode === 'conflicts' ? { state } : {}) }),
    )
      .then((r) => {
        if (active) {
          setConflicts(r.conflicts ?? []);
          setDocuments(r.documents ?? []);
          setNext(r.nextOffset);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path, offset, state, revision, mode]);
  return (
    <>
      <section className="admin-card">
        <h2>{mode === 'conflicts' ? '知识冲突队列' : '来源变更影响'}</h2>
        <p>
          {mode === 'conflicts'
            ? '针对同一业务概念、规则和适用范围登记矛盾依据，由发布人员核对裁决。裁决不会自动修改或发布文档。'
            : '比较已完成扫描的证据片段与文档引用。仓库变化不等同于线上版本变化；缺少原文时显示未知。'}
        </p>
        {mode === 'conflicts' && (
          <label>
            筛选
            <select
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setOffset(0);
              }}
            >
              <option value="open">待处理</option>
              <option value="resolved">已解决</option>
              <option value="dismissed">无需处理</option>
              <option value="all">全部</option>
            </select>
          </label>
        )}
        <button onClick={() => setRevision((x) => x + 1)}>刷新</button>
      </section>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {mode === 'conflicts' && canEdit && (
        <ConflictCreate request={request} base={base} changed={() => setRevision((x) => x + 1)} />
      )}
      {conflicts.map((c) => (
        <section className="admin-card" key={c.id}>
          <span className="ws-pill">{c.state}</span>
          <h3>
            {c.topic_title} · {c.rule_key}
          </h3>
          <p>同一适用范围：{c.comparison_scope}</p>
          {c.claims.map((cl) => (
            <article className="ws-reference" key={cl.kind + cl.id}>
              <p>{cl.value}</p>
              <small>
                {cl.kind} · {cl.id} · 固定版本 {cl.version}
              </small>
            </article>
          ))}
          {c.resolution && <p>最近裁决：{c.resolution}</p>}
          {canReview && (
            <ConflictDecision
              key={c.version}
              request={request}
              path={path + '/' + c.id}
              conflict={c}
              changed={() => setRevision((x) => x + 1)}
            />
          )}
        </section>
      ))}
      {documents.map((d) => (
        <section className="admin-card" key={d.id}>
          <h3>{d.title}</h3>
          <small>
            {d.topics.join(' / ') || '尚未关联知识主题'} · {d.state}
          </small>
          {d.evidence?.map((e, i) => (
            <p key={i}>
              <span className="ws-pill">
                {
                  ({ changed: '需复核', unchanged: '片段一致', unknown: '未知' } as Record<string, string>)[
                    e.status
                  ]
                }
              </span>{' '}
              {e.path}
              <small>
                引用版本 {e.revision} / 最近扫描 {e.latestRevision ?? '未知'}
              </small>
            </p>
          ))}
          {d.origin_case_id && (
            <p>
              {d.case_review_required
                ? '来源工单已重开：需要重新核实并审核知识。'
                : '来自已审核的工单处理经验。'}{' '}
              {d.origin_case_id}
            </p>
          )}
          <button onClick={() => onDocument(d.id)}>核对文档</button>
        </section>
      ))}
      {!conflicts.length && !documents.length && <section className="admin-card">当前范围没有记录。</section>}
      <div className="ws-actions">
        <button disabled={!offset} onClick={() => setOffset(offset - 50)}>
          上一页
        </button>
        <button disabled={next === null} onClick={() => setOffset(next!)}>
          下一页
        </button>
      </div>
    </>
  );
}
function ConflictDecision({
  request,
  path,
  conflict,
  changed,
}: {
  request: Request;
  path: string;
  conflict: Conflict;
  changed: () => void;
}) {
  const [reason, setReason] = useState(''),
    [state, setState] = useState(conflict.state === 'open' ? 'resolved' : 'open'),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void request(path, { version: conflict.version, state, reason })
          .then(changed)
          .catch((e) => setMessage(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        裁决
        <select value={state} onChange={(e) => setState(e.target.value)}>
          {['open', 'resolved', 'dismissed']
            .filter((s) => s !== conflict.state)
            .map((s) => (
              <option key={s} value={s}>
                {
                  (
                    {
                      open: '重新打开',
                      resolved: '证据核实并已安排修正',
                      dismissed: '范围不相同或无需修正',
                    } as Record<string, string>
                  )[s]
                }
              </option>
            ))}
        </select>
      </label>
      <label>
        依据与处理结果
        <textarea
          required
          minLength={10}
          maxLength={4000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button disabled={busy}>记录人工裁决</button>
      <p role="status">{message}</p>
    </form>
  );
}
function ConflictCreate({ request, base, changed }: { request: Request; base: string; changed: () => void }) {
  const [topics, setTopics] = useState<{ id: string; title: string; state: string }[]>([]),
    [topicId, setTopicId] = useState(''),
    [refs, setRefs] = useState<{ kind: 'document' | 'source'; id: string; version: string; label: string }[]>(
      [],
    ),
    [candidates, setCandidates] = useState<{ ruleKey: string; claims: Conflict['claims'] }[]>([]),
    [left, setLeft] = useState(''),
    [right, setRight] = useState(''),
    [leftValue, setLeftValue] = useState(''),
    [rightValue, setRightValue] = useState(''),
    [ruleKey, setRuleKey] = useState(''),
    [comparisonScope, setComparisonScope] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [topicOffset, setTopicOffset] = useState(0),
    [more, setMore] = useState(true);
  async function load() {
    const p = await request<{ topics: typeof topics; nextOffset: number | null }>(
      base + '/topics?offset=' + topicOffset,
    );
    setTopics((v) => [...v, ...p.topics.filter((t) => t.state === 'confirmed')]);
    setMore(p.nextOffset !== null);
    setTopicOffset(p.nextOffset ?? 0);
  }
  return (
    <details
      className="admin-card"
      onToggle={(e) => {
        if (e.currentTarget.open && !topics.length && more) void load().catch((e) => setError(e.message));
      }}
    >
      <summary>登记规则冲突</summary>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          const a = refs.find((r) => r.kind + ':' + r.id === left),
            b = refs.find((r) => r.kind + ':' + r.id === right);
          if (!a || !b) return;
          setBusy(true);
          void request(base + '/conflicts', {
            topicId,
            ruleKey,
            comparisonScope,
            claims: [
              { kind: a.kind, id: a.id, version: a.version, value: leftValue },
              { kind: b.kind, id: b.id, version: b.version, value: rightValue },
            ],
          })
            .then(() => {
              setError('冲突已登记，等待发布人员核对。');
              setLeftValue('');
              setRightValue('');
              changed();
            })
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          已确认知识主题
          <select
            required
            value={topicId}
            onChange={(e) => {
              const id = e.target.value;
              setTopicId(id);
              setCandidates([]);
              setRefs([]);
              setLeft('');
              setRight('');
              if (id)
                void request<{
                  documents: { id: string; title: string; version: number }[];
                  evidence: { id: string; path: string; source_revision: string; confirmed: boolean }[];
                }>(base + '/topics/' + id)
                  .then((t) => {
                    setRefs([
                      ...t.documents.map((d) => ({
                        kind: 'document' as const,
                        id: d.id,
                        version: String(d.version),
                        label: d.title,
                      })),
                      ...t.evidence
                        .filter((e) => e.confirmed)
                        .map((e) => ({
                          kind: 'source' as const,
                          id: e.id,
                          version: e.source_revision,
                          label: e.path,
                        })),
                    ]);
                  })
                  .catch((e) => setError(e.message));
            }}
          >
            <option value="">选择知识主题</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {more && (
          <button type="button" onClick={() => void load().catch((e) => setError(e.message))}>
            加载更多主题
          </button>
        )}
        <button
          type="button"
          disabled={!topicId || busy}
          onClick={() => {
            setBusy(true);
            void request<{ candidates: typeof candidates; truncated: boolean }>(base + '/conflicts/scan', {
              topicId,
            })
              .then((r) => {
                setCandidates(r.candidates);
                setError(
                  r.truncated
                    ? '仅扫描前 100 项，请缩小主题范围。'
                    : r.candidates.length
                      ? '发现明确数值差异，请核对共同业务范围后登记。'
                      : '未发现支持的明确赋值差异，不代表没有业务冲突。',
                );
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          扫描明确规则差异
        </button>
        {candidates.map((c) => (
          <button
            type="button"
            key={c.ruleKey}
            onClick={() => {
              setRuleKey(c.ruleKey);
              setLeft(c.claims[0]!.kind + ':' + c.claims[0]!.id);
              setRight(
                c.claims.find((v) => v.value !== c.claims[0]!.value)!.kind +
                  ':' +
                  c.claims.find((v) => v.value !== c.claims[0]!.value)!.id,
              );
              setLeftValue(c.claims[0]!.value);
              setRightValue(c.claims.find((v) => v.value !== c.claims[0]!.value)!.value);
            }}
          >
            {c.ruleKey} · {c.claims.map((v) => v.value).join(' / ')}
          </button>
        ))}
        <label>
          同一业务规则
          <input
            required
            minLength={2}
            maxLength={120}
            value={ruleKey}
            onChange={(e) => setRuleKey(e.target.value)}
            placeholder="例如：单个附件上传上限"
          />
        </label>
        <label>
          共同适用范围与业务版本
          <input
            required
            minLength={5}
            maxLength={500}
            value={comparisonScope}
            onChange={(e) => setComparisonScope(e.target.value)}
            placeholder="例如：企业版 / 生产环境 / v2.3 / 单文件"
          />
        </label>
        {[
          { label: '依据 A', selected: left, set: setLeft, value: leftValue, setValue: setLeftValue },
          { label: '依据 B', selected: right, set: setRight, value: rightValue, setValue: setRightValue },
        ].map((f) => (
          <fieldset key={f.label}>
            <legend>{f.label}</legend>
            <select required value={f.selected} onChange={(e) => f.set(e.target.value)}>
              <option value="">选择已关联的固定依据</option>
              {refs.map((r) => (
                <option key={r.kind + r.id} value={r.kind + ':' + r.id}>
                  {r.label} · {r.kind} · {r.version}
                </option>
              ))}
            </select>
            <label>
              该依据所述规则
              <textarea
                required
                maxLength={1000}
                value={f.value}
                onChange={(e) => f.setValue(e.target.value)}
              />
            </label>
          </fieldset>
        ))}
        <button disabled={busy || left === right}>创建待核对冲突</button>
      </form>
      <p role="status">{error}</p>
    </details>
  );
}
