import { expect, it } from 'vitest';
import { sourceSchema } from '@agent18/knowledge';
import { buildProvenance, evidenceReference } from '../../packages/knowledge/src/provenance.js';
import { hash, chunkFiles } from '../../packages/knowledge/src/scan.js';

it('records source snapshots and generation identity without claiming a deployment or retaining credentials', () => {
  const text = '# Orders\nSubmitted orders cannot be edited.';
  const files = [{ path: 'rules.md', content: text, sha: hash(text) }];
  const source = sourceSchema.parse({
    id: 'orders-code',
    name: 'Orders',
    kind: 'git',
    location: 'https://code.example/orders.git',
  });
  const input = {
    sourceId: 'source-one',
    source,
    snapshot: { revision: 'a'.repeat(40), fingerprint: hash(text), files, skipped: [], bytes: text.length },
    runId: 'generation-one',
    observedAt: '2026-09-18T00:00:00.000Z',
    mode: 'model' as const,
    prompt: 'Generate grounded docs',
    model: {
      identity: 'model-config-hash',
      name: 'configured-model',
      complete: async () => ({ value: {}, tokens: 0 }),
    },
  };
  const p = buildProvenance(input);
  expect(p.source.commit).toBe('a'.repeat(40));
  expect(p.generation).toMatchObject({
    runId: input.runId,
    model: { name: 'configured-model', identity: 'model-config-hash' },
  });
  expect(p.snapshot.files).toEqual([{ path: 'rules.md', contentHash: hash(text) }]);
  expect(p.deployment).toEqual({ status: 'unknown', revision: null, environment: null, release: null });
  expect(JSON.stringify(p)).not.toContain('https://');
  const chunk = chunkFiles(files)[0]!;
  const ref = evidenceReference(p, chunk);
  expect(ref).toMatchObject({
    sourceId: 'source-one',
    snapshotId: p.snapshot.id,
    path: 'rules.md',
    startLine: 1,
    endLine: 2,
    revision: 'a'.repeat(40),
    observedAt: input.observedAt,
  });
  const next = buildProvenance({ ...input, runId: 'generation-two', observedAt: '2026-09-19T00:00:00.000Z' });
  expect(next.snapshot.id).toBe(p.snapshot.id);
  expect(evidenceReference(next, chunk).id).toBe(ref.id);
  expect(buildProvenance({ ...input, sourceId: 'another-source' }).snapshot.id).not.toBe(p.snapshot.id);
  const directory = buildProvenance({
    ...input,
    source: { ...source, kind: 'directory' },
    mode: 'extractive',
  });
  expect(directory.source.commit).toBeNull();
  expect(directory.generation.model).toBeNull();
  expect(directory.generation.promptHash).toBeNull();
});
