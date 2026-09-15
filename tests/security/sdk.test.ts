import { expect, it, vi } from 'vitest';
import { Agent18 } from '@agent18/web-sdk';
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
