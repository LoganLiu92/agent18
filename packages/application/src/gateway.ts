import { safeCitationSchema, type Scope, type SearchResult, type SafeCitation } from '@agent18/contracts';
import { AppError, sameScope, type Capability, type CustomerPrincipal, type Tool } from '@agent18/domain';
import { audit, type Database } from '@agent18/persistence';
import { OpaPolicy } from '@agent18/policy';
import { assertCapability, validateCitations, type KnowledgeProvider } from '@agent18/provider-contracts';

export class ToolGateway {
  constructor(
    private readonly db: Database,
    private readonly policy: OpaPolicy,
    private readonly knowledge: KnowledgeProvider,
  ) {}
  visible(scope: Scope, citations: SafeCitation[]) {
    return this.knowledge.visible?.(scope, citations) ?? Promise.resolve(citations);
  }
  async authorize(principal: CustomerPrincipal, requestId: string, capability?: Capability) {
    const scope: Scope = {
      organizationId: principal.organizationId,
      projectId: principal.projectId,
      tenantId: principal.tenantId,
      subject: principal.subject,
    };
    const record = { caseId: capability?.caseId, requestId, action: 'knowledge.search' };
    const row = (await this.db.query('SELECT * FROM control.tools WHERE id=$1', ['knowledge.search']))
      .rows[0];
    const tool: Tool = row ?? {
      id: 'knowledge.search',
      version: 0,
      review: 'pending',
      effect: 'READ',
      stage: 'READ',
      audience: 'CUSTOMER',
      provider: 'unavailable',
    };
    const now = Date.now();
    const decision = await this.policy.decide({
      principal: { kind: principal.kind, scope },
      scope,
      tool,
      phase: capability ? 'case' : 'support',
      now,
      scopeValid: principal.expiresAt > now,
      capabilityValid:
        !capability ||
        (capability.expiresAt > now &&
          sameScope(scope, capability.scope) &&
          capability.toolId === tool.id &&
          capability.toolVersion === tool.version &&
          capability.revision === 1),
    });
    // This commit must succeed before any adapter call; a failed audit never authorizes execution.
    await audit(this.db, scope, {
      ...record,
      decision: decision.allow ? 'ALLOW' : 'DENY',
      reason: decision.reason,
    });
    if (!decision.allow) throw new AppError(decision.reason, decision.reason === 'POLICY_DENIED' ? 403 : 503);
    return scope;
  }
  async search(
    principal: CustomerPrincipal,
    query: string,
    requestId: string,
    capability?: Capability,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = await this.authorize(principal, requestId, capability);
    const record = { caseId: capability?.caseId, requestId, action: 'knowledge.search' };
    try {
      assertCapability(this.knowledge, 'knowledge.search');
      const providerSignal = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]);
      providerSignal.throwIfAborted();
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
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
          this.knowledge.search({ query, limit: 5 }, { scope, signal: providerSignal, requestId }),
          aborted,
        ]);
        providerSignal.throwIfAborted();
      } finally {
        providerSignal.removeEventListener('abort', onAbort);
      }
      const citations = validateCitations(raw, scope).map(
        ({ scope: _scope, visibility: _visibility, ...safe }) => safeCitationSchema.parse(safe),
      );
      await audit(this.db, scope, {
        ...record,
        decision: 'ALLOW',
        reason: citations.length ? 'CITATIONS_VALIDATED' : 'NO_MATCHING_SOURCE',
      });
      return {
        mode: 'retrieval_only',
        citations,
        notice: citations.some((c) => c.source.startsWith('knowledge://'))
          ? '已检索当前发布的知识版本；引用可追溯到源文件。'
          : '当前仅检索演示资料；未连接模型，不生成诊断或 AI 回答。',
      };
    } catch (error) {
      await audit(this.db, scope, {
        ...record,
        decision: 'DENY',
        reason: error instanceof AppError ? error.code : 'PROVIDER_RESULT_REJECTED',
      });
      if (error instanceof AppError) throw error;
      throw new AppError('PROVIDER_RESULT_REJECTED', 502);
    }
  }
}
