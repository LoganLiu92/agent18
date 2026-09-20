import { canonical } from '@agent18/provider-contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent18/domain';
import { containsSecret } from '@agent18/knowledge';
import { analyticsSelectionSchema } from '@agent18/contracts';
import { calculateAnalytics } from '../../../../packages/application/src/analytics.js';
import type { SupportOperation } from './support.js';
export function registerAnalytics(app: FastifyInstance, run: SupportOperation) {
  const base = '/operator/projects/:key/insights/analytics';
  app.get(base, (req) =>
    run(req, 'ticket.read', async (_c, p) => ({
      enabled: p.analytics?.enabled ?? false,
      playbooks: p.analytics?.enabled ? p.analytics.playbooks : [],
      metrics: p.analytics?.enabled
        ? p.analytics.metrics.map(({ definition, title, questions }) => ({ definition, title, questions }))
        : [],
    })),
  );
  // This planning operation never fetches business data. Ambiguous questions remain explicit choices.
  app.post(base + '/plan', (req) => {
    const { question } = z
      .object({ question: z.string().trim().min(2).max(500) })
      .strict()
      .parse(req.body);
    return run(req, 'ticket.read', async (_c, p) => ({
      question,
      candidates: (p.analytics?.enabled ? p.analytics.metrics : [])
        .map((m) => ({
          metricId: m.definition.id,
          title: m.title,
          score:
            m.questions.some((q) => question.toLowerCase().includes(q.toLowerCase())) ||
            question.includes(m.title)
              ? 1
              : 0,
          definition: m.definition,
        }))
        .sort((a, b) => b.score - a.score),
      requiresConfirmation: true,
    }));
  });
  const selection = analyticsSelectionSchema
    .extend({ title: z.string().trim().min(2).max(120).optional(), requestKey: z.string().uuid().optional() })
    .strict();
  app.post(base + '/query', async (req) => {
    const input = selection.parse(req.body);
    if (input.title && containsSecret(input.title)) throw new AppError('INSIGHT_SECRET_DETECTED', 400);
    if (Boolean(input.title) !== Boolean(input.requestKey))
      throw new AppError('INSIGHT_SAVE_INPUT_REQUIRED', 400);
    const parameters = analyticsSelectionSchema.parse({
      metricId: input.metricId,
      tenant: input.tenant,
      days: input.days,
      dimensions: input.dimensions,
    });
    const authorize = async (
      c: import('pg').PoolClient,
      p: { organizationId: string; projectId: string },
      actorId: string,
    ) => {
      if (
        !(
          await c.query('SELECT control.report_actor_allowed($1,$2,$3,false,$4) AS allowed', [
            actorId,
            p.organizationId,
            p.projectId,
            [input.tenant],
          ])
        ).rows[0].allowed
      )
        throw new AppError('INSIGHT_SCOPE_REQUIRED', 403);
    };
    const previous = async (c: import('pg').PoolClient) => {
      if (!input.requestKey) return undefined;
      const old = (
        await c.query('SELECT id,title,payload FROM control.insight_reports WHERE request_key=$1', [
          input.requestKey,
        ])
      ).rows[0];
      if (!old) return undefined;
      if (old.title !== input.title || canonical(old.payload.selection) !== canonical(parameters))
        throw new AppError('IDEMPOTENCY_CONFLICT', 409);
      return { id: old.id, report: old.payload, replayed: true };
    };
    // Reserve a durable per-account call budget, then release all permission locks before HTTP.
    const prepared = await run(req, 'ticket.read', async (c, p, actor) => {
      await authorize(c, p, actor.account.id);
      const replay = await previous(c);
      if (replay) return { p, replay };
      const used = +(
        await c.query(
          "SELECT count(*) FROM control.operator_audit WHERE actor_id=$1 AND action='analytics.request' AND created_at>now()-interval '1 minute'",
          [actor.account.id],
        )
      ).rows[0].count;
      if (used >= 10) throw new AppError('ANALYTICS_RATE_LIMITED', 429);
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), actor.account.id, 'analytics.request', p.projectId, req.id],
      );
      return { p, replay: undefined };
    });
    if (prepared.replay) return prepared.replay;
    const report = await calculateAnalytics(prepared.p.analytics, prepared.p, parameters);
    return run(req, 'ticket.read', async (c, p, actor) => {
      await authorize(c, p, actor.account.id);
      if (input.requestKey)
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,183004))', [
          actor.account.id + ':' + p.projectId + ':' + input.requestKey,
        ]);
      const replay = await previous(c);
      if (replay) return replay;
      const id = input.requestKey ? randomUUID() : null;
      if (id)
        await c.query(
          'INSERT INTO control.insight_reports(id,organization_id,project_id,operator_id,title,tenant_ids,all_tenants,definition_version,payload,request_key) VALUES($1,$2,$3,$4,$5,$6,false,$7,$8,$9)',
          [
            id,
            p.organizationId,
            p.projectId,
            actor.account.id,
            input.title,
            [input.tenant],
            report.definitionVersion,
            JSON.stringify(report),
            input.requestKey,
          ],
        );
      await c.query(
        'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
        [
          randomUUID(),
          actor.account.id,
          id ? 'analytics.save' : 'analytics.query',
          id ?? p.projectId,
          req.id,
        ],
      );
      return { id, report, replayed: false };
    });
  });
}
