import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export const demoOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Aurora SaaS API', version: '1.0.0' },
  components: {
    securitySchemes: { currentUser: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Order: {
        type: 'object',
        properties: {
          id: { type: 'string', title: '订单编号' },
          customer: { type: 'string', title: '客户' },
          amount: { type: 'number', title: '金额' },
          status: { type: 'string', title: '状态' },
          internalMemo: { type: 'string', writeOnly: true },
        },
      },
    },
  },
  security: [{ currentUser: [] }],
  paths: {
    '/api/orders': {
      get: {
        operationId: 'orders.list',
        summary: '查询我的订单',
        description: '由业务系统按当前用户和租户筛选订单。',
        responses: {
          '200': {
            description: '当前用户订单',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
              },
            },
          },
        },
      },
    },
    '/api/orders/{orderId}': {
      get: {
        operationId: 'orders.get',
        summary: '查询订单详情',
        description: '只能查询自己有权限的订单。',
        parameters: [
          {
            name: 'orderId',
            in: 'path',
            required: true,
            description: '订单编号',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: '订单详情',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
    '/api/preferences': {
      get: {
        operationId: 'preferences.get',
        summary: '查看我的通知偏好',
        description: '查看业务系统已保存的设置，可在办理后再次查询验证。',
        responses: {
          '200': {
            description: '当前偏好',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    emailNotifications: { type: 'boolean', title: '邮件通知' },
                    revision: { type: 'integer', title: '数据版本' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
export function registerDemoQueries(app: FastifyInstance, databaseFile: string, jwks: JSONWebKeySet) {
  const db = new DatabaseSync(databaseFile),
    keys = createLocalJWKSet(jwks);
  db.exec(
    'CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL, customer TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL, internalMemo TEXT NOT NULL)',
  );
  const insert = db.prepare('INSERT OR IGNORE INTO orders VALUES(?,?,?,?,?,?,?)');
  insert.run('ORD-1001', 'tenant-a', 'alice', 'Acme Studio', 1280, '已完成', 'internal-only');
  insert.run('ORD-1002', 'tenant-a', 'alice', 'Bluebird', 680, '处理中', 'internal-only');
  insert.run('ORD-1003', 'tenant-a', 'bob', 'Bob Customer', 360, '待确认', 'internal-only');
  insert.run('ORD-2001', 'tenant-b', 'nina', 'Northwind', 2400, '已完成', 'internal-only');
  const identity = async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new Error();
    const { payload } = await jwtVerify(header.slice(7), keys, {
      algorithms: ['EdDSA'],
      issuer: 'urn:agent18:demo-saas',
      audience: 'agent18:support',
      requiredClaims: ['sub', 'iat', 'exp', 'tenant_id', 'project_key'],
      maxTokenAge: '10m',
    });
    if (
      payload.kind !== 'customer' ||
      payload.project_key !== 'invoice-demo' ||
      !payload.sub ||
      !['tenant-a', 'tenant-b'].includes(String(payload.tenant_id)) ||
      Number(payload.exp) - Number(payload.iat) > 600 ||
      !Array.isArray(payload.roles) ||
      !payload.roles.includes('tenant-admin')
    )
      throw new Error();
    return {
      subject: payload.sub,
      tenant: String(payload.tenant_id),
      scope: JSON.stringify([payload.project_key, payload.tenant_id, payload.sub]),
    };
  };
  app.get('/openapi.json', async () => demoOpenApi);
  for (const path of ['/api/orders', '/api/orders/:orderId', '/api/preferences'])
    app.get(path, async (request, reply) => {
      let p;
      try {
        p = await identity(request);
      } catch {
        return reply.code(403).send({ error: 'FORBIDDEN' });
      }
      z.object({}).strict().parse(request.query);
      if (path === '/api/preferences') {
        const row = db.prepare('SELECT enabled,revision FROM preferences WHERE scope=?').get(p.scope) as
          { enabled: number; revision: number } | undefined;
        return { emailNotifications: row ? !!row.enabled : true, revision: row?.revision ?? 0 };
      }
      if (path === '/api/orders')
        return db
          .prepare(
            'SELECT id,customer,amount,status,internalMemo FROM orders WHERE tenant=? AND subject=? ORDER BY id',
          )
          .all(p.tenant, p.subject);
      const { orderId } = z.object({ orderId: z.string().regex(/^[A-Z0-9-]{1,40}$/) }).parse(request.params);
      const row = db
        .prepare(
          'SELECT id,customer,amount,status,internalMemo FROM orders WHERE id=? AND tenant=? AND subject=?',
        )
        .get(orderId, p.tenant, p.subject);
      return row ?? reply.code(404).send({ error: 'NOT_FOUND' });
    });
  app.addHook('onClose', async () => db.close());
}
