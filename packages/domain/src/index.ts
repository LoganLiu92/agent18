import type { Scope } from '@agent18/contracts';

export type CustomerPrincipal = Scope & { kind: 'customer'; roles: readonly string[]; expiresAt: number };
export type OperatorPrincipal = {
  kind: 'operator';
  organizationId: string;
  subject: string;
  permissions: readonly string[];
};
export type WorkloadPrincipal = { kind: 'workload'; subject: string; allowedJobs: readonly string[] };
export type Principal = CustomerPrincipal | OperatorPrincipal | WorkloadPrincipal;
export type Tool = {
  id: string;
  version: number;
  review: 'approved' | 'pending' | 'revoked';
  effect: 'READ' | 'WRITE';
  stage: 'READ' | 'PROPOSE' | 'EXECUTE';
  audience: 'CUSTOMER' | 'ENGINEERING';
  provider: string;
};
export type Capability = {
  id: string;
  toolId: string;
  toolVersion: number;
  expiresAt: number;
  scope: Scope;
  caseId: string;
  revision: number;
};
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
  }
}
export function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.projectId === b.projectId &&
    a.tenantId === b.tenantId &&
    a.subject === b.subject
  );
}
export function requireCustomer(principal: Principal): asserts principal is CustomerPrincipal {
  if (principal.kind !== 'customer') throw new AppError('UNAUTHORIZED', 403);
}
