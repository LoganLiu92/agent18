import { useEffect, useRef, useState } from 'react';
import type { Agent18, Conversation, ConversationDetail, ConversationReference } from '@agent18/web-sdk';
export function CustomerHistory({ client }: { client: Agent18 }) {
  const [list, setList] = useState<Conversation[]>([]),
    [detail, setDetail] = useState<ConversationDetail>(),
    [offset, setOffset] = useState(0),
    [next, setNext] = useState<number | null>(null),
    [question, setQuestion] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [confirmDelete, setConfirmDelete] = useState(false);
  const creation = useRef({ key: crypto.randomUUID(), id: '' }),
    pending = useRef<
      | {
          question: string;
          userKey: string;
          assistantKey: string;
          answer?: string;
          references?: ConversationReference[];
        }
      | undefined
    >(undefined);
  async function refresh() {
    const p = await client.listConversations(offset);
    setList(p.conversations);
    setNext(p.nextOffset);
  }
  useEffect(() => {
    let active = true;
    client
      .listConversations(offset)
      .then((p) => {
        if (active) {
          setList(p.conversations);
          setNext(p.nextOffset);
        }
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [client, offset]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    const d = await client.getConversation(id);
    setDetail(d);
    creation.current = { key: crypto.randomUUID(), id };
    pending.current = undefined;
    setConfirmDelete(false);
  }
  async function ask() {
    const turn = pending.current ?? {
      question: question.trim(),
      userKey: crypto.randomUUID(),
      assistantKey: crypto.randomUUID(),
    };
    pending.current = turn;
    if (!creation.current.id)
      creation.current.id = (
        await client.createConversation(turn.question.slice(0, 120), creation.current.key)
      ).conversation.id;
    const id = creation.current.id;
    await client.addConversationMessage(id, 'user', turn.question, turn.userKey);
    if (turn.answer === undefined) {
      const result = await client.askKnowledge(turn.question);
      turn.references = result.citations
        .slice(0, 5)
        .map((c) => ({ kind: 'knowledge', id: c.id, observedAt: c.observedAt }));
      turn.answer = [result.answer, result.notice, ...result.citations.map((c) => c.title + '：' + c.excerpt)]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 8000);
    }
    await client.addConversationMessage(
      id,
      'assistant',
      turn.answer || '未找到足够的可见资料，请联系支持团队。',
      turn.assistantKey,
      turn.references,
    );
    setQuestion('');
    pending.current = undefined;
    await open(id);
    await refresh();
    setMessage('回答与对话已保存。');
  }
  return (
    <div className="knowledge-workspace">
      <section className="panel knowledge-tree">
        <h2>我的对话</h2>
        <button
          disabled={busy}
          onClick={() => {
            creation.current = { key: crypto.randomUUID(), id: '' };
            pending.current = undefined;
            setDetail(undefined);
            setQuestion('');
            setMessage('');
          }}
        >
          新建对话
        </button>
        <div className="article-list">
          {list.map((c) => (
            <button disabled={busy} key={c.id} onClick={() => void act(() => open(c.id))}>
              {c.title}
              <small>{new Date(c.updatedAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
        <button disabled={busy || !offset} onClick={() => setOffset(offset - 50)}>
          上一页
        </button>
        <button disabled={busy || next === null} onClick={() => setOffset(next!)}>
          下一页
        </button>
      </section>
      <section className="panel knowledge-reader">
        <h2>{detail?.conversation.title ?? '开始新的知识问答'}</h2>
        <p className="muted-text">
          历史内容是当时的显示文本，不代表当前业务状态，也不会恢复或重试业务操作。查询与办理请使用对应服务入口。
        </p>
        {detail?.messages.map((m) => (
          <article className="case-message" key={m.id}>
            <b>
              {m.role === 'user' ? '你' : '助手'} · {new Date(m.createdAt).toLocaleString()}
            </b>
            <p className="answer-text">{m.body}</p>
            {m.references.map((r, i) => (
              <p key={i} className="muted-text">
                历史 {r.kind} 引用 · {r.id} · {new Date(r.observedAt).toLocaleString()}（读取时需重新授权）
              </p>
            ))}
          </article>
        ))}
        {detail?.nextAfter != null && (
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const page = await client.getConversation(detail.conversation.id, detail.nextAfter!);
                setDetail({ ...page, messages: [...detail.messages, ...page.messages] });
              })
            }
          >
            加载后续消息
          </button>
        )}
        {detail?.cases.map((c) => (
          <p key={c.id}>
            已关联工单：{c.title} · {c.id}（在“我的问题”查看最新进展）
          </p>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(ask);
          }}
        >
          <label>
            知识问题
            <textarea
              required
              minLength={2}
              maxLength={1000}
              disabled={busy || !!pending.current}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <button disabled={busy || !question.trim()}>
            {busy ? '正在处理…' : pending.current ? '重试保存或回答' : '提问并保存'}
          </button>
        </form>
        {message && <p role="status">{message}</p>}
        {detail && !confirmDelete && (
          <button disabled={busy} onClick={() => setConfirmDelete(true)}>
            删除此段对话
          </button>
        )}
        {detail && confirmDelete && (
          <div className="experience-alert">
            <p>这会移除此段对话正文；已经上报的工单继续保留。</p>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await client.deleteConversation(detail.conversation.id);
                  setDetail(undefined);
                  creation.current = { key: crypto.randomUUID(), id: '' };
                  pending.current = undefined;
                  setConfirmDelete(false);
                  await refresh();
                  setMessage('对话已删除。');
                })
              }
            >
              确认删除对话正文
            </button>
            <button disabled={busy} onClick={() => setConfirmDelete(false)}>
              取消
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
