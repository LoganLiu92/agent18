import type { ProviderRegistry } from '@agent18/provider-contracts';
import { registerDocs } from './docs.js';
import { openApi } from './openapi.js';
import Fastify, { type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { z, ZodError } from 'zod';
import { reportCaseSchema, searchSchema, assistantTurnSchema, id } from '@agent18/contracts';
import { AppError, type CustomerPrincipal } from '@agent18/domain';
import { Pool, scoped, requireTenant, audit } from '@agent18/persistence';
import { OpaPolicy } from '@agent18/policy';
import {
  IndexedKnowledgeProvider,
  ProjectKnowledgeProvider,
  CompatibleModel,
  modelFromEnvironment,
  answerQuestion,
  KnowledgeError,
} from '@agent18/knowledge';
import { ActionService, QueryService, routeConversation } from '@agent18/actions';
import { FixtureKnowledgeProvider } from '@agent18/knowledge-basic';
import {
  ToolGateway,
  type CaseWorkflow,
  CaseService,
  Dispatcher,
  caseMessages,
  addCaseMessage,
  changeCaseStatus,
  messageInput,
} from '@agent18/application';
import type { Config } from '../../../scripts/config.js';
import { customerVerifier, verifyWorkload } from './auth.js';

export async function buildApp(
  config: Config,
  options: {
    dispatch?: boolean;
    providers?: ProviderRegistry;
    caseWorkflow?: CaseWorkflow;
    environment?: 'development' | 'staging' | 'production';
  } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16_384,
    requestTimeout: 15_000,
    genReqId: () => randomUUID(),
  });
  const customerRoutes: string[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method])
      if (route.url.startsWith('/api/') && !['HEAD', 'OPTIONS'].includes(method))
        customerRoutes.push(method + ' ' + route.url.replace(/:(\w+)/g, '{$1}'));
  });
  const db = new Pool({
    connectionString: config.databaseUrl,
    max: 12,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
  });
  db.on('error', () => console.error('agent18 database connection error'));
  const policy = new OpaPolicy(config.opaUrl);
  const projectFor = (scope: { organizationId: string; projectId: string }) =>
    config.projects.find(
      (p) => p.organizationId === scope.organizationId && p.projectId === scope.projectId,
    )!;
  const isIndexed = (scope: { organizationId: string; projectId: string }) =>
    projectFor(scope).knowledge === 'indexed';
  const indexed = new IndexedKnowledgeProvider(db);
  const provider = new ProjectKnowledgeProvider(indexed, new FixtureKnowledgeProvider(), isIndexed);
  const gateway = new ToolGateway(db, policy, provider, options.providers, options.environment);
  const modelConfig = modelFromEnvironment();
  const model = modelConfig ? new CompatibleModel(modelConfig) : undefined;
  const actions = new ActionService(
    db,
    policy,
    (p) => projectFor(p).businessBridge,
    model,
    options.environment,
  );
  const queries = new QueryService(db, policy, (p) => projectFor(p).businessQueries, options.environment);
  let activeExpensive = 0;
  const usage = new Map<string, { since: number; count: number }>();
  const bounded = async <T>(p: CustomerPrincipal, fn: () => Promise<T>): Promise<T> => {
    const key = [p.organizationId, p.projectId, p.tenantId, p.subject].join('/');
    const now = Date.now();
    for (const [k, v] of usage) if (now - v.since > 60000) usage.delete(k);
    const entry = usage.get(key) ?? { since: now, count: 0 };
    if (activeExpensive >= 4 || entry.count >= 20 || usage.size >= 10000)
      throw new AppError('RATE_LIMITED', 429);
    entry.count++;
    usage.set(key, entry);
    activeExpensive++;
    try {
      return await fn();
    } finally {
      activeExpensive--;
    }
  };
  const cases = new CaseService(db, gateway, options.caseWorkflow);
  const dispatcher = new Dispatcher(db, config.queueDatabaseUrl, (scope, runId, reason) =>
    cases.runs.reconcile(scope, runId, reason),
  );
  const verifyCustomer = customerVerifier(config);
  const principals = new WeakMap<FastifyRequest, CustomerPrincipal>();
  const principal = (request: FastifyRequest) => {
    const value = principals.get(request);
    if (!value) throw new AppError('UNAUTHENTICATED', 401);
    return value;
  };
  app.addHook('onSend', async (_request, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://localhost:4319 http://127.0.0.1:4319; frame-ancestors 'none'; base-uri 'none'",
    );
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') && request.url !== '/sdk/agent18.js') return;
    const origin = request.headers.origin;
    const allowed = new Set([config.consoleOrigin, ...config.projects.flatMap((p) => p.allowedOrigins)]);
    if (origin && !allowed.has(origin)) throw new AppError('ORIGIN_DENIED', 403);
    if (origin) reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
    if (request.method === 'OPTIONS')
      return reply
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-allow-headers', 'authorization, content-type, x-project-key, idempotency-key')
        .code(204)
        .send();
  });
  app.options('/api/*', async (_request, reply) => reply.code(204).send());
  app.addHook('preHandler', async (request) => {
    const route = request.routeOptions.url ?? '';
    if (route.startsWith('/api/')) {
      const customer = await verifyCustomer(request);
      if (
        request.headers.origin &&
        request.headers.origin !== config.consoleOrigin &&
        !projectFor(customer).allowedOrigins.includes(request.headers.origin)
      )
        throw new AppError('ORIGIN_DENIED', 403);
      await scoped(db, customer, requireTenant);
      principals.set(request, customer);
    } else if (route.startsWith('/internal/')) verifyWorkload(request, config.workerToken);
  });
  app.setErrorHandler(async (error, request, reply) => {
    let code = 'INTERNAL_ERROR',
      status = 500;
    if (error instanceof AppError) {
      code = error.code;
      status = error.status;
    } else if (error instanceof KnowledgeError) {
      code = error.code;
      status = code === 'MODEL_NOT_CONFIGURED' ? 409 : 502;
    } else if (error instanceof ZodError || (error as { statusCode?: number }).statusCode === 400) {
      code = 'INVALID_REQUEST';
      status = 400;
    } else if ((error as { statusCode?: number }).statusCode === 413) {
      code = 'REQUEST_TOO_LARGE';
      status = 413;
    }
    try {
      await db.query('INSERT INTO control.security_events (id,request_id,reason) VALUES ($1,$2,$3)', [
        randomUUID(),
        request.id,
        code,
      ]);
    } catch {
      code = 'AUDIT_UNAVAILABLE';
      status = 503;
    }
    if (status === 500) console.error('agent18 request failed', request.id); // No raw error, headers, tokens or request bodies.
    return reply.code(status).send({ error: { code, requestId: request.id } });
  });
  registerDocs(app);
  app.get('/openapi.json', async () => openApi);
  app.get('/health/live', async () => ({ service: 'agent18', status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      const response = await fetch(`${config.opaUrl}/health?bundles`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error('Policy health');
      const decision = await policy.decide({} as never);
      if (decision.reason !== 'POLICY_DENIED') throw new Error('Policy bundle missing');
      return { status: 'ready', database: 'connected', policy: 'loaded' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/public/installation', async () => ({
    setupCompleted: config.setupCompleted,
    displayName: config.displayName,
    version: '0.6.0',
  }));
  app.get('/public/projects/:projectKey', async (request, reply) => {
    const { projectKey } = z.object({ projectKey: z.string().max(100) }).parse(request.params);
    const project = config.projects.find((p) => p.key === projectKey);
    if (!project) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND' } });
    return {
      projectKey: project.key,
      displayName: project.displayName ?? project.key,
      allowedOrigins: project.allowedOrigins,
    };
  });
  app.get('/api/session', async (request) => {
    const value = principal(request);
    return {
      principal: {
        kind: value.kind,
        tenantId: value.tenantId,
        subject: value.subject,
        projectId: value.projectId,
      },
      capabilities: {
        caseReporting: true,
        knowledge: isIndexed(value) ? 'indexed' : 'fixture',
        model: model ? 'configured' : 'unconfigured',
        businessActions: actions.list(value).length > 0,
        businessQueries: queries.list(value).length > 0,
        runtime: 'unconfigured',
        coding: 'unconfigured',
        operatorConsole: false,
      },
      tool: { id: 'knowledge.search', effect: 'READ', policy: 'OPA · default deny' },
    };
  });
  app.get('/api/cases', async (request) => ({ cases: await cases.list(principal(request)) }));
  app.post('/api/cases', async (request, reply) => {
    const key = id.parse(request.headers['idempotency-key']);
    const result = await cases.report(
      principal(request),
      reportCaseSchema.parse(request.body),
      key,
      request.id,
    );
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get('/api/cases/:caseId', async (request) =>
    cases.detail(principal(request), z.object({ caseId: id }).parse(request.params).caseId),
  );
  app.get('/api/cases/:caseId/messages', async (request) => ({
    messages: await caseMessages(
      db,
      principal(request),
      z.object({ caseId: id }).parse(request.params).caseId,
    ),
  }));
  app.post('/api/cases/:caseId/messages', async (request) =>
    addCaseMessage(
      db,
      principal(request),
      z.object({ caseId: id }).parse(request.params).caseId,
      'customer',
      messageInput.parse(request.body),
      id.parse(request.headers['idempotency-key']),
      request.id,
    ),
  );
  app.post('/api/cases/:caseId/status', async (request) =>
    changeCaseStatus(
      db,
      principal(request),
      z.object({ caseId: id }).parse(request.params).caseId,
      z
        .object({ status: z.enum(['resolved', 'needs_human']) })
        .strict()
        .parse(request.body).status,
      request.id,
    ),
  );
  app.post('/api/knowledge/search', async (request) =>
    gateway.search(principal(request), searchSchema.parse(request.body).query, request.id),
  );
  app.get('/api/knowledge/catalogue', async (request) => {
    const p = principal(request);
    await gateway.authorize(p, request.id);
    return isIndexed(p) ? indexed.catalogue(p) : { articles: [], truncated: false };
  });
  app.get('/api/knowledge/articles/:articleId', async (request) => {
    const p = principal(request);
    await gateway.authorize(p, request.id);
    const article = isIndexed(p)
      ? await indexed.article(p, z.object({ articleId: id }).parse(request.params).articleId)
      : null;
    if (!article) throw new AppError('NOT_FOUND', 404);
    return article;
  });
  app.post('/api/knowledge/ask', async (request) => {
    const p = principal(request),
      query = searchSchema.parse(request.body).query;
    return bounded(p, async () => {
      const retrieval = await gateway.search(p, query, request.id);
      await audit(db, p, {
        requestId: request.id,
        action: 'knowledge.answer',
        decision: 'ALLOW',
        reason: model ? 'MODEL_REQUESTED' : 'RETRIEVAL_ONLY',
      });
      const result = await answerQuestion(model, query, retrieval);
      if ((await gateway.visible(p, result.citations)).length !== result.citations.length)
        throw new AppError('KNOWLEDGE_VERSION_CHANGED', 409);
      await audit(db, p, {
        requestId: request.id,
        action: 'knowledge.answer',
        decision: 'ALLOW',
        reason: result.mode === 'model' ? 'ANSWER_REFERENCES_VALIDATED' : 'RETRIEVAL_ONLY',
      });
      return result;
    });
  });
  app.get('/api/business/queries', async (request) => ({ queries: queries.list(principal(request)) }));
  app.post('/api/assistant/route', async (request) => {
    const p = principal(request),
      input = assistantTurnSchema.parse(request.body);
    return bounded(p, async () => {
      await gateway.authorize(p, request.id);
      await audit(db, p, {
        requestId: request.id,
        action: 'assistant.route',
        decision: 'ALLOW',
        reason: 'GUIDANCE_ONLY',
      });
      return routeConversation(input, { queries: queries.list(p), actions: actions.list(p) }, model);
    });
  });
  app.post('/api/business/query', async (request) => {
    const input = z
      .object({ queryId: z.string().max(80), arguments: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(request.body);
    return bounded(principal(request), () =>
      queries.execute(
        principal(request),
        input.queryId,
        input.arguments,
        request.headers.authorization!,
        request.id,
      ),
    );
  });
  app.get('/api/actions', async (request) => ({ actions: actions.list(principal(request)) }));
  app.post('/api/actions/plan', async (request) =>
    bounded(principal(request), () =>
      actions.plan(
        principal(request),
        searchSchema.parse(request.body).query,
        request.headers.authorization!,
        request.id,
      ),
    ),
  );
  app.post('/api/actions/prepare', async (request) => {
    const input = z
      .object({ actionId: z.string().max(80), arguments: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(request.body);
    return bounded(principal(request), () =>
      actions.prepare(
        principal(request),
        input.actionId,
        input.arguments,
        request.headers.authorization!,
        request.id,
      ),
    );
  });
  app.get('/api/actions/proposals', async (request) => ({
    proposals: await actions.history(principal(request)),
  }));
  app.get('/api/actions/proposals/:proposalId', async (request) =>
    actions.get(principal(request), z.object({ proposalId: id }).parse(request.params).proposalId),
  );
  app.post('/api/actions/proposals/:proposalId/confirm', async (request) => {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(request.body);
    return bounded(principal(request), () =>
      actions.confirm(
        principal(request),
        z.object({ proposalId: id }).parse(request.params).proposalId,
        request.headers.authorization!,
        request.id,
      ),
    );
  });
  app.post('/api/actions/proposals/:proposalId/reconcile', async (request) => {
    z.object({}).strict().parse(request.body);
    return bounded(principal(request), () =>
      actions.reconcile(
        principal(request),
        z.object({ proposalId: id }).parse(request.params).proposalId,
        request.headers.authorization!,
        request.id,
      ),
    );
  });
  app.get('/sdk/agent18.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(await readFile('packages/web-sdk/dist/agent18.js')),
  );
  app.post('/api/runs/:runId/cancel', async (request) => {
    z.object({}).strict().parse(request.body);
    const runId = z.object({ runId: id }).parse(request.params).runId;
    return cases.runs.cancel(principal(request), runId, request.id);
  });
  app.post('/api/runs/:runId/retry', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    const runId = z.object({ runId: id }).parse(request.params).runId;
    const key = id.parse(request.headers['idempotency-key']);
    const result = await cases.runs.retry(principal(request), runId, key, request.id);
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.post('/internal/jobs/claim', async (request) => {
    const input = z.object({ dispatchId: id, jobId: id }).strict().parse(request.body);
    return dispatcher.claim(input.dispatchId, input.jobId);
  });
  app.post('/internal/runs/:runId/execute', async (request) => {
    z.object({}).strict().parse(request.body);
    const runId = z.object({ runId: id }).parse(request.params).runId;
    const lease = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(request.headers['x-run-lease']);
    const scope = await dispatcher.resolve(runId, lease);
    try {
      return await cases.execute(scope, runId, request.id);
    } finally {
      await dispatcher.release(runId, lease);
    }
  });
  const root = resolve('apps/console/dist');
  app.get('/*', async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/internal/'))
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(
      root,
      ['/', '/console', '/support'].includes(pathname) ? 'index.html' : '.' + pathname,
    );
    if (!file.startsWith(root + sep)) return reply.code(404).send();
    try {
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
      };
      if (!types[extname(file)]) return reply.code(404).send();
      return reply.type(types[extname(file)]!).send(await readFile(file));
    } catch {
      return reply.code(404).send({ error: { code: 'CONSOLE_NOT_BUILT' } });
    }
  });
  if (options.dispatch !== false) await dispatcher.start();
  app.addHook('onClose', async () => {
    if (options.dispatch !== false) await dispatcher.stop();
    await db.end();
  });
  await app.ready();
  return { app, db, cases, gateway, dispatcher, customerRoutes };
}
