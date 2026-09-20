import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  hash,
  validateGenerationInput,
  validateGenerationOutput,
  type TopicGenerationInput,
} from '@agent18/knowledge';
function fixture(): TopicGenerationInput {
  const body = 'Fixed source text. Submission requires an exchange rate.';
  return {
    topic: {
      id: randomUUID(),
      version: 1,
      title: 'Exchange rate',
      domain: 'Invoice',
      description: 'Evidence review',
    },
    categories: ['overview', 'workflows'],
    evidence: [
      {
        id: randomUUID(),
        snapshotId: randomUUID(),
        sourceId: randomUUID(),
        path: 'guide.md',
        startLine: 1,
        endLine: 1,
        revision: 'fixed-commit',
        contentHash: hash(body),
        body,
        relation: 'supports',
        note: 'Reviewed source',
      },
    ],
  };
}
function output(input: TopicGenerationInput) {
  return {
    articles: [
      {
        title: 'Exchange rate guide',
        body: 'Before submitting an invoice, configure the exchange rate.',
        category: 'overview',
        evidenceIds: [input.evidence[0]!.id],
      },
    ],
    gaps: ['No production deployment evidence.'],
  };
}
describe('topic generation bounds and provenance', () => {
  it('accepts fixed evidence and an unpublished partial result with explicit gaps', () => {
    const input = validateGenerationInput(fixture());
    expect(validateGenerationOutput(output(input), input).articles).toHaveLength(1);
  });
  it('rejects modified source text even if supplied metadata looks valid', () => {
    const input = fixture();
    input.evidence[0]!.body += ' modified';
    expect(() => validateGenerationInput(input)).toThrow('KNOWLEDGE_EVIDENCE_HASH_MISMATCH');
  });
  it('rejects excessive input before model invocation', () => {
    const input = fixture();
    input.evidence = Array.from({ length: 6 }, () => ({
      ...input.evidence[0]!,
      id: randomUUID(),
      body: 'a'.repeat(19000),
      contentHash: hash('a'.repeat(19000)),
    }));
    expect(() => validateGenerationInput(input)).toThrow('GENERATION_INPUT_TOO_LARGE');
  });
  it('rejects forged and duplicate references, extra categories, and repeated layers', () => {
    const input = fixture(),
      good = output(input);
    for (const articles of [
      [{ ...good.articles[0]!, evidenceIds: [randomUUID()] }],
      [{ ...good.articles[0]!, evidenceIds: [input.evidence[0]!.id, input.evidence[0]!.id] }],
      [{ ...good.articles[0]!, category: 'api' }],
      [good.articles[0]!, good.articles[0]!],
    ])
      expect(() => validateGenerationOutput({ ...good, articles }, input)).toThrow(
        'GENERATION_REFERENCES_INVALID',
      );
  });
  it('rejects unexpected executable payloads and credentials in generated prose', () => {
    const input = fixture();
    expect(() => validateGenerationOutput({ ...output(input), execute: 'delete' }, input)).toThrow(
      'GENERATION_OUTPUT_INVALID',
    );
    const invalid = output(input);
    invalid.articles[0]!.body = 'API key: sk-' + 'a'.repeat(40);
    expect(() => validateGenerationOutput(invalid, input)).toThrow('KNOWLEDGE_SECRET_DETECTED');
  });
});
