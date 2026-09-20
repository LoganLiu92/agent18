import { z } from 'zod';
const service = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{1,79}$/),
  environment = z.enum(['production', 'staging', 'development']);
export const deploymentSchema = z
  .object({
    eventId: z.string().uuid(),
    service,
    environment,
    sourceId: z.string().uuid(),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    deployedAt: z
      .string()
      .datetime()
      .refine((v) => Date.parse(v) <= Date.now() + 60000),
    evidenceUrl: z
      .string()
      .url()
      .max(1000)
      .refine((v) => {
        const u = new URL(v);
        return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
      }),
    note: z.string().trim().min(5).max(500),
  })
  .strict();
export const deploymentFeedSchema = z
  .object({
    pipeline: service,
    credentialEnv: z.string().regex(/^AGENT18_DEPLOY_[A-Z0-9_]{1,60}$/),
    bindings: z
      .array(z.object({ service, environment, sourceId: z.string().uuid() }).strict())
      .min(1)
      .max(100),
  })
  .strict();
