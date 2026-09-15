import { describe, it, expect, vi } from 'vitest';
import { OpaPolicy, type PolicyInput } from '@agent18/policy';
const input = {} as PolicyInput;
describe('OPA fail-closed boundary', () => {
  it.each([{}, { result: 'true' }, { result: 1 }, { result: { allow: true } }, { result: null }])(
    'rejects an undefined or malformed decision: %j',
    async (body) => {
      const request = vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
      expect(await new OpaPolicy('http://opa', request).decide(input)).toEqual({
        allow: false,
        reason: 'POLICY_INVALID_RESPONSE',
      });
    },
  );
  it('rejects unavailable policy', async () => {
    const request = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await new OpaPolicy('http://opa', request).decide(input)).allow).toBe(false);
  });
  it('does not accept a successful-looking body with a failing HTTP status', async () => {
    const request = vi.fn(async () =>
      Response.json({ result: true }, { status: 503 }),
    ) as unknown as typeof fetch;
    expect((await new OpaPolicy('http://opa', request).decide(input)).allow).toBe(false);
  });
});
