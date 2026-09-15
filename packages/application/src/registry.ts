import { createHash } from 'node:crypto';
import { AppError } from '@agent18/domain';
import type { Database } from '@agent18/persistence';
import {
  toolDescriptorSchema,
  canonical,
  bindingSchemas,
  builtInTools,
  type ProviderRegistry,
  type ToolBinding,
  type ToolDescriptor,
} from '@agent18/provider-contracts';
/** Runtime has SELECT only. Installation/review is an owner operation, never a discovery side effect. */
export class ToolRegistry {
  constructor(
    private readonly db: Database,
    private readonly providers?: ProviderRegistry,
  ) {}
  async resolve(id: string): Promise<{ tool: ToolDescriptor; binding?: ToolBinding; fingerprint: string }> {
    const row = (
      await this.db.query(
        'SELECT t.*,p.review AS provider_review,p.version AS provider_version,p.transport AS provider_transport,p.capabilities AS provider_capabilities FROM control.tools t JOIN control.providers p ON p.id=t.provider WHERE t.id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new AppError('TOOL_NOT_REGISTERED', 403);
    const parsed = toolDescriptorSchema.safeParse({
      id: row.id,
      version: row.version,
      review: row.review,
      provider: row.provider,
      capability: row.capability,
      effect: row.effect,
      stage: row.stage,
      audience: row.audience,
      risk: row.risk,
      resourceTypes: row.resource_types,
      environmentPolicy: row.environment_policy,
    });
    if (!parsed.success || row.provider_review !== 'approved' || parsed.data.review !== 'approved')
      throw new AppError('TOOL_NOT_APPROVED', 403);
    const tool = parsed.data;
    const provider = this.providers?.get(tool.provider);
    const binding = provider?.tools.find((b) => b.descriptor.id === id);
    const expected = binding?.descriptor ?? builtInTools.find((t) => t.id === id);
    if (!expected || canonical(tool) !== canonical({ ...expected, review: tool.review }))
      throw new AppError('TOOL_BINDING_CHANGED', 403);
    if (
      binding &&
      (provider!.manifest.version !== row.provider_version ||
        provider!.transport !== row.provider_transport ||
        canonical(bindingSchemas(binding)) !== canonical(row.schemas) ||
        canonical(provider!.manifest.capabilities) !== canonical(row.provider_capabilities))
    )
      throw new AppError('TOOL_BINDING_CHANGED', 403);
    return {
      tool,
      binding,
      fingerprint: createHash('sha256')
        .update(
          canonical({
            tool,
            providerVersion: row.provider_version,
            transport: row.provider_transport,
            schemas: row.schemas,
          }),
        )
        .digest('hex'),
    };
  }
}
