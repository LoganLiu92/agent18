import { createLocalJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, type CustomerPrincipal } from '@agent18/domain';
import type { Config } from '../../../scripts/config.js';

const claimsSchema = z.object({
  sub: z.string().min(1).max(128),
  tenant_id: z.string().min(1).max(128),
  project_key: z.string().min(1),
  kind: z.literal('customer'),
  roles: z.array(z.string().max(50)).max(20).default([]),
  iat: z.number().int(),
  exp: z.number().int(),
  nbf: z.number().int().optional(),
});
export function customerVerifier(config: Config) {
  const projects = new Map(
    config.projects.map((project) => [project.key, { ...project, keySet: createLocalJWKSet(project.jwks) }]),
  );
  return async (request: FastifyRequest): Promise<CustomerPrincipal> => {
    const key = request.headers['x-project-key'];
    const header = request.headers.authorization;
    if (typeof key !== 'string' || !header?.startsWith('Bearer ') || header.length > 8192)
      throw new AppError('UNAUTHENTICATED', 401);
    const project = projects.get(key);
    if (!project) throw new AppError('UNAUTHENTICATED', 401);
    try {
      const { payload } = await jwtVerify(header.slice(7), project.keySet, {
        issuer: project.issuer,
        audience: project.audience,
        algorithms: ['EdDSA'],
        requiredClaims: ['sub', 'iat', 'exp', 'tenant_id', 'project_key', 'kind'],
        maxTokenAge: '10m',
        clockTolerance: 0,
      });
      const claims = claimsSchema.parse(payload);
      if (claims.project_key !== project.key || claims.exp <= claims.iat || claims.exp - claims.iat > 600)
        throw new Error('Invalid token lifetime or project');
      return {
        kind: 'customer',
        organizationId: project.organizationId,
        projectId: project.projectId,
        tenantId: claims.tenant_id,
        subject: claims.sub,
        roles: claims.roles,
        expiresAt: claims.exp * 1000,
      };
    } catch {
      throw new AppError('UNAUTHENTICATED', 401);
    }
  };
}
export function verifyWorkload(request: FastifyRequest, token: string) {
  const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  if (
    !request.headers.authorization?.startsWith('Bearer ') ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new AppError('UNAUTHENTICATED_WORKLOAD', 401);
}
