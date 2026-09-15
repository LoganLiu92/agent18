import type { Scope } from '@agent18/contracts';
import type { Tool } from '@agent18/domain';
export type PolicyInput = {
  principal: { kind: string; scope: Scope };
  tool: Tool;
  scope: Scope;
  scopeValid: boolean;
  capabilityValid: boolean;
  phase: 'support' | 'case';
  now: number;
  actionRegistered?: boolean;
  userConfirmed?: boolean;
};
export type PolicyDecision = { allow: boolean; reason: string };
export class OpaPolicy {
  constructor(
    private readonly url: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async decide(input: PolicyInput): Promise<PolicyDecision> {
    try {
      const response = await this.request(`${this.url}/v1/data/agent18/gateway/allow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return { allow: false, reason: 'POLICY_UNAVAILABLE' };
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('result' in body) || typeof body.result !== 'boolean')
        return { allow: false, reason: 'POLICY_INVALID_RESPONSE' };
      return {
        allow: body.result,
        reason: body.result
          ? input.tool.id === 'business.delegate'
            ? 'DELEGATION_APPROVED'
            : 'READ_APPROVED'
          : 'POLICY_DENIED',
      };
    } catch {
      return { allow: false, reason: 'POLICY_UNAVAILABLE' };
    }
  }
}
