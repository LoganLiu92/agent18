import { z } from 'zod';
import { evidenceSchema, type Evidence, type Scope } from '@agent18/contracts';
import { ProviderError, type ProviderContext, type ProviderManifest } from './index.js';
export const toolDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    version: z.number().int().positive(),
    review: z.enum(['approved', 'pending', 'revoked']),
    capability: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    provider: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    effect: z.enum(['READ', 'WRITE']),
    stage: z.enum(['READ', 'PROPOSE', 'EXECUTE']),
    audience: z.enum(['CUSTOMER', 'ENGINEERING']),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    resourceTypes: z.array(z.string().min(1).max(80)).min(1).max(20),
    environmentPolicy: z.array(z.string().min(1).max(64)).min(1).max(20),
  })
  .strict();
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;
export type TransportKind = 'native' | 'http' | 'openapi' | 'mcp';
export type ToolBinding = {
  descriptor: ToolDescriptor;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType<Evidence[]>;
  invoke: (input: unknown, context: ProviderContext) => Promise<Evidence[]>;
};
export type RegisteredProvider = {
  manifest: ProviderManifest;
  transport: TransportKind;
  tools: ToolBinding[];
  visible?: (scope: Scope, evidence: Evidence[]) => Promise<Evidence[]>;
};
/** Transport discovery is untrusted. Candidates must be reviewed and bound before invocation. */
export interface ToolTransport {
  kind: TransportKind;
  discover(
    context: ProviderContext,
  ): Promise<{ name: string; inputSchema: unknown; outputSchema: unknown }[]>;
  call(name: string, input: unknown, context: ProviderContext): Promise<unknown>;
}
export const evidenceBatchSchema = z.array(evidenceSchema).max(50);
export const knowledgeInputSchema = z
  .object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(5) })
  .strict();
export const environments = ['development', 'staging', 'production'];
export function builtInTool(
  id: string,
  provider: string,
  capability: string,
  stage: ToolDescriptor['stage'],
  resource: string,
): ToolDescriptor {
  return {
    id,
    version: 1,
    review: 'approved',
    capability,
    provider,
    effect: stage === 'EXECUTE' ? 'WRITE' : 'READ',
    stage,
    audience: 'CUSTOMER',
    risk: stage === 'EXECUTE' ? 'MEDIUM' : 'LOW',
    resourceTypes: [resource],
    environmentPolicy: [...environments],
  };
}
export const builtInTools = [
  builtInTool('knowledge.search', 'knowledge', 'knowledge.search', 'READ', 'knowledge'),
  builtInTool('business.query', 'saas-api', 'business.inspect', 'READ', 'business'),
  builtInTool('business.prepare', 'saas-bridge', 'business.propose', 'PROPOSE', 'business'),
  builtInTool('business.execute', 'saas-bridge', 'business.execute', 'EXECUTE', 'business'),
];
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const bindingSchemas = (binding: ToolBinding) => ({
  input: z.toJSONSchema(binding.inputSchema),
  output: z.toJSONSchema(binding.outputSchema),
});
export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  register(provider: RegisteredProvider) {
    const { manifest } = provider;
    if (this.providers.has(manifest.id)) throw new ProviderError('DUPLICATE_REGISTRATION');
    const ids = new Set<string>();
    for (const binding of provider.tools) {
      toolDescriptorSchema.parse(binding.descriptor);
      if (
        binding.descriptor.provider !== manifest.id ||
        !manifest.capabilities.includes(binding.descriptor.capability) ||
        ids.has(binding.descriptor.id)
      )
        throw new ProviderError('INVALID_REGISTRATION');
      ids.add(binding.descriptor.id);
    }
    // Snapshot descriptors and schemas; later mutation cannot change the installed binding.
    this.providers.set(manifest.id, {
      ...provider,
      manifest: structuredClone(manifest),
      tools: provider.tools.map((b) => ({ ...b, descriptor: structuredClone(b.descriptor) })),
    });
  }
  get(id: string) {
    return this.providers.get(id);
  }
  list() {
    return [...this.providers.values()].map((p) => ({
      manifest: structuredClone(p.manifest),
      transport: p.transport,
    }));
  }
}
export function validateEvidence(raw: unknown, scope: Scope, tool: ToolDescriptor): Evidence[] {
  const result = evidenceBatchSchema.safeParse(raw);
  if (!result.success) throw new ProviderError('INVALID_SCOPE');
  for (const e of result.data) {
    if (
      canonical(e.scope) !==
        canonical({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          tenantId: scope.tenantId,
          subject: scope.subject,
        }) ||
      e.provenance.providerId !== tool.provider ||
      e.provenance.toolId !== tool.id ||
      e.provenance.toolVersion !== tool.version ||
      !tool.resourceTypes.includes(e.resource.type)
    )
      throw new ProviderError('INVALID_SCOPE');
    if (
      tool.audience === 'CUSTOMER' &&
      (!['PUBLIC', 'TENANT'].includes(e.visibility) || e.sensitivity === 'RESTRICTED')
    )
      throw new ProviderError('INVALID_SCOPE');
    if (
      e.kind === 'knowledge' &&
      (!e.citation || e.source !== e.citation.source || e.observedAt !== e.citation.observedAt)
    )
      throw new ProviderError('INVALID_SCOPE');
    if (e.kind !== 'knowledge' && e.citation) throw new ProviderError('INVALID_SCOPE');
  }
  return result.data;
}
