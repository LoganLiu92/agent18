import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { canonical } from '@agent18/provider-contracts';
import { containsSecret } from '@agent18/knowledge';
import { AppError } from '@agent18/domain';
import type { SupportOperation } from './support.js';
const kinds = ['identity', 'knowledge', 'query', 'action', 'observability', 'analytics'] as const;
const environment = z.enum(['production', 'staging', 'development']);
export function registerReadiness(app: FastifyInstance, run: SupportOperation) {
  const base = '/operator/projects/:key/integrations/readiness';
  app.get(base, (req) => {
    const input = z.object({ environment: environment.default('production') }).parse(req.query);
    return run(req, 'project.read', async (c, p) => {
      const configHash = createHash('sha256').update(canonical(p)).digest('hex');
      const records = (
        await c.query(
          'SELECT id,environment,kind,config_hash,status,note,evidence_ref,created_at FROM control.integration_checks WHERE environment=$1 ORDER BY created_at DESC,id DESC LIMIT 200',
          [input.environment],
        )
      ).rows;
      return {
        environment: input.environment,
        configHash,
        items: kinds.map((kind) => {
          const last = records.find((r) => r.kind === kind);
          return {
            kind,
            status: last ? (last.config_hash === configHash ? last.status : 'stale') : 'unverified',
            last: last ?? null,
          };
        }),
        history: records,
        method: 'operator-attestation',
      };
    });
  });
  app.post(base, (req) => {
    const input = z
      .object({
        environment,
        kind: z.enum(kinds),
        configHash: z.string().regex(/^[a-f0-9]{64}$/),
        status: z.enum(['passed', 'failed', 'not_applicable']),
        note: z.string().trim().min(10).max(2000),
        evidenceRef: z.string().trim().min(5).max(500),
      })
      .strict()
      .parse(req.body);
    if (containsSecret(JSON.stringify(input))) throw new AppError('INTEGRATION_SECRET_DETECTED', 400);
    return run(req, 'source.configure', async (c, p, actor) => {
      const hash = createHash('sha256').update(canonical(p)).digest('hex');
      if (hash !== input.configHash) throw new AppError('INTEGRATION_CONFIG_CHANGED', 409);
      const id = randomUUID();
      await c.query(
        'INSERT INTO control.integration_checks(id,organization_id,project_id,environment,kind,config_hash,status,note,evidence_ref,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          p.organizationId,
          p.projectId,
          input.environment,
          input.kind,
          hash,
          input.status,
          input.note,
          input.evidenceRef,
          actor.account.id,
        ],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'integration.acceptance.record',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id };
    });
  });
}
