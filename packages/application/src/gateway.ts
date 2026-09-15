import { type Scope, type SearchResult, type SafeCitation, type Evidence } from '@agent18/contracts';
import { AppError, sameScope, type Capability, type CustomerPrincipal } from '@agent18/domain';
import { audit, type Database } from '@agent18/persistence';
import { OpaPolicy } from '@agent18/policy';
import { ProviderRegistry, validateEvidence, type KnowledgeProvider } from '@agent18/provider-contracts';
import { ToolRegistry } from './registry.js';
import { knowledgeBinding } from './knowledge-binding.js';
export type GatewayPrincipal =
  | CustomerPrincipal
  | (Scope & {
      kind: 'operator';
      permissions: readonly string[];
      expiresAt: number;
    });
export class ToolGateway {
  readonly registry: ToolRegistry;
  readonly providers: ProviderRegistry;
  constructor(
    private readonly db: Database,
    private readonly policy: OpaPolicy,
    private readonly knowledge: KnowledgeProvider,
    providers?: ProviderRegistry,
    private readonly environment = 'production',
  ) {
    this.providers = providers ?? new ProviderRegistry();
    if (!this.providers.get('knowledge')) this.providers.register(knowledgeBinding(knowledge));
    this.registry = new ToolRegistry(db, this.providers);
  }
  visible(scope: Scope, citations: SafeCitation[]) {
    return this.knowledge.visible?.(scope, citations) ?? Promise.resolve(citations);
  }
  async visibleEvidence(scope: Scope, evidence: Evidence[]) {
    const result: Evidence[] = [];
    for (const e of evidence) {
      try {
        const { tool } = await this.registry.resolve(e.provenance.toolId);
        validateEvidence([e], scope, tool);
        const provider = this.providers.get(tool.provider);
        if (!provider?.visible) continue; // Revocation must be checked again when a Case is read.
        const visible = await provider.visible(scope, [e]);
        if (visible.some((v) => v.id === e.id)) result.push(e);
      } catch {
        /* Unknown, revoked, hidden or invalid evidence is not released. */
      }
    }
    return result;
  }
  async authorize(
    principal: GatewayPrincipal,
    requestId: string,
    capability?: Capability,
    toolId = capability?.toolId ?? 'knowledge.search',
  ) {
    const scope: Scope = {
      organizationId: principal.organizationId,
      projectId: principal.projectId,
      tenantId: principal.tenantId,
      subject: principal.subject,
    };
    const record = { caseId: capability?.caseId, requestId, action: toolId };
    let registered;
    try {
      registered = await this.registry.resolve(toolId);
    } catch (error) {
      await audit(this.db, scope, {
        ...record,
        decision: 'DENY',
        reason: error instanceof AppError ? error.code : 'REGISTRY_UNAVAILABLE',
      });
      throw error;
    }
    const { tool, fingerprint } = registered;
    const now = Date.now();
    const decision = await this.policy.decide({
      principal: {
        kind: principal.kind,
        scope,
        ...(principal.kind === 'operator' ? { permissions: principal.permissions } : {}),
      },
      action: tool,
      resource: {
        type: tool.resourceTypes[0]!,
        scope,
        visibility: tool.audience === 'CUSTOMER' ? 'TENANT' : 'ENGINEERING',
      },
      context: {
        scopeValid: principal.expiresAt > now,
        registered: true,
        environment: this.environment,
        phase: capability ? 'case' : 'support',
        caseId: capability?.caseId,
        userConfirmed: false,
        capabilityValid:
          !capability ||
          (capability.expiresAt > now &&
            sameScope(scope, capability.scope) &&
            capability.toolId === tool.id &&
            capability.toolVersion === tool.version &&
            capability.registryHash === fingerprint &&
            capability.revision === 1),
      },
    });
    await audit(this.db, scope, { ...record, decision: decision.decision, reason: decision.reason });
    if (decision.decision !== 'ALLOW')
      throw new AppError(
        decision.reason,
        decision.decision === 'APPROVAL_REQUIRED' ? 409 : decision.reason === 'POLICY_DENIED' ? 403 : 503,
        decision.reason,
        decision.decision,
      );
    return scope;
  }
  async invoke(
    principal: GatewayPrincipal,
    toolId: string,
    input: unknown,
    requestId: string,
    capability?: Capability,
    signal?: AbortSignal,
  ): Promise<Evidence[]> {
    const scope = await this.authorize(principal, requestId, capability, toolId);
    const record = { caseId: capability?.caseId, requestId, action: toolId };
    try {
      const { tool, binding } = await this.registry.resolve(toolId);
      // Generic runtime is read-only. Writes remain in the proposal/receipt executor with no retries.
      if (!binding || tool.effect !== 'READ' || tool.stage !== 'READ')
        throw new AppError('TOOL_NOT_EXECUTABLE', 403);
      const parameters = binding.inputSchema.safeParse(input);
      if (!parameters.success) throw new AppError('TOOL_INPUT_INVALID', 400);
      const providerSignal = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]);
      providerSignal.throwIfAborted();
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(
            providerSignal.reason instanceof AppError
              ? providerSignal.reason
              : new AppError('PROVIDER_TIMEOUT', 503),
          );
        providerSignal.addEventListener('abort', onAbort, { once: true });
      });
      let raw;
      try {
        raw = await Promise.race([
          binding.invoke(parameters.data, { scope, signal: providerSignal, requestId }),
          aborted,
        ]);
        providerSignal.throwIfAborted();
      } finally {
        providerSignal.removeEventListener('abort', onAbort);
      }
      const parsed = binding.outputSchema.safeParse(raw);
      if (!parsed.success) throw new AppError('PROVIDER_RESULT_REJECTED', 502);
      const evidence = validateEvidence(parsed.data, scope, tool);
      await this.registry.resolve(toolId); // Do not publish a result after in-flight revocation.
      await audit(this.db, scope, {
        ...record,
        decision: 'ALLOW',
        reason: evidence.length ? 'EVIDENCE_VALIDATED' : 'NO_MATCHING_SOURCE',
      });
      return evidence;
    } catch (error) {
      await audit(this.db, scope, {
        ...record,
        decision: 'DENY',
        reason: error instanceof AppError ? error.code : 'PROVIDER_RESULT_REJECTED',
      });
      if (error instanceof AppError) throw new AppError(error.code, error.status, error.message, 'ALLOW');
      throw new AppError('PROVIDER_RESULT_REJECTED', 502, 'PROVIDER_RESULT_REJECTED', 'ALLOW');
    }
  }
  async search(
    principal: CustomerPrincipal,
    query: string,
    requestId: string,
    capability?: Capability,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const evidence = await this.invoke(
      principal,
      'knowledge.search',
      { query, limit: 5 },
      requestId,
      capability,
      signal,
    );
    const citations = evidence.flatMap((e) => (e.citation ? [e.citation] : []));
    return {
      mode: 'retrieval_only',
      citations,
      notice: citations.some((c) => c.source.startsWith('knowledge://'))
        ? '已检索当前发布的知识版本；引用可追溯到源文件。'
        : '当前仅检索演示资料；未连接模型，不生成诊断或 AI 回答。',
    };
  }
}
