import type { SourceConfig } from './config.js';
import type { Snapshot, Chunk } from './scan.js';
import { hash } from './scan.js';
import type { JsonModel } from './model.js';

/** Runtime provenance is recorded before generation. Source revision never implies deployment. */
export function buildProvenance(input: {
  sourceId: string;
  source: SourceConfig;
  snapshot: Snapshot;
  runId: string;
  observedAt: string;
  mode: 'extractive' | 'model';
  prompt: string;
  model?: JsonModel;
}) {
  const { sourceId, source, snapshot, runId, observedAt, mode, prompt, model } = input;
  const snapshotId = hash(JSON.stringify([sourceId, snapshot.revision, snapshot.fingerprint]));
  return {
    schemaVersion: 1 as const,
    source: {
      id: sourceId,
      key: source.id,
      kind: source.kind,
      revision: snapshot.revision,
      commit: source.kind === 'git' ? snapshot.revision : null,
    },
    snapshot: {
      id: snapshotId,
      fingerprint: snapshot.fingerprint,
      observedAt,
      files: snapshot.files.map((file) => ({ path: file.path, contentHash: file.sha })),
    },
    generation: {
      runId,
      mode,
      promptHash: mode === 'model' ? hash(prompt) : null,
      model: mode === 'model' && model ? { identity: model.identity, name: model.name ?? null } : null,
    },
    deployment: { status: 'unknown' as const, revision: null, environment: null, release: null },
  };
}
export function evidenceReference(provenance: ReturnType<typeof buildProvenance>, chunk: Chunk) {
  const contentHash = hash(chunk.text);
  return {
    id: hash(
      JSON.stringify([provenance.snapshot.id, chunk.path, chunk.startLine, chunk.endLine, contentHash]),
    ),
    sourceId: provenance.source.id,
    snapshotId: provenance.snapshot.id,
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    revision: provenance.source.revision,
    contentHash,
    observedAt: provenance.snapshot.observedAt,
  };
}
