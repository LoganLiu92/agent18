import { it, expect } from 'vitest';
import { detectRuleConflicts } from '@agent18/knowledge';
it('detects explicit same-key same-unit disagreement but never equates units or evaluates expressions', () => {
  const records = [
    {
      kind: 'document' as const,
      id: 'a',
      version: '1',
      body: 'Maximum upload size = 20 MB\nTIMEOUT = 10 seconds\nAmount = 1 USD',
    },
    {
      kind: 'source' as const,
      id: 'b',
      version: 'abc',
      body: 'const MAX_UPLOAD_SIZE = 10 MB;\nTIMEOUT = 10000 ms\nAmount = 2 EUR',
    },
  ];
  const found = detectRuleConflicts(records);
  expect(found).toHaveLength(1);
  expect(found[0]!.ruleKey).toBe('max_upload_size (MB)');
  expect(found[0]!.claims.map((c) => c.version)).toEqual(['1', 'abc']);
  expect(
    detectRuleConflicts([
      { ...records[0]!, body: 'Limit = 10 * 1024' },
      { ...records[1]!, body: 'Limit = 20 * 1024' },
    ]),
  ).toEqual([]);
});
