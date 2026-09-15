import { useEffect, useRef, useState } from 'react';
import type { Agent18, CaseDetail, CaseMessage } from '@agent18/web-sdk';
export function CaseConversation({
  client,
  caseId,
  onChanged,
}: {
  client: Agent18;
  caseId: string;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<CaseDetail>(),
    [messages, setMessages] = useState<CaseMessage[]>([]),
    [body, setBody] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const refresh = async () => {
    const [d, m] = await Promise.all([client.getCase(caseId), client.caseMessages(caseId)]);
    setDetail(d);
    setMessages(m.messages);
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void act(async () => {});
  }, [caseId]);
  const labels = {
    pending: '等待处理',
    running: '正在检索资料',
    completed: '资料检索完成',
    blocked: '需要继续跟进',
    cancelled: '处理已取消',
    failed: '自动处理未完成',
  };
  return (
    <div className="case-conversation">
      {error && (
        <p role="alert" className="experience-alert">
          {error}
        </p>
      )}
      {detail && (
        <>
          <div className="ops-card-head">
            <span className="experience-badge">
              {detail.case.status === 'resolved' ? '已解决' : '跟进中'}
            </span>
            <button disabled={busy} onClick={() => void act(async () => {})}>
              刷新进展 ↻
            </button>
          </div>
          <h3>{detail.case.title}</h3>
          <p className="ops-description">{detail.case.description}</p>
          <div className="case-progress">
            {detail.runs.slice(0, 3).map((r) => (
              <article key={r.id}>
                <b>{labels[r.state]}</b>
                <small>{r.completedAt ? new Date(r.completedAt).toLocaleString() : '支持处理队列'}</small>
                {r.outcome && (
                  <p>
                    {r.outcome === 'EVIDENCE_COLLECTED_NEEDS_HUMAN' ||
                    r.outcome === 'RETRIEVAL_COMPLETE_NEEDS_HUMAN'
                      ? '已找到相关资料，等待确认是否解决你的问题。'
                      : r.outcome === 'NO_SOURCE_NEEDS_HUMAN'
                        ? '暂未找到足够资料，支持团队会继续跟进。'
                        : '自动处理尚未完成，支持团队可以查看原因并继续跟进。'}
                  </p>
                )}
              </article>
            ))}
          </div>
          {detail.evidence.length > 0 && (
            <details>
              <summary>相关资料与引用（{detail.evidence.length}）</summary>
              {detail.evidence.map((e) => (
                <article key={e.id}>
                  <h4>{e.citation?.title ?? e.resource.type}</h4>
                  <p className="ops-description">{e.summary}</p>
                  <small>
                    {e.source} · {e.provenance.sourceVersion}
                  </small>
                </article>
              ))}
            </details>
          )}
          <div className="case-thread">
            {messages.map((m) => (
              <article className={'case-message ' + m.author} key={m.id}>
                <b>{m.author === 'support' ? '支持团队' : '你'}</b>
                <p>{m.body}</p>
                <small>{new Date(m.createdAt).toLocaleString()}</small>
              </article>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await client.addCaseMessage(caseId, body, key.current);
                setBody('');
                key.current = crypto.randomUUID();
              });
            }}
          >
            <label>
              补充说明
              <textarea
                required
                maxLength={4000}
                rows={3}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  key.current = crypto.randomUUID();
                }}
                placeholder="补充操作过程，或回复支持团队"
              />
            </label>
            <div className="ops-buttons">
              <button className="experience-primary" disabled={busy}>
                发送补充说明
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    client.setCaseStatus(
                      caseId,
                      detail.case.status === 'resolved' ? 'needs_human' : 'resolved',
                    ),
                  )
                }
              >
                {detail.case.status === 'resolved' ? '重新打开问题' : '问题已解决 ✓'}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
