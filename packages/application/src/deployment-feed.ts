import { createHash } from 'node:crypto';
import { z } from 'zod';
import { deploymentSchema, type deploymentFeedSchema } from '@agent18/contracts';
import { canonical } from '@agent18/provider-contracts';
import { containsSecret } from '@agent18/knowledge';
import type { Database } from '@agent18/persistence';
import { AppError } from '@agent18/domain';
import { verifySyncSignature } from './ticket-sync.js';
export async function receiveDeployment(
  db: Database,
  projects: {
    organizationId: string;
    projectId: string;
    deploymentFeed?: z.infer<typeof deploymentFeedSchema>;
  }[],
  raw: unknown,
  headers: { timestamp: string; signature: string; eventId: string },
  environment: Record<string, string | undefined> = process.env,
) {
  const envelope = z
      .object({
        organizationId: z.string().uuid(),
        projectId: z.string().uuid(),
        pipeline: z.string().max(80),
        deployment: deploymentSchema,
      })
      .strict()
      .parse(raw),
    project = projects.find(
      (p) => p.organizationId === envelope.organizationId && p.projectId === envelope.projectId,
    ),
    feed = project?.deploymentFeed,
    input = envelope.deployment;
  if (
    !feed ||
    feed.pipeline !== envelope.pipeline ||
    !feed.bindings.some(
      (b) =>
        b.service === input.service && b.environment === input.environment && b.sourceId === input.sourceId,
    )
  )
    throw new AppError('DEPLOYMENT_BINDING_DENIED', 403);
  const secret = environment[feed.credentialEnv];
  if (!secret || secret.length < 32) throw new AppError('DEPLOYMENT_CREDENTIAL_MISSING', 503);
  if (headers.eventId !== input.eventId) throw new AppError('SYNC_SIGNATURE_INVALID', 401);
  verifySyncSignature(secret, headers.timestamp, input.eventId, envelope, headers.signature);
  if (containsSecret(input.note)) throw new AppError('DEPLOYMENT_SECRET_DETECTED', 400);
  const c = await db.connect(),
    hash = createHash('sha256').update(canonical(input)).digest('hex');
  try {
    await c.query('BEGIN');
    await c.query(
      "SELECT set_config('agent18.organization_id',$1,true),set_config('agent18.project_id',$2,true),set_config('agent18.pipeline',$3,true)",
      [envelope.organizationId, envelope.projectId, feed.pipeline],
    );
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,183003))', [input.eventId]);
    const previous = (
      await c.query('SELECT id,payload_hash FROM control.deployment_records WHERE id=$1', [input.eventId])
    ).rows[0];
    if (previous) {
      if (previous.payload_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
      await c.query('COMMIT');
      return { id: input.eventId, replayed: true };
    }
    await c.query(
      "INSERT INTO control.deployment_records(id,organization_id,project_id,service,environment,source_id,commit_hash,artifact_digest,deployed_at,evidence_url,note,attestation,pipeline,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'signed_pipeline',$12,$13)",
      [
        input.eventId,
        envelope.organizationId,
        envelope.projectId,
        input.service,
        input.environment,
        input.sourceId,
        input.commit,
        input.artifactDigest,
        input.deployedAt,
        input.evidenceUrl,
        input.note,
        feed.pipeline,
        hash,
      ],
    );
    await c.query('COMMIT');
    return { id: input.eventId, replayed: false };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
