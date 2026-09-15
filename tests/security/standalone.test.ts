import { afterEach, expect, it, vi } from 'vitest';
import { openSupportPage } from '@agent18/web-sdk';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function browser(blocked = false) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const child = { closed: false, postMessage: vi.fn() };
  const window = {
    open: vi.fn((_url: string, _target: string) => (blocked ? null : child)),
    addEventListener: vi.fn((_type: string, fn: (event: MessageEvent) => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_type: string, fn: (event: MessageEvent) => void) => listeners.delete(fn)),
  };
  vi.stubGlobal('window', window);
  vi.stubGlobal('location', {
    origin: 'https://saas.example',
    href: 'https://saas.example/orders?secret=unrelated',
  });
  const dispatch = (data: unknown, origin = 'https://support.example', source: unknown = child) => {
    for (const listener of listeners) listener({ data, origin, source } as MessageEvent);
  };
  return { window, child, listeners, dispatch };
}
it('hands credentials only to the opened support page with the bound origin, channel and project', async () => {
  vi.useFakeTimers();
  const b = browser(),
    getToken = vi.fn(async () => 'current-short-lived-credential');
  const handle = openSupportPage({ baseUrl: 'https://support.example', projectKey: 'saas', getToken });
  const url = new URL(b.window.open.mock.calls[0]![0] as unknown as string);
  expect([...url.searchParams.keys()].sort()).toEqual(['channel', 'origin', 'project']);
  expect(url.href).not.toContain('secret');
  expect(getToken).not.toHaveBeenCalled();
  const request = {
    type: 'agent18:request-token',
    channel: url.searchParams.get('channel'),
    projectKey: 'saas',
    requestId: 'first',
  };
  b.dispatch(request, 'https://attacker.example');
  b.dispatch(request, 'https://support.example', {});
  b.dispatch({ ...request, channel: 'other' });
  b.dispatch({ ...request, projectKey: 'other' });
  await vi.advanceTimersByTimeAsync(1);
  expect(getToken).not.toHaveBeenCalled();
  b.dispatch(request);
  await vi.advanceTimersByTimeAsync(1);
  expect(b.child.postMessage).toHaveBeenCalledWith(
    {
      type: 'agent18:token',
      channel: request.channel,
      requestId: 'first',
      token: 'current-short-lived-credential',
    },
    'https://support.example',
  );
  b.dispatch({ ...request, requestId: 'refresh' });
  await vi.advanceTimersByTimeAsync(1);
  expect(getToken).toHaveBeenCalledTimes(2);
  handle.destroy();
  expect(b.listeners.size).toBe(0);
  b.dispatch(request);
  expect(getToken).toHaveBeenCalledTimes(2);
});
it('removes its listener when the popup is blocked, throws, or is closed', async () => {
  vi.useFakeTimers();
  const b = browser(true);
  const options = { baseUrl: 'https://support.example', projectKey: 'saas', getToken: async () => '' };
  expect(() => openSupportPage(options)).toThrow('POPUP_BLOCKED');
  expect(b.listeners.size).toBe(0);
  b.window.open.mockImplementationOnce(() => {
    throw new Error('browser refused');
  });
  expect(() => openSupportPage(options)).toThrow('browser refused');
  expect(b.listeners.size).toBe(0);
  const second = browser();
  openSupportPage(options);
  second.child.closed = true;
  await vi.advanceTimersByTimeAsync(1600);
  expect(second.listeners.size).toBe(0);
});
