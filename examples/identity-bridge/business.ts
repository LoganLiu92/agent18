import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

// A small SaaS-owned example: only the signed-in user's own preferences may be changed.
// It owns its data and authorization. Agent18 never receives this database's credentials.
export function registerDemoBusiness(app: FastifyInstance, databaseFile: string, jwks: JSONWebKeySet) {
  const db = new DatabaseSync(databaseFile);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS preferences(scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts(scope TEXT NOT NULL, id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,id));`);
  const keys = createLocalJWKSet(jwks);
  app.addHook('onClose', async () => db.close());
  app.post('/agent18/bridge', async (request, reply) => {
    let scope: string;
    try {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      if (!request.headers.authorization?.startsWith('Bearer ') || !token) throw new Error();
      const { payload } = await jwtVerify(token, keys, {
        issuer: 'urn:agent18:demo-saas',
        audience: 'agent18:support',
        algorithms: ['EdDSA'],
        requiredClaims: ['sub', 'tenant_id', 'project_key', 'iat', 'exp'],
        maxTokenAge: '10m',
      });
      if (
        payload.kind !== 'customer' ||
        payload.project_key !== 'invoice-demo' ||
        typeof payload.sub !== 'string' ||
        !['tenant-a', 'tenant-b'].includes(String(payload.tenant_id)) ||
        !Array.isArray(payload.roles) ||
        !payload.roles.includes('tenant-admin') ||
        Number(payload.exp) - Number(payload.iat) > 600
      )
        throw new Error();
      scope = JSON.stringify([payload.project_key, payload.tenant_id, payload.sub]);
    } catch {
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    const input = z
      .object({
        phase: z.enum(['prepare', 'execute', 'status']),
        actionId: z.literal('profile.notifications.update'),
        idempotencyKey: z.string().uuid(),
        arguments: z.object({ emailNotifications: z.boolean() }).strict().optional(),
        preview: z
          .object({ summary: z.string().max(2000), revision: z.string().max(200) })
          .strict()
          .optional(),
      })
      .strict()
      .parse(request.body);
    const previous = db
      .prepare('SELECT request_hash,result FROM receipts WHERE scope=? AND id=?')
      .get(scope, input.idempotencyKey) as { request_hash: string; result: string } | undefined;
    if (input.phase === 'status')
      return previous
        ? JSON.parse(previous.result)
        : { status: 'not_found', message: '尚无业务回执。可能请求仍在途中，请稍后再次查询。' };
    if (!input.arguments) return reply.code(400).send({ error: 'ARGUMENTS_REQUIRED' });
    const summary = `将你自己的邮件通知偏好设为“${input.arguments.emailNotifications ? '开启' : '关闭'}”。此示例只保存偏好，不发送邮件。`;
    const current = () =>
      db.prepare('SELECT enabled,revision FROM preferences WHERE scope=?').get(scope) as
        { enabled: number; revision: number } | undefined;
    if (input.phase === 'prepare') return { summary, revision: String(current()?.revision ?? 0) };
    const hash = createHash('sha256')
      .update(JSON.stringify([input.actionId, input.arguments, input.preview]))
      .digest('hex');
    if (previous)
      return previous.request_hash === hash
        ? JSON.parse(previous.result)
        : reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
    if (!input.preview || input.preview.summary !== summary)
      return reply.code(400).send({ error: 'PREVIEW_REQUIRED' });
    db.exec('BEGIN IMMEDIATE');
    try {
      const revision = current()?.revision ?? 0;
      let result;
      if (String(revision) !== input.preview.revision)
        result = { status: 'rejected', message: '偏好已被其他操作修改，请重新生成预览。' };
      else {
        db.prepare(
          'INSERT INTO preferences(scope,enabled,revision) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision',
        ).run(scope, Number(input.arguments.emailNotifications), revision + 1);
        result = {
          status: 'succeeded',
          message: `已保存你自己的通知偏好：${input.arguments.emailNotifications ? '开启' : '关闭'}。`,
          receiptId: input.idempotencyKey,
        };
      }
      db.prepare('INSERT INTO receipts(scope,id,request_hash,result) VALUES(?,?,?,?)').run(
        scope,
        input.idempotencyKey,
        hash,
        JSON.stringify(result),
      );
      db.exec('COMMIT');
      return result;
    } catch {
      db.exec('ROLLBACK');
      return reply.code(503).send({ error: 'BUSINESS_UNAVAILABLE' });
    }
  });
}
