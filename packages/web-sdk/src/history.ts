import type { ConversationReference } from '@agent18/contracts';
import type { Agent18 } from './index.js';
/** Display transcripts are untrusted text; restored turns never resume tools or approvals. */
export function conversationHistory(
  client: Agent18,
  ui: {
    clear: () => void;
    show: (text: string, role: 'user' | 'assistant', references: ConversationReference[]) => void;
    status: (text: string) => void;
    alive: () => boolean;
  },
) {
  let current: string | undefined,
    suppressed = false;
  let queue: {
    role: 'user' | 'assistant';
    body: string;
    key: string;
    references: ConversationReference[];
  }[] = [];
  let createKey = crypto.randomUUID(),
    createTitle = '助手对话';
  let flight: Promise<void> | undefined;
  async function flush(): Promise<void> {
    if (flight) return flight;
    flight = (async () => {
      while (queue.length && ui.alive()) {
        const item = queue[0]!;
        if (!current) current = (await client.createConversation(createTitle, createKey)).conversation.id;
        await client.addConversationMessage(current, item.role, item.body, item.key, item.references);
        queue.shift();
      }
      if (ui.alive()) ui.status('对话已保存');
    })();
    try {
      await flight;
    } finally {
      flight = undefined;
    }
  }
  function push(body: string, role: 'user' | 'assistant', references: ConversationReference[] = []) {
    if (suppressed || !body || !ui.alive()) return;
    if (!current && !queue.length) createTitle = role === 'user' ? body.slice(0, 120) : '助手对话';
    queue.push({ body: body.slice(0, 8000), role, key: crypto.randomUUID(), references });
    void flush().catch(() => {
      if (ui.alive()) ui.status('部分消息未保存，请点击重试保存。');
    });
  }
  async function open(id: string) {
    await flush();
    // Fetch before clearing: failed identity or network checks preserve the current display.
    const messages: { body: string; role: 'user' | 'assistant'; references: ConversationReference[] }[] = [];
    let after = 0;
    do {
      const page = await client.getConversation(id, after);
      messages.push(...page.messages);
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    } while (messages.length <= 500);
    if (!ui.alive()) return;
    suppressed = true;
    try {
      ui.clear();
      for (const m of messages) ui.show(m.body, m.role, m.references ?? []);
      current = id;
    } finally {
      suppressed = false;
    }
    ui.status('历史记录已恢复；引用是当时的线索，读取与办理仍需当前授权。');
  }
  async function fresh() {
    try {
      await flush();
    } catch (e) {
      if (e instanceof Error && e.message === 'CONVERSATION_LIMIT') {
        current = undefined;
        createKey = crypto.randomUUID();
        await flush();
      } else throw e;
    }
    current = undefined;
    createKey = crypto.randomUUID();
    ui.clear();
    ui.status('新对话将在发送消息后保存。');
  }
  async function remove() {
    await flush();
    if (current) await client.deleteConversation(current);
    current = undefined;
    createKey = crypto.randomUUID();
    ui.clear();
    ui.status('对话正文已删除；已上报的工单继续保留。');
  }
  return {
    push,
    flush,
    open,
    fresh,
    remove,
    list: (offset = 0) => client.listConversations(offset),
    current: () => current,
  };
}
