import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Result = {
  questionId: string;
  question: string;
  passed: boolean;
  expectedAnswer?: string;
  expectNoAnswer?: boolean;
  severity?: string;
  candidatePassed?: boolean;
  candidateCitations?: Result['citations'];
  citations: { id: string; title: string; sourceId: string; publication: string }[];
};
type Data = {
  reviews: {
    id: string;
    run_id: string;
    question_id: string;
    candidate: boolean;
    verdict: string;
    note: string;
  }[];
  candidates: { id: string; title: string; version: number; state: string }[];
  questions: { id: string; question: string; expected_sources: string[]; version: number }[];
  sources: { id: string; name: string }[];
  runs: { id: string; created_at: string; results: Result[] }[];
};
export function KnowledgePlayground({
  request,
  base,
  canEdit,
  canReview,
}: {
  request: Request;
  base: string;
  canEdit: boolean;
  canReview: boolean;
}) {
  const [data, setData] = useState<Data>(),
    [query, setQuery] = useState(''),
    [answer, setAnswer] = useState(''),
    [noAnswer, setNoAnswer] = useState(false),
    [high, setHigh] = useState(false),
    [forbidden, setForbidden] = useState(''),
    [candidateIds, setCandidateIds] = useState<string[]>([]),
    [expected, setExpected] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [citations, setCitations] =
      useState<{ id: string; title: string; excerpt: string; publication: string }[]>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Result[]>();
  const path = base + '/evaluation';
  useEffect(() => {
    let active = true;
    request<Data>(path)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setData(await request<Data>(path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="admin-card">
        <h2>检索 Playground 与黄金问题</h2>
        <p>
          使用客户检索相同的词项排序，只检索已启用、已发布且不限租户的客户文档。此页验证检索命中，不代表模型回答质量或指定客户的完整权限结果。
        </p>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () =>
              setCitations(
                (
                  await request<{ citations: NonNullable<typeof citations> }>(path + '/search', {
                    question: query,
                  })
                ).citations,
              ),
            );
          }}
        >
          <label>
            验证问题
            <textarea
              required
              minLength={2}
              maxLength={1000}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button disabled={busy}>测试客户公开知识检索</button>
        </form>
        {citations && (
          <>
            <h3>前五条命中</h3>
            {citations.map((c) => (
              <article key={c.id} className="ws-reference">
                <b>{c.title}</b>
                <p>{c.excerpt}</p>
                <small>发布快照 {c.publication}</small>
              </article>
            ))}
            {!citations.length && <p>没有找到匹配的公开知识；这不是答案不存在的证明。</p>}
          </>
        )}
        {canEdit && (
          <details>
            <summary>将当前问题加入回归集</summary>
            <p>
              勾选必须命中的已发布来源，最多五项；不可回答题要求没有检索命中。自动结果验证检索与引用，语义正确性另由审核者标注。
            </p>
            <label>
              预期答案 / 复核标准
              <textarea maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
            </label>
            <label>
              <input
                type="checkbox"
                checked={noAnswer}
                onChange={(e) => {
                  setNoAnswer(e.target.checked);
                  setExpected([]);
                }}
              />
              不可回答题
            </label>
            <label>
              <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} />
              高优先级：关联客户文档发布前须通过最新候选回归；有预期答案时还须语义复核正确
            </label>
            <label>
              禁止命中的来源编号（逗号分隔）
              <input value={forbidden} onChange={(e) => setForbidden(e.target.value)} />
            </label>
            {[
              ...(data?.sources ?? []),
              ...(data?.candidates ?? [])
                .filter((c) => !data?.sources.some((s) => s.id === c.id))
                .map((c) => ({ id: c.id, name: c.title + '（客户候选稿）' })),
            ].map((s) => (
              <label className="ws-check" key={s.id}>
                <input
                  type="checkbox"
                  checked={expected.includes(s.id)}
                  disabled={noAnswer}
                  onChange={(e) =>
                    setExpected(e.target.checked ? [...expected, s.id] : expected.filter((id) => id !== s.id))
                  }
                />
                {s.name}
              </label>
            ))}
            <button
              disabled={
                busy || query.trim().length < 2 || (!noAnswer && !expected.length) || expected.length > 5
              }
              onClick={() =>
                void act(async () => {
                  await request(path + '/questions', {
                    question: query,
                    expectedSources: expected,
                    expectedAnswer: answer,
                    expectNoAnswer: noAnswer,
                    severity: high ? 'high' : 'normal',
                    forbiddenSources: forbidden
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
                  });
                  setExpected([]);
                })
              }
            >
              保存黄金问题
            </button>
          </details>
        )}
      </section>
      <section className="admin-card">
        <h2>固定问题集</h2>
        <p>最多保留 100 道启用问题，每次回归最多 30 道。问题、预期来源和命中的发布版本随报告保留。</p>
        {data?.questions.map((q) => (
          <div className="ws-reference" key={q.id}>
            <label className="ws-check">
              <input
                type="checkbox"
                checked={selected.includes(q.id)}
                onChange={(e) =>
                  setSelected(e.target.checked ? [...selected, q.id] : selected.filter((id) => id !== q.id))
                }
              />
              {q.question}
            </label>
            {canEdit && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await request(path + '/questions/' + q.id + '/archive', { version: q.version });
                    setSelected((v) => v.filter((id) => id !== q.id));
                  })
                }
              >
                停用问题
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <details>
            <summary>同时比较候选客户文档（最多 20 份）</summary>
            <p>候选内容只用于此处对照，不会进入客户检索或绕过发布审核。</p>
            {data?.candidates.map((d) => (
              <label className="ws-check" key={d.id}>
                <input
                  type="checkbox"
                  checked={candidateIds.includes(d.id)}
                  disabled={!candidateIds.includes(d.id) && candidateIds.length >= 20}
                  onChange={(e) =>
                    setCandidateIds(
                      e.target.checked ? [...candidateIds, d.id] : candidateIds.filter((id) => id !== d.id),
                    )
                  }
                />
                {d.title} · v{d.version}
              </label>
            ))}
          </details>
        )}
        {canEdit && (
          <button
            disabled={busy || !selected.length || selected.length > 30}
            onClick={() =>
              void act(async () =>
                setResult(
                  (
                    await request<{ results: Result[] }>(path + '/run', {
                      questionIds: selected,
                      candidateDocuments: data!.candidates
                        .filter((d) => candidateIds.includes(d.id))
                        .map((d) => ({ id: d.id, version: d.version })),
                    })
                  ).results,
                ),
              )
            }
          >
            运行所选问题
          </button>
        )}
        {result && <EvalResult results={result} />}
      </section>
      <section className="admin-card">
        <h2>最近 20 次回归</h2>
        {data?.runs.map((r) => (
          <details key={r.id}>
            <summary>
              {new Date(r.created_at).toLocaleString()} · {r.results.filter((x) => x.passed).length}/
              {r.results.length} 通过
            </summary>
            <EvalResult results={r.results} />
            {r.results.map((q) => (
              <div key={q.questionId}>
                <p>
                  {q.question}：
                  {data.reviews
                    .filter((v) => v.run_id === r.id && v.question_id === q.questionId)
                    .slice(0, 2)
                    .map((v) => `${v.candidate ? '候选' : '发布'} / ${v.verdict} / ${v.note}`)
                    .join('；') || '尚未语义复核'}
                </p>
                {canReview && (
                  <ReviewForm
                    busy={busy}
                    candidateAvailable={q.candidatePassed !== undefined}
                    save={(input) =>
                      act(async () => {
                        await request(path + '/reviews', { runId: r.id, questionId: q.questionId, ...input });
                      })
                    }
                  />
                )}
              </div>
            ))}
          </details>
        ))}
      </section>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
    </>
  );
}
function EvalResult({ results }: { results: Result[] }) {
  return (
    <>
      {results.map((r) => (
        <article className="ws-reference" key={r.questionId}>
          <b>
            {r.passed ? '通过' : '未通过'} · {r.question}
          </b>
          {r.expectedAnswer && <p>预期答案：{r.expectedAnswer}</p>}
          {r.expectNoAnswer && <p>期望没有可用证据；不得编造答案。</p>}
          {r.candidatePassed !== undefined && (
            <p>
              候选集合：{r.candidatePassed ? '通过' : '未通过'} ·{' '}
              {r.candidateCitations?.map((c) => c.title + ' ' + c.publication).join('、')}
            </p>
          )}
          {r.citations.map((c) => (
            <p key={c.id}>
              {c.title}
              <small>{c.publication}</small>
            </p>
          ))}
        </article>
      ))}
    </>
  );
}

function ReviewForm({
  busy,
  candidateAvailable,
  save,
}: {
  busy: boolean;
  candidateAvailable: boolean;
  save: (input: { candidate: boolean; verdict: string; note: string }) => Promise<void>;
}) {
  const [candidate, setCandidate] = useState(candidateAvailable),
    [verdict, setVerdict] = useState('unknown'),
    [note, setNote] = useState('');
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save({ candidate, verdict, note });
      }}
    >
      <label>
        复核版本
        <select
          value={candidate ? 'candidate' : 'published'}
          onChange={(e) => setCandidate(e.target.value === 'candidate')}
        >
          <option value="published">已发布结果</option>
          {candidateAvailable && <option value="candidate">候选结果</option>}
        </select>
      </label>
      <label>
        语义复核
        <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          <option value="unknown">待核实</option>
          <option value="correct">正确</option>
          <option value="incorrect">错误</option>
        </select>
      </label>
      <label>
        证据及复核说明
        <textarea
          required
          minLength={5}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button disabled={busy}>追加复核记录</button>
    </form>
  );
}
