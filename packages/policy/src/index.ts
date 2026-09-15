import { z } from 'zod';
import type { Scope } from '@agent18/contracts';
import type { Tool } from '@agent18/domain';
export type PolicyInput = {
  principal: { kind: string; scope: Scope; permissions?: readonly string[] };
  action: Tool;
  resource: { type: string; scope: Scope; visibility: 'PUBLIC' | 'TENANT' | 'INTERNAL' | 'ENGINEERING' };
  context: {
    scopeValid: boolean;
    capabilityValid: boolean;
    registered: boolean;
    environment: string;
    phase: 'support' | 'case';
    caseId?: string;
    userConfirmed: boolean;
    approval?: { id: string; valid: boolean }; // Only a trusted approval verifier may set valid.
  };
};
export const policyDecisionSchema = z
  .object({
    decision: z.enum(['ALLOW', 'DENY', 'APPROVAL_REQUIRED']),
    reason: z.string().regex(/^[A-Z_]{1,80}$/),
  })
  .strict();
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export class OpaPolicy {
  constructor(
    private readonly url: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async decide(input: PolicyInput): Promise<PolicyDecision> {
    try {
      const response = await this.request(`${this.url}/v1/data/agent18/gateway/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return { decision: 'DENY', reason: 'POLICY_UNAVAILABLE' };
      const body = z.object({ result: policyDecisionSchema }).safeParse(await response.json());
      return body.success ? body.data.result : { decision: 'DENY', reason: 'POLICY_INVALID_RESPONSE' };
    } catch {
      return { decision: 'DENY', reason: 'POLICY_UNAVAILABLE' };
    }
  }
}
