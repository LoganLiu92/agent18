import { it, expect, vi } from 'vitest';
import { conversationHistory } from '../../packages/web-sdk/src/history.js';
import type { Agent18 } from '@agent18/web-sdk';
it('retries transcript writes with the same key and restores display without executing tools', async () => {
  const messages: { role: string; body: string; key: string }[] = [],
    show = vi.fn(),
    clear = vi.fn();
  let fail = true;
  const client = {
    createConversation: vi.fn(async () => ({ conversation: { id: 'conversation' } })),
    addConversationMessage: vi.fn(async (_id: string, role: string, body: string, key: string) => {
      if (fail) {
        fail = false;
        throw new Error('NETWORK');
      }
      messages.push({ role, body, key });
    }),
    getConversation: vi.fn(async () => ({
      messages: [{ role: 'assistant', body: 'Old action succeeded (display only)' }],
      nextAfter: null,
      cases: [],
    })),
    listConversations: vi.fn(),
    deleteConversation: vi.fn(),
    prepareAction: vi.fn(),
    confirmAction: vi.fn(),
  } as unknown as Agent18;
  const ui = { clear, show, status: vi.fn(), alive: () => true },
    history = conversationHistory(client, ui);
  history.push('Please help', 'user');
  await expect(history.flush()).rejects.toThrow('NETWORK');
  const originalKey = vi.mocked(client.addConversationMessage).mock.calls[0]![3];
  await history.flush();
  expect(messages[0]?.key).toBe(originalKey);
  expect(messages).toHaveLength(1);
  await history.open('conversation');
  expect(clear).toHaveBeenCalledOnce();
  expect(show).toHaveBeenCalledWith('Old action succeeded (display only)', 'assistant', []);
  expect(client.prepareAction).not.toHaveBeenCalled();
  expect(client.confirmAction).not.toHaveBeenCalled();
  expect(client.addConversationMessage).toHaveBeenCalledTimes(2);
});
