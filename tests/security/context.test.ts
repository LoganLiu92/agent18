import { expect, it, vi } from 'vitest';
import { Agent18 } from '@agent18/web-sdk';
import { contextSchema, type BusinessEvent } from '@agent18/contracts';
import { latestFailure, contextEventTtlMs } from '@agent18/contracts/context';
import { entityKey, sameEntity, isEntityIdentity } from '@agent18/contracts/entity';

const failed = {
  type: 'business.operation.failed',
  operation: 'order.save',
  errorCode: 'ORDER_TIMEOUT',
  traceId: 'a'.repeat(32),
} as const;
it('preserves namespace throughout SDK snapshots and never merges same-ID entities from different domains', async () => {
  const request = vi.fn(async () => Response.json({}));
  const sdk = new Agent18({
    baseUrl: 'https://support.example',
    projectKey: 'saas',
    getToken: async () => 'synthetic',
    fetch: request,
    capture: { enabled: false },
  });
  const sales = { namespace: 'sales', type: 'order', id: '1001' },
    purchase = { ...sales, namespace: 'purchase' };
  try {
    sdk.setContext({ entity: sales });
    sdk.emit(failed);
    const snapshot = sdk.getContext();
    expect(snapshot.events?.[0]?.entity).toEqual(sales);
    expect(contextSchema.parse(snapshot).events?.[0]?.entity).toEqual(sales);
    sdk.emit({ type: 'business.operation.succeeded', operation: failed.operation, entity: purchase });
    expect(latestFailure(sdk.getContext())?.entity).toEqual(sales);
    sdk.emit({ ...failed, entity: purchase });
    expect(latestFailure(sdk.getContext())?.entity).toEqual(sales);
    sdk.emit({ type: 'business.operation.succeeded', operation: failed.operation, entity: sales });
    expect(latestFailure(sdk.getContext())).toBeUndefined();
    await sdk.reportCase(
      { title: 'Namespace report', description: 'Frozen namespace evidence', context: snapshot },
      crypto.randomUUID(),
    );
    expect(
      JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).context
        .events[0].entity,
    ).toEqual(sales);
    sdk.setContext({ entity: purchase });
    expect(sdk.getContext().events).toBeUndefined();
    sdk.emit(failed);
    const mutable = sdk.getContext();
    mutable.events![0]!.entity!.namespace = 'other';
    expect(sdk.getContext().events?.[0]?.entity?.namespace).toBe('purchase');
  } finally {
    sdk.destroy();
  }
});
it('keeps legacy identities distinct, avoids delimiter collisions and rejects invalid namespace hints', () => {
  const legacy = { type: 'order', id: '1' },
    namespaced = { ...legacy, namespace: 'sales' };
  expect(sameEntity(legacy, namespaced)).toBe(false);
  expect(sameEntity(legacy, { ...legacy })).toBe(true);
  expect(sameEntity(undefined, undefined)).toBe(true);
  expect(entityKey({ type: 'a', id: 'b/c' })).not.toBe(entityKey({ namespace: 'a', type: 'b', id: 'c' }));
  const sdk = new Agent18({
    baseUrl: '',
    projectKey: 'saas',
    getToken: async () => '',
    capture: { enabled: false },
  });
  try {
    for (const namespace of ['', 5, {}, 'tenant/forged', 'x'.repeat(81)]) {
      const entity = { ...legacy, namespace };
      expect(isEntityIdentity(entity)).toBe(false);
      expect(() => sdk.emit({ ...failed, entity } as never)).toThrow('CONTEXT_EVENT_INVALID');
      expect(contextSchema.safeParse({ entity }).success).toBe(false);
    }
    const event = { ...failed, entity: legacy, at: new Date().toISOString() };
    expect(latestFailure({ entity: namespaced, events: [event] })).toBeUndefined();
    expect(latestFailure({ entity: legacy, events: [event] })?.entity).toEqual(legacy);
  } finally {
    sdk.destroy();
  }
});
it('buffers bounded semantic hints without network calls, then snapshots a stable report', async () => {
  const request = vi.fn(async () => Response.json({}));
  const sdk = new Agent18({
    baseUrl: 'https://support.example',
    projectKey: 'saas',
    getToken: async () => 'synthetic',
    fetch: request,
    capture: { enabled: false },
  });
  sdk.setContext({
    pageUrl: '/orders?secret=ignored',
    route: 'order-detail',
    entity: { type: 'order', id: 'ORD-1' },
  });
  sdk.emit(failed);
  expect(request).not.toHaveBeenCalled();
  const snapshot = sdk.getContext();
  expect(contextSchema.safeParse(snapshot).success).toBe(true);
  expect(snapshot.events?.[0]?.entity).toEqual({ type: 'order', id: 'ORD-1' });
  expect(latestFailure(snapshot)?.traceId).toBe(failed.traceId);
  sdk.setContext({ pageUrl: '/other', entity: { type: 'order', id: 'ORD-2' } });
  expect(sdk.getContext().events).toBeUndefined();
  await sdk.reportCase(
    { title: 'Order failure', description: 'A frozen report preview', context: snapshot },
    crypto.randomUUID(),
  );
  expect(
    JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).context,
  ).toEqual(snapshot);
  await sdk.reportCase(
    { title: 'Order failure', description: 'No context consent', context: {} },
    crypto.randomUUID(),
  );
  expect(
    JSON.parse((request.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).context,
  ).toEqual({});
  sdk.destroy();
  expect(() => sdk.emit(failed)).toThrow();
  expect(() => sdk.getContext()).toThrow();
});
it('expires events, removes resolved failures, bounds history and detaches mutable caller objects', () => {
  vi.useFakeTimers();
  const sdk = new Agent18({
    baseUrl: '',
    projectKey: 'saas',
    getToken: async () => 'unused',
    capture: { enabled: false },
  });
  try {
    sdk.setContext({ entity: { type: 'order', id: 'ORD-1' } });
    const mutable = { ...failed, entity: { type: 'order', id: 'ORD-1' } };
    sdk.emit(mutable);
    mutable.entity.id = 'FORGED';
    expect(latestFailure(sdk.getContext())?.entity?.id).toBe('ORD-1');
    sdk.emit({ type: 'business.operation.succeeded', operation: 'order.save' });
    expect(latestFailure(sdk.getContext())).toBeUndefined();
    for (let i = 0; i < 8; i++) sdk.emit({ ...failed, operation: 'order.read' + i });
    expect(sdk.getContext().events).toHaveLength(5);
    vi.advanceTimersByTime(contextEventTtlMs + 1);
    expect(sdk.getContext().events).toBeUndefined();
    sdk.emit(failed);
    sdk.clearContext();
    expect(sdk.getContext()).toEqual({});
  } finally {
    sdk.destroy();
    vi.useRealTimers();
  }
});
it('rejects arbitrary payloads, ignores stale/future events and never takes identity from context', () => {
  const sdk = new Agent18({
    baseUrl: '',
    projectKey: 'saas',
    getToken: async () => 'unused',
    capture: { enabled: false },
  });
  try {
    for (const extra of [
      { token: 'private' },
      { type: 'execute' },
      { operation: 'https://arbitrary.example' },
      { errorCode: 'password=private' },
      { entity: { type: 'order', id: 'one', tenantId: 'other' } },
    ])
      expect(() => sdk.emit({ ...failed, ...extra } as never)).toThrow();
    const event: BusinessEvent = { ...failed, at: new Date().toISOString() };
    expect(contextSchema.safeParse({ events: [{ ...event, tenantId: 'other' }] }).success).toBe(false);
    for (const at of [new Date(0).toISOString(), new Date(Date.now() + 60000).toISOString()])
      expect(latestFailure({ events: [{ ...event, at }] })).toBeUndefined();
    expect(
      latestFailure({
        entity: { type: 'order', id: 'new' },
        events: [{ ...event, entity: { type: 'order', id: 'old' } }],
      }),
    ).toBeUndefined();
  } finally {
    sdk.destroy();
  }
});
