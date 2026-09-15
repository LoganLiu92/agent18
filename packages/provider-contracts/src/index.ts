import { z } from 'zod';
import { citationSchema, type Scope, type Citation, type SafeCitation } from '@agent18/contracts';

export type ProviderErrorCode =
  | 'UNSUPPORTED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'INVALID_SCOPE'
  | 'NOT_FOUND'
  | 'PARTIAL';
export class ProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode) {
    super(code);
  }
}
export type ProviderContext = { scope: Scope; signal: AbortSignal; requestId: string };
export type ProviderManifest = {
  id: string;
  version: string;
  capabilities: readonly string[];
  mode: 'fixture' | 'live';
};
export interface Provider {
  manifest: ProviderManifest;
}
export interface KnowledgeProvider extends Provider {
  visible?(scope: Scope, citations: SafeCitation[]): Promise<SafeCitation[]>;
  search(input: { query: string; limit: number }, context: ProviderContext): Promise<Citation[]>;
}
export interface BusinessToolProvider extends Provider {
  invoke(
    input: { reviewedOperationId: string; arguments: Readonly<Record<string, unknown>> },
    context: ProviderContext,
  ): Promise<unknown>;
}
export interface McpProvider extends Provider {
  discover(context: ProviderContext): Promise<{ name: string; schema: unknown }[]>;
  call(
    input: { registeredToolId: string; arguments: Readonly<Record<string, unknown>> },
    context: ProviderContext,
  ): Promise<unknown>;
}
export interface ObservabilityProvider extends Provider {
  query(
    input: { serviceId: string; traceId?: string; from: string; to: string; limit: number },
    context: ProviderContext,
  ): Promise<{ records: unknown[]; observedAt: string; truncated: boolean }>;
}
export interface SourceProvider extends Provider {
  read(
    input: { repositoryId: string; commit: string; path: string },
    context: ProviderContext,
  ): Promise<{ content: string; commit: string; observedAt: string }>;
}
export interface CodingProvider extends Provider {
  propose(
    input: { repositoryId: string; baseCommit: string; evidenceIds: string[]; sandboxId: string },
    context: ProviderContext,
  ): Promise<{ artifactId: string; baseCommit: string; testArtifactIds: string[] }>;
}

// Validate a complete batch before releasing any record. Providers cannot redefine the caller's scope.
export function validateCitations(raw: unknown, scope: Scope): Citation[] {
  const parsed = z.array(citationSchema).max(5).safeParse(raw);
  if (!parsed.success) throw new ProviderError('INVALID_SCOPE');
  for (const item of parsed.data) {
    if (
      item.scope.organizationId !== scope.organizationId ||
      item.scope.projectId !== scope.projectId ||
      item.scope.tenantId !== scope.tenantId ||
      !['PUBLIC', 'TENANT'].includes(item.visibility)
    )
      throw new ProviderError('INVALID_SCOPE');
    if (
      !item.source.startsWith('fixture://') &&
      !/^knowledge:\/\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(item.source)
    )
      throw new ProviderError('INVALID_SCOPE');
  }
  return parsed.data;
}
export function assertCapability(provider: Provider, name: string): void {
  if (!provider.manifest.capabilities.includes(name)) throw new ProviderError('UNSUPPORTED');
}
