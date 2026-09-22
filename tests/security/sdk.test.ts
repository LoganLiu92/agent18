import { expect, it, vi } from 'vitest';
import { Agent18 } from '@agent18/web-sdk';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('drops URL queries, fragments, unrelated fields and all implicit browser credentials', async () => {
  const request = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) =>
    Response.json({ case: { id: 'case-1' }, replayed: false }),
  );
  const sdk = new Agent18({
    baseUrl: 'http://agent18',
    projectKey: 'public-key',
    getToken: async () => 'short-lived-token',
    fetch: request,
  });
  sdk.setContext({
    pageUrl: 'https://saas.example/invoices?api_key=do-not-collect#secret',
    entityType: 'invoice',
  });
  await sdk.reportCase({ title: 'Invoice failed', description: 'Submission failed' }, crypto.randomUUID());
  const options = request.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(options?.credentials).toBe('omit');
  expect(JSON.parse(options?.body as string).context).toEqual({
    pagePath: '/invoices',
    entityType: 'invoice',
  });
  sdk.destroy();
  await expect(sdk.listCases()).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});

it('does not send a late token after logout destroys the client', async () => {
  const token = deferred<string>();
  const request = vi.fn(async () => Response.json({ cases: [] }));
  const sdk = new Agent18({
    baseUrl: 'http://agent18',
    projectKey: 'public-key',
    getToken: () => token.promise,
    fetch: request,
  });
  const pending = sdk.listCases();
  sdk.destroy();
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  token.resolve('previous-user-token');
  await rejected;
  expect(request).not.toHaveBeenCalled();
});

it('does not return a previous user response when a custom transport ignores cancellation', async () => {
  const response = deferred<Response>();
  const request = vi.fn(() => response.promise);
  const sdk = new Agent18({
    baseUrl: 'http://agent18',
    projectKey: 'public-key',
    getToken: async () => 'previous-user-token',
    fetch: request,
  });
  const pending = sdk.listCases();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  sdk.destroy();
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  response.resolve(Response.json({ cases: [{ id: 'previous-user-case' }] }));
  await rejected;
});
