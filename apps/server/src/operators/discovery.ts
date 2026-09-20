import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import { canonical } from '@agent18/provider-contracts';
import { containsSecret } from '@agent18/knowledge';
import type { KnowledgeOperation } from './sources.js';
const snapshots = z
  .array(z.string().uuid())
  .min(1)
  .max(5)
  .refine((v) => new Set(v).size === v.length);
async function discover(c: PoolClient, ids: string[]) {
  const builds = (
    await c.query(
      "SELECT b.id,s.name,s.source_key FROM knowledge.builds b JOIN knowledge.sources s ON s.id=b.source_id WHERE b.id=ANY($1::uuid[]) AND b.state='ready' AND s.enabled",
      [ids],
    )
  ).rows;
  if (builds.length !== ids.length) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
  const rows = (
    await c.query(
      'SELECT e.id,e.snapshot_id,e.path,e.start_line,e.end_line,a.title,a.category FROM knowledge.source_evidence e JOIN knowledge.articles a ON a.id=e.article_id WHERE e.snapshot_id=ANY($1::uuid[]) ORDER BY e.path,e.start_line,e.id LIMIT 2001',
      [ids],
    )
  ).rows;
  const groups = new Map<
    string,
    {
      key: string;
      domain: string;
      title: string;
      paths: string[];
      categories: string[];
      evidenceIds: string[];
      totalEvidence: number;
    }
  >();
  for (const row of rows.slice(0, 2000)) {
    const parts = String(row.path).split('/'),
      root = parts[0]!,
      domain = (
        ['src', 'apps', 'packages', 'services', 'docs'].includes(root) && parts.length > 2
          ? parts[1]
          : parts.length > 1
            ? root
            : (builds.find((b) => b.id === row.snapshot_id)?.source_key ?? 'project')
      ).slice(0, 100);
    if (containsSecret(domain)) continue;
    const key = createHash('sha256')
      .update(canonical({ ids: [...ids].sort(), domain }))
      .digest('hex');
    const group = groups.get(key) ?? {
      key,
      domain,
      title: domain.length < 2 ? domain + ' area' : domain,
      paths: [] as string[],
      categories: [] as string[],
      evidenceIds: [] as string[],
      totalEvidence: 0,
    };
    group.totalEvidence++;
    if (group.evidenceIds.length < 30) group.evidenceIds.push(row.id);
    if (group.paths.length < 8 && !group.paths.includes(row.path)) group.paths.push(row.path);
    if (!group.categories.includes(row.category)) group.categories.push(row.category);
    groups.set(key, group);
  }
  return {
    method: 'repository-path-groups-v1',
    builds,
    candidates: [...groups.values()].slice(0, 40),
    truncated: rows.length > 2000 || groups.size > 40,
  };
}
export function registerDiscovery(app: FastifyInstance, run: KnowledgeOperation) {
  const base = '/operator/projects/:key/knowledge/topics';
  app.get(base + '/discovery/snapshots', (req) =>
    run(req, 'source.read', async (c) => ({
      snapshots: (
        await c.query(
          "SELECT b.id,b.revision,b.created_at,s.name FROM knowledge.builds b JOIN knowledge.sources s ON s.id=b.source_id WHERE b.state='ready' AND s.enabled AND b.mode IN('extractive','model') ORDER BY b.created_at DESC LIMIT 100",
        )
      ).rows,
    })),
  );
  app.post(base + '/discover', (req) => {
    const { snapshotIds } = z.object({ snapshotIds: snapshots }).strict().parse(req.body);
    return run(req, 'source.read', (c) => discover(c, snapshotIds));
  });
  app.post(base + '/candidates', (req) => {
    const input = z
      .object({
        snapshotIds: snapshots,
        key: z.string().regex(/^[a-f0-9]{64}$/),
        title: z.string().trim().min(2).max(200),
        domain: z.string().trim().min(1).max(100),
      })
      .strict()
      .parse(req.body);
    if (containsSecret(input.title + ' ' + input.domain))
      throw new AppError('KNOWLEDGE_SECRET_DETECTED', 400);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const candidate = (await discover(c, input.snapshotIds)).candidates.find((g) => g.key === input.key);
      if (!candidate) throw new AppError('KNOWLEDGE_DISCOVERY_CHANGED', 409);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,183101))', [
        scope.join(':') + input.key,
      ]);
      const existing = (
        await c.query('SELECT id,title,domain FROM knowledge.topics WHERE discovery_key=$1', [input.key])
      ).rows[0];
      if (existing) {
        if (existing.title !== input.title || existing.domain !== input.domain)
          throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return { id: existing.id, replayed: true };
      }
      const id = randomUUID();
      await c.query(
        "INSERT INTO knowledge.topics(id,organization_id,project_id,domain,title,description,state,required_categories,updated_by,discovery_key) VALUES($1,$2,$3,$4,$5,'由已固定来源的文件分组识别，业务范围与依据尚待人工确认。','candidate',$6,$7,$8)",
        [
          id,
          ...scope,
          input.domain,
          input.title,
          candidate.categories.length ? candidate.categories : ['overview'],
          actor.account.id,
          input.key,
        ],
      );
      for (const evidence of candidate.evidenceIds)
        await c.query(
          "INSERT INTO knowledge.topic_evidence(topic_id,evidence_id,organization_id,project_id,relation,note,confirmed,linked_by) VALUES($1,$2,$3,$4,'context','自动映射的上下文候选，需核对。',false,$5)",
          [id, evidence, ...scope, actor.account.id],
        );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'knowledge.topic.discover',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id, replayed: false };
    });
  });
  app.post(base + '/:id/merge', (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params),
      input = z
        .object({
          version: z.number().int().positive(),
          targetId: z.string().uuid(),
          targetVersion: z.number().int().positive(),
          reason: z.string().trim().min(5).max(500),
        })
        .strict()
        .parse(req.body);
    if (id === input.targetId || containsSecret(input.reason))
      throw new AppError('KNOWLEDGE_MERGE_INVALID', 400);
    return run(req, 'knowledge.edit', async (c, scope, actor) => {
      const rows = (
          await c.query('SELECT * FROM knowledge.topics WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
            [id, input.targetId],
          ])
        ).rows,
        source = rows.find((r) => r.id === id),
        target = rows.find((r) => r.id === input.targetId);
      if (!source || !target) throw new AppError('KNOWLEDGE_NOT_FOUND', 404);
      if (source.version !== input.version || target.version !== input.targetVersion)
        throw new AppError('KNOWLEDGE_VERSION_CONFLICT', 409);
      if (source.merged_into || target.merged_into || target.state === 'excluded')
        throw new AppError('KNOWLEDGE_MERGE_INVALID', 409);
      await c.query(
        'INSERT INTO knowledge.topic_documents(topic_id,document_id,organization_id,project_id,linked_by) SELECT $2,document_id,organization_id,project_id,$3 FROM knowledge.topic_documents WHERE topic_id=$1 ON CONFLICT DO NOTHING',
        [id, input.targetId, actor.account.id],
      );
      // Preserve differing evidence relationships on the archived source; merged copies require review.
      await c.query(
        "INSERT INTO knowledge.topic_evidence(topic_id,evidence_id,organization_id,project_id,relation,note,confirmed,linked_by) SELECT $2,evidence_id,organization_id,project_id,'context',$4,false,$3 FROM knowledge.topic_evidence WHERE topic_id=$1 ON CONFLICT DO NOTHING",
        [id, input.targetId, actor.account.id, '合并主题待复核：' + input.reason],
      );
      await c.query(
        "UPDATE knowledge.topics SET state='excluded',merged_into=$2,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1",
        [id, input.targetId, actor.account.id],
      );
      await c.query(
        "UPDATE knowledge.topics SET state='candidate',required_categories=$2,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1",
        [
          input.targetId,
          [...new Set([...source.required_categories, ...target.required_categories])],
          actor.account.id,
        ],
      );
      await c.query(
        "INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,'knowledge.topic.merge',$3,$4)",
        [randomUUID(), actor.account.id, id, req.id],
      );
      return { id: input.targetId, scope };
    });
  });
}
