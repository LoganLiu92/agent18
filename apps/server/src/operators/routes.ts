import { registerReadiness } from './readiness.js';
import { registerDeployments } from './deployments.js';
import { registerTicketSync } from './ticket-sync.js';
import { registerAnalytics } from './analytics.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../../../scripts/config.js';
import type { Database } from '@agent18/persistence';
import { AppError } from '@agent18/domain';
import { OperatorService, type OperatorSession } from './service.js';
import { registerReportSchedules } from './schedules.js';
import { registerOperatorFollowup } from './followup.js';
import { registerOperatorRetention } from './retention.js';
import { registerOperatorInsights } from './insights.js';
import { registerOperatorOperations } from './operations.js';
import { registerOperatorSupport } from './support.js';
import { registerOperatorKnowledge } from './knowledge.js';

export function registerOperators(app: FastifyInstance, db: Database, config: Config) {
  const service = new OperatorService(db, config),
    sessions = new WeakMap<FastifyRequest, OperatorSession>();
  const origin = new URL(config.consoleOrigin),
    secure = origin.protocol === 'https:';
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    throw new Error('OPERATOR_HTTPS_REQUIRED');
  const name = secure ? '__Host-agent18_operator' : 'agent18_operator';
  const cookie = (value: string, age: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const session = (req: FastifyRequest) => {
    const s = sessions.get(req);
    if (!s) throw new AppError('OPERATOR_LOGIN_REQUIRED', 401);
    return s;
  };
  app.addHook('preHandler', async (req, reply) => {
    if (!(req.routeOptions.url ?? '').startsWith('/operator/')) return;
    reply.header('cache-control', 'no-store');
    if (req.headers.origin && req.headers.origin !== origin.origin)
      throw new AppError('OPERATOR_ORIGIN_DENIED', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('OPERATOR_ORIGIN_DENIED', 403);
    if (req.method !== 'GET' && req.headers.origin !== origin.origin)
      throw new AppError('OPERATOR_ORIGIN_DENIED', 403);
    if (req.routeOptions.url === '/operator/login') return;
    const values = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + '='));
    if (values.length !== 1) throw new AppError('OPERATOR_LOGIN_REQUIRED', 401);
    const s = await service.session(values[0]!.slice(name.length + 1));
    if (req.method !== 'GET') {
      const csrf = Buffer.from(
        typeof req.headers['x-operator-csrf'] === 'string' ? req.headers['x-operator-csrf'] : '',
      );
      const expected = Buffer.from(s.csrf);
      if (csrf.length !== expected.length || !timingSafeEqual(csrf, expected))
        throw new AppError('OPERATOR_CSRF_REQUIRED', 403);
    }
    sessions.set(req, s);
  });
  app.post('/operator/login', async (req, reply) => {
    const token = await service.login(req.body, req.ip, req.id);
    reply.header('set-cookie', cookie(token, 8 * 3600));
    return { authenticated: true };
  });
  app.get('/operator/session', async (req) => {
    const s = session(req);
    return { account: s.account, csrf: s.csrf, projects: await service.projects(s) };
  });
  app.post('/operator/logout', async (req, reply) => {
    z.object({}).strict().parse(req.body);
    await service.logout(session(req), req.id);
    reply.header('set-cookie', cookie('', 0));
    return { loggedOut: true };
  });
  app.post('/operator/password', async (req, reply) => {
    const result = await service.password(session(req), req.body, req.id);
    reply.header('set-cookie', cookie('', 0));
    return result;
  });
  app.get('/operator/accounts', (req) => service.accounts(session(req), req.query));
  app.get('/operator/audit', (req) => service.auditLog(session(req), req.query));
  app.post('/operator/accounts', (req) => service.create(session(req), req.body, req.id));
  app.post('/operator/accounts/:id', (req) =>
    service.update(session(req), z.object({ id: z.string().uuid() }).parse(req.params).id, req.body, req.id),
  );
  app.post('/operator/accounts/:id/password', (req) =>
    service.reset(session(req), z.object({ id: z.string().uuid() }).parse(req.params).id, req.body, req.id),
  );
  app.get('/operator/projects/:key', async (req) => {
    return service.withPermission(
      session(req),
      z.object({ key: z.string() }).parse(req.params).key,
      'project.read',
      async (_client, p) => ({ key: p.key, name: p.displayName ?? p.key }),
    );
  });
  registerOperatorKnowledge(app, service, session);
  const supportRun = registerOperatorSupport(app, service, session);
  registerOperatorOperations(app, supportRun);
  registerOperatorInsights(app, supportRun);
  registerReportSchedules(app, supportRun);
  registerAnalytics(app, supportRun);
  registerReadiness(app, supportRun);
  registerTicketSync(app, supportRun);
  registerDeployments(app, supportRun);
  registerOperatorRetention(app, supportRun);
  registerOperatorFollowup(app, supportRun);
  return { service, session };
}
