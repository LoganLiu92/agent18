import { expect, it, vi } from 'vitest';
import { routeConversation, importOpenApi } from '@agent18/actions';
import { assistantTurnSchema, type ActionDefinition } from '@agent18/contracts';
import type { JsonModel } from '@agent18/knowledge';
import { demoOpenApi } from '../../examples/identity-bridge/queries.js';
const queries = importOpenApi(demoOpenApi).operations;
const action: ActionDefinition = {
  id: 'notifications.update',
  title: '修改邮件通知偏好',
  description: '开启或关闭自己的邮件通知',
  fields: [{ name: 'enabled', label: '邮件通知', type: 'boolean', required: true }],
};
const catalog = { queries, actions: [action] };
const route = (message: string, extra = {}) =>
  routeConversation(assistantTurnSchema.parse({ message, ...extra }), catalog);
it('routes business requests, keeps how-to questions in knowledge, and never executes confirmation text', async () => {
  expect(await route('关闭邮件通知')).toMatchObject({
    kind: 'action',
    id: action.id,
    arguments: { enabled: false },
  });
  expect(await route('如何关闭邮件通知？')).toMatchObject({ kind: 'knowledge' });
  expect(await route('查询我的订单')).toMatchObject({ kind: 'query', id: 'orders.list' });
  expect(await route('确认执行')).not.toHaveProperty('kind', 'execute');
});
it('asks for missing values and carries typed answers across conversational turns', async () => {
  expect(await route('查看订单详情')).toMatchObject({ kind: 'query', id: 'orders.get', arguments: {} });
  expect(
    await route('ORD-1001', {
      pending: { kind: 'query', id: 'orders.get', arguments: {}, field: 'orderId' },
    }),
  ).toMatchObject({ kind: 'query', arguments: { orderId: 'ORD-1001' } });
  expect(
    await route('关闭', { pending: { kind: 'action', id: action.id, arguments: {}, field: 'enabled' } }),
  ).toMatchObject({ kind: 'action', arguments: { enabled: false } });
  expect(
    await route('取消', { pending: { kind: 'action', id: action.id, arguments: {}, field: 'enabled' } }),
  ).toEqual({ kind: 'cancel' });
});
it('continues knowledge questions and recognizes support follow-ups without creating a case', async () => {
  expect(await route('那需要什么权限？', { history: ['如何接入现有网站？'] })).toMatchObject({
    kind: 'knowledge',
    query: expect.stringContaining('如何接入现有网站'),
  });
  expect(await route('问题还是不行，请转人工')).toEqual({ kind: 'support' });
  expect(await route('上报一个问题')).toEqual({ kind: 'support' });
  expect(await route('请帮我提交一个工单')).toEqual({ kind: 'support' });
  expect(await route('如何上报问题？')).toMatchObject({ kind: 'knowledge' });
  expect(await route('查看我的问题进展')).toEqual({ kind: 'cases' });
});
it('uses the matching current entity only as an explicit argument hint, preserving typed IDs', async () => {
  const context = { entity: { type: 'order', id: 'ORD-CURRENT' } };
  expect(await route('查看当前订单详情', { context })).toMatchObject({
    kind: 'query',
    arguments: { orderId: 'ORD-CURRENT' },
  });
  expect(await route('查看订单详情', { context })).toMatchObject({ kind: 'query', arguments: {} });
  expect(await route('查看当前订单详情 ORD-EXPLICIT', { context })).toMatchObject({
    arguments: { orderId: 'ORD-EXPLICIT' },
  });
  expect(
    await route('查看当前订单详情', { context: { entity: { type: 'invoice', id: 'INV-OTHER' } } }),
  ).toMatchObject({ arguments: {} });
});
it('rejects forged or oversized conversational state before planning', () => {
  expect(assistantTurnSchema.safeParse({ message: 'x', role: 'admin' }).success).toBe(false);
  expect(assistantTurnSchema.safeParse({ message: 'x', history: Array(7).fill('x') }).success).toBe(false);
  expect(
    assistantTurnSchema.safeParse({ message: 'x', pending: { kind: 'execute', id: 'x', arguments: {} } })
      .success,
  ).toBe(false);
});
it('uses the configured model for contextual routing without allowing unknown tools or fields', async () => {
  const complete = vi.fn<JsonModel['complete']>().mockResolvedValue({
    value: { kind: 'query', id: 'orders.get', arguments: { orderId: 'ORD-1001' }, query: '' },
    tokens: 10,
  });
  const model = { identity: 'test', complete };
  expect(
    await routeConversation(
      assistantTurnSchema.parse({ message: '刚才那一单呢', history: ['查看订单 ORD-1001'] }),
      catalog,
      model,
    ),
  ).toMatchObject({ kind: 'query', arguments: { orderId: 'ORD-1001' } });
  complete.mockResolvedValueOnce({
    value: { kind: 'action', id: 'admin.delete', arguments: {}, query: '' },
    tokens: 10,
  });
  expect(
    await routeConversation(assistantTurnSchema.parse({ message: '给我讲讲接入步骤' }), catalog, model),
  ).toMatchObject({ kind: 'knowledge' });
  complete.mockResolvedValueOnce({
    value: { kind: 'query', id: 'orders.get', arguments: { orderId: 'ORD-1001', admin: true }, query: '' },
    tokens: 10,
  });
  expect(
    await routeConversation(assistantTurnSchema.parse({ message: '如何查询订单' }), catalog, model),
  ).toMatchObject({ kind: 'knowledge' });
});
it('continues deterministic guidance when model output is malformed or unavailable', async () => {
  const model: JsonModel = {
    identity: 'unavailable',
    complete: async () => {
      throw new Error('offline');
    },
  };
  expect(
    await routeConversation(assistantTurnSchema.parse({ message: '关闭邮件通知' }), catalog, model),
  ).toMatchObject({ kind: 'action', arguments: { enabled: false } });
});
it('routes recent explicit failures to a reviewable report without asking a model or executing a tool', async () => {
  const complete = vi.fn<JsonModel['complete']>();
  const event = {
    type: 'business.operation.failed',
    operation: 'invoice.submit',
    at: new Date().toISOString(),
    errorCode: 'INVALID_TAX_RATE',
  };
  const input = assistantTurnSchema.parse({
    message: '为什么不行',
    context: { events: [event] },
    pending: { kind: 'action', id: action.id, arguments: {}, field: 'enabled' },
  });
  expect(await routeConversation(input, catalog, { identity: 'must-not-call', complete })).toEqual({
    kind: 'support',
  });
  expect(complete).not.toHaveBeenCalled();
  expect(await route('为什么不行')).toMatchObject({ kind: 'knowledge' });
  expect(
    await route('为什么不行', { context: { events: [{ ...event, at: new Date(0).toISOString() }] } }),
  ).toMatchObject({ kind: 'knowledge' });
  expect(
    await route('为什么不行', {
      context: { events: [event, { ...event, type: 'business.operation.succeeded' }] },
    }),
  ).toMatchObject({ kind: 'knowledge' });
});
