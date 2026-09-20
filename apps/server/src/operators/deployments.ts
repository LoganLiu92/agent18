import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deploymentSchema } from '@agent18/contracts';
import { canonical } from '@agent18/provider-contracts';
import { containsSecret } from '@agent18/knowledge';
import { AppError } from '@agent18/domain';
import type { SupportOperation } from './support.js';
export function registerDeployments(app: FastifyInstance, run: SupportOperation) {
  const base = '/operator/projects/:key/deployments';
  app.get(base, (req) =>
    run(req, 'operations.read', async (c, p, actor) => {
      const q = z
        .object({
          service: z.string().max(80).default(''),
          environment: z.enum(['production', 'staging', 'development']).default('production'),
          at: z
            .string()
            .datetime()
            .default(() => new Date().toISOString()),
        })
        .parse(req.query);
      const rows = (
        await c.query(
          "SELECT d.*,s.name AS source_name FROM control.deployment_records d JOIN knowledge.sources s ON s.id=d.source_id WHERE d.organization_id=$1 AND d.project_id=$2 AND d.environment=$3 AND ($4='' OR d.service=$4) AND d.deployed_at<=$5 ORDER BY d.deployed_at DESC,d.id LIMIT 100",
          [p.organizationId, p.projectId, q.environment, q.service, q.at],
        )
      ).rows;
      const seen = new Set<string>();
      return {
        canAttest: actor.account.administrator,
        at: q.at,
        records: rows.map((r) => {
          const active = !r.revoked_at && !seen.has(r.service);
          seen.add(r.service);
          return { ...r, activeAtTime: active };
        }),
        sources: (
          await c.query(
            "SELECT id,name FROM knowledge.sources WHERE organization_id=$1 AND project_id=$2 AND enabled AND EXISTS(SELECT 1 FROM knowledge.connections k WHERE k.organization_id=knowledge.sources.organization_id AND k.project_id=knowledge.sources.project_id AND k.source_key=knowledge.sources.source_key AND k.spec->>'kind'='git') ORDER BY name LIMIT 100",
            [p.organizationId, p.projectId],
          )
        ).rows,
      };
    }),
  );
  app.post(base, (req) => {
    const input = deploymentSchema.parse(req.body);
    if (containsSecret(JSON.stringify(input))) throw new AppError('DEPLOYMENT_SECRET_DETECTED', 400);
    return run(req, 'source.configure', async (c, p, actor) => {
      if (
        !(
          await c.query(
            "SELECT id FROM knowledge.sources WHERE id=$1 AND enabled AND EXISTS(SELECT 1 FROM knowledge.connections k WHERE k.organization_id=knowledge.sources.organization_id AND k.project_id=knowledge.sources.project_id AND k.source_key=knowledge.sources.source_key AND k.spec->>'kind'='git')",
            [input.sourceId],
          )
        ).rowCount
      )
        throw new AppError('DEPLOYMENT_SOURCE_REQUIRED', 400);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,183003))', [input.eventId]);
      const hash = createHash('sha256').update(canonical(input)).digest('hex'),
        previous = (
          await c.query('SELECT id,payload_hash FROM control.deployment_records WHERE id=$1', [input.eventId])
        ).rows[0];
      if (previous) {
        if (previous.payload_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return { id: previous.id, replayed: true };
      }
      await c.query(
        "INSERT INTO control.deployment_records(id,organization_id,project_id,service,environment,source_id,commit_hash,artifact_digest,deployed_at,evidence_url,note,attestation,actor_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'operator',$12,$13)",
        [
          input.eventId,
          p.organizationId,
          p.projectId,
          input.service,
          input.environment,
          input.sourceId,
          input.commit,
          input.artifactDigest,
          input.deployedAt,
          input.evidenceUrl,
          input.note,
          actor.account.id,
          hash,
        ],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'deployment.attest',$3,$4)",
        [randomUUID(), actor.account.id, input.eventId, req.id],
      );
      return { id: input.eventId, replayed: false };
    });
  });
  app.post(base + '/:id/revoke', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      { reason } = z
        .object({ reason: z.string().trim().min(5).max(500) })
        .strict()
        .parse(req.body);
    if (containsSecret(reason)) throw new AppError('DEPLOYMENT_SECRET_DETECTED', 400);
    return run(req, 'source.configure', async (c, _p, actor) => {
      if (
        !(
          await c.query(
            'UPDATE control.deployment_records SET revoked_at=coalesce(revoked_at,now()),revoke_reason=$2 WHERE id=$1 RETURNING id',
            [id, reason],
          )
        ).rowCount
      )
        throw new AppError('NOT_FOUND', 404);
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'deployment.revoke',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { revoked: true };
    });
  });
}
