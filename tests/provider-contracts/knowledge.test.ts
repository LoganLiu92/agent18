import { describe, it, expect } from 'vitest';
import { validateCitations, assertCapability } from '@agent18/provider-contracts';
import { FixtureKnowledgeProvider } from '@agent18/knowledge-basic';
const scope = {
  organizationId: '00000000-0000-4000-8000-000000000018',
  projectId: '10000000-0000-4000-8000-000000000018',
  tenantId: 'tenant-a',
  subject: 'alice',
};
const provider = new FixtureKnowledgeProvider();
async function fixtures() {
  return provider.search(
    { query: '发票提交失败', limit: 5 },
    { scope, signal: AbortSignal.timeout(1000), requestId: 'contract-test' },
  );
}
describe('KnowledgeProvider conformance', () => {
  it('returns bounded, versioned, attributable fixtures', async () => {
    const result = validateCitations(await fixtures(), scope);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.version).toBe('1.0.0');
    expect(provider.manifest.mode).toBe('fixture');
  });
  it.each(['tenantId', 'projectId', 'organizationId'] as const)(
    'rejects provider attempts to cross %s',
    async (field) => {
      const results = await fixtures();
      results[0]!.scope[field] = field === 'tenantId' ? 'tenant-b' : '20000000-0000-4000-8000-000000000018';
      expect(() => validateCitations(results, scope)).toThrow('INVALID_SCOPE');
    },
  );
  it.each(['INTERNAL', 'ENGINEERING'] as const)(
    'rejects %s evidence in customer results',
    async (visibility) => {
      const results = await fixtures();
      results[0]!.visibility = visibility;
      expect(() => validateCitations(results, scope)).toThrow('INVALID_SCOPE');
    },
  );
  it('rejects unknown fields and unsafe source schemes', async () => {
    const results = await fixtures();
    expect(() => validateCitations([{ ...results[0], token: 'hidden' }], scope)).toThrow();
    results[0]!.source = 'javascript:alert(1)';
    expect(() => validateCitations(results, scope)).toThrow();
  });
  it('reports unsupported capabilities explicitly', () => {
    expect(() => assertCapability(provider, 'coding.propose')).toThrow('UNSUPPORTED');
  });
  it('returns no fabricated citation when there is no source', async () => {
    expect(
      await provider.search(
        { query: 'xylophone', limit: 5 },
        { scope, signal: AbortSignal.timeout(1000), requestId: 'none' },
      ),
    ).toEqual([]);
  });
});
