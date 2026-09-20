import { registerGitCredentials } from './git-credentials.js';
import { registerAnalyticsSetup } from './analytics.js';
import Fastify from 'fastify';
import { registerOperations } from './operations.js';
import { registerObservations } from './observations.js';
import { atomicJson } from '../../../scripts/lib/atomic.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { Pool } from '@agent18/persistence';
import { AppError } from '@agent18/domain';
import {
  KnowledgeIndexer,
  KnowledgeError,
  knowledgeConfigSchema,
  modelFromEnvironment,
  CompatibleModel,
} from '@agent18/knowledge';
import { configSchema } from '../../../scripts/config.js';
import { configureProject, projectInputSchema } from '../../../scripts/lib/project-config.js';
import { OperatorService } from '../../server/src/operators/service.js';

type Job = {
  id: string;
  state: 'running' | 'completed' | 'failed';
  phase: string;
  results: Record<string, unknown>[];
  error?: string;
};
export type SetupOptions = {
  directory: string;
  token: string;
  port?: number;
  apply?: () => Promise<void>;
  root?: string;
};
export async function buildSetupApp(options: SetupOptions) {
  if (options.token.length < 16) throw new Error('SETUP_ACCESS_INVALID');
  const app = Fastify({ logger: false, bodyLimit: 64000, requestTimeout: 15000 });
  const directory = resolve(options.directory),
    port = options.port ?? 4321;
  const json = async (name: string) => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
  const save = async (name: string, value: unknown) => atomicJson(resolve(directory, name), value);
  const settings = async () => configSchema.parse(await json('server.json'));
  const environment = async () =>
    parseEnv(await readFile(resolve(directory, 'model.env'), 'utf8').catch(() => ''));
  let busy = false,
    job: Job | undefined,
    pendingJob: Promise<void> | undefined;
  const abort = new AbortController();
  const mutate = async <T>(fn: () => Promise<T>) => {
    if (busy) throw new KnowledgeError('SETUP_BUSY');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
  const withIndexer = async <T>(
    fn: (indexer: KnowledgeIndexer, config: z.infer<typeof knowledgeConfigSchema>) => Promise<T>,
  ) => {
    const config = knowledgeConfigSchema.parse(await json('knowledge.json'));
    const project = (await settings()).projects.find((p) => p.key === config.projectKey);
    if (!project) throw new KnowledgeError('PROJECT_NOT_FOUND');
    const pool = new Pool({ connectionString: (await json('indexer.json')).databaseUrl, max: 3 });
    const model = modelFromEnvironment(await environment());
    const indexer = new KnowledgeIndexer(
      pool,
      { ...project, tenantId: 'operator', subject: 'setup-owner' },
      resolve(directory, 'git-cache'),
      model ? new CompatibleModel(model) : undefined,
    );
    try {
      return await fn(indexer, config);
    } finally {
      await pool.end();
    }
  };
  app.addHook('onRequest', async (request, reply) => {
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!hosts.includes(request.headers.host ?? ''))
      return reply.code(403).send({ error: { code: 'SETUP_HOST_DENIED' } });
    const origin = request.headers.origin;
    if (origin && !hosts.map((h) => `http://${h}`).includes(origin))
      return reply.code(403).send({ error: { code: 'SETUP_ORIGIN_DENIED' } });
    const address = request.ip.replace(/^::ffff:/, '');
    if (!['127.0.0.1', '::1'].includes(address))
      return reply.code(403).send({ error: { code: 'LOCAL_SETUP_ONLY' } });
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      );
    if ((request.routeOptions.url ?? '').startsWith('/owner/')) {
      const raw = request.headers.authorization ?? '',
        supplied = Buffer.from(raw.startsWith('Bearer ') ? raw.slice(7) : ''),
        expected = Buffer.from(options.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return reply.code(401).send({ error: { code: 'SETUP_ACCESS_REQUIRED' } });
    }
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        error instanceof AppError
          ? error.status
          : error instanceof KnowledgeError
            ? error.code === 'SETUP_BUSY'
              ? 409
              : 400
            : 400,
      )
      .send({
        error: {
          code:
            error instanceof AppError || error instanceof KnowledgeError
              ? error.code
              : 'SETUP_REQUEST_FAILED',
        },
      }),
  );
  registerOperations(app, directory, mutate);
  registerAnalyticsSetup(app, directory, mutate);
  registerGitCredentials(app, directory, mutate);
  registerObservations(app, directory, mutate);
  const withOperators = async <T>(fn: (service: OperatorService) => Promise<T>) => {
    const config = await settings();
    const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
    try {
      return await fn(new OperatorService(pool, config));
    } finally {
      await pool.end();
    }
  };
  app.get('/owner/operators', () =>
    withOperators(async (service) => ({ initialized: await service.initialized() })),
  );
  app.post('/owner/operators/bootstrap', (request) =>
    mutate(() => withOperators((service) => service.bootstrap(request.body, request.id))),
  );
  app.post('/owner/operators/recover', (request) =>
    mutate(() => withOperators((service) => service.recoverAdministrator(request.body, request.id))),
  );
  app.get('/owner/state', async () => {
    const config = await settings(),
      env = await environment();
    const knowledge = await json('knowledge.json').catch(() => null);
    let builds: unknown[] = [];
    if (knowledge) builds = await withIndexer((i) => i.status()).catch(() => []);
    return {
      completed: config.setupCompleted,
      displayName: config.displayName,
      coreUrl: config.consoleOrigin,
      projects: config.projects.map((p) => ({
        key: p.key,
        displayName: p.displayName ?? p.key,
        organizationId: p.organizationId,
        projectId: p.projectId,
        issuer: p.issuer,
        audience: p.audience,
        jwks: p.jwks,
        allowedOrigins: p.allowedOrigins,
        knowledge: p.knowledge,
        businessBridge: p.businessBridge,
        businessQueries: p.businessQueries,
      })),
      model: {
        baseUrl: env.AGENT18_MODEL_BASE_URL ?? '',
        name: env.AGENT18_MODEL_NAME ?? '',
        configured: !!env.AGENT18_MODEL_API_KEY,
        tokenLimitField: env.AGENT18_MODEL_TOKEN_LIMIT_FIELD ?? 'max_completion_tokens',
        jsonMode: env.AGENT18_MODEL_JSON_MODE !== 'false',
      },
      knowledge,
      builds,
      job,
      exampleSources: [
        {
          id: 'agent18-docs',
          name: 'Agent18 使用文档',
          kind: 'directory',
          location: resolve('.'),
          ref: 'HEAD',
          include: ['README.md', 'docs/guides/**/*.md'],
          exclude: [],
          audience: 'customer',
          tenantIds: [],
        },
        {
          id: 'agent18-source',
          name: 'Agent18 内部实现',
          kind: 'directory',
          location: resolve('.'),
          ref: 'HEAD',
          include: ['apps/**/*.ts', 'packages/**/*.ts', 'providers/**/*.ts'],
          exclude: [],
          audience: 'internal',
          tenantIds: [],
        },
      ],
    };
  });
  app.post('/owner/project', async (request) =>
    mutate(async () => {
      const input = projectInputSchema.parse(request.body);
      await configureProject(input, directory);
      return { projectKey: input.project.key };
    }),
  );
  const modelInput = z
    .object({
      baseUrl: z.string().max(1000),
      name: z.string().max(200),
      apiKey: z.string().max(4000).optional(),
      tokenLimitField: z.enum(['max_completion_tokens', 'max_tokens']).default('max_completion_tokens'),
      jsonMode: z.boolean().default(true),
    })
    .strict();
  const candidate = async (raw: unknown) => {
    const input = modelInput.parse(raw),
      existing = await environment();
    const env = {
      ...existing,
      AGENT18_MODEL_BASE_URL: input.baseUrl,
      AGENT18_MODEL_NAME: input.name,
      AGENT18_MODEL_API_KEY: input.apiKey || existing.AGENT18_MODEL_API_KEY,
      AGENT18_MODEL_TOKEN_LIMIT_FIELD: input.tokenLimitField,
      AGENT18_MODEL_JSON_MODE: String(input.jsonMode),
    };
    const model = modelFromEnvironment(env);
    if (!model) throw new KnowledgeError('MODEL_NOT_CONFIGURED');
    return { env, model };
  };
  app.post('/owner/model/test', async (request) =>
    mutate(async () => {
      const { model } = await candidate(request.body);
      if (!model) throw new KnowledgeError('MODEL_NOT_CONFIGURED');
      await new CompatibleModel(model).complete(
        'Return JSON only: {"connected":true}.',
        { purpose: 'connection-test' },
        AbortSignal.timeout(35000),
      );
      return { connected: true };
    }),
  );
  app.post('/owner/model', async (request) =>
    mutate(async () => {
      const { env } = await candidate(request.body);
      await writeFile(
        resolve(directory, 'model.env'),
        Object.entries(env)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join('\n') + '\n',
        { mode: 0o600 },
      );
      return { saved: true };
    }),
  );
  app.post('/owner/knowledge/select', async (request) =>
    mutate(async () => {
      const { projectKey } = z
        .object({ projectKey: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) })
        .strict()
        .parse(request.body);
      if (!(await settings()).projects.some((p) => p.key === projectKey))
        throw new KnowledgeError('PROJECT_NOT_FOUND');
      const previous = await json('knowledge.json').catch(() => null);
      if (previous?.projectKey) await save('knowledge.' + previous.projectKey + '.json', previous);
      const next =
        previous?.projectKey === projectKey
          ? previous
          : await json('knowledge.' + projectKey + '.json').catch(() => ({
              projectKey,
              mode: 'extractive',
              maxModelCalls: 100,
              sources: [],
            }));
      await save('knowledge.json', next);
      return { knowledge: next };
    }),
  );
  app.post('/owner/knowledge', async (request) =>
    mutate(async () => {
      const input = knowledgeConfigSchema.parse(request.body);
      if (!(await settings()).projects.some((p) => p.key === input.projectKey))
        throw new KnowledgeError('PROJECT_NOT_FOUND');
      const previous = await json('knowledge.json').catch(() => null);
      if (previous?.projectKey === input.projectKey) {
        const removed = previous.sources.filter(
          (source: { id: string; audience: string; tenantIds?: string[] }) => {
            const next = input.sources.find((item) => item.id === source.id);
            return (
              !next ||
              next.audience !== source.audience ||
              JSON.stringify([...next.tenantIds].sort()) !==
                JSON.stringify([...(source.tenantIds ?? [])].sort())
            );
          },
        );
        if (removed.length)
          await withIndexer(async (indexer) => {
            for (const source of removed) {
              try {
                await indexer.disable(source.id);
              } catch (error) {
                if (!(error instanceof KnowledgeError) || error.code !== 'SOURCE_NOT_FOUND') throw error;
              }
            }
          });
      }
      await save('knowledge.json', input);
      await save('knowledge.' + input.projectKey + '.json', input);
      return { saved: true };
    }),
  );
  app.post('/owner/build', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    if (busy) throw new KnowledgeError('SETUP_BUSY');
    busy = true;
    const current: Job = { id: randomUUID(), state: 'running', phase: '准备读取资料', results: [] };
    job = current;
    pendingJob = withIndexer(async (indexer, config) => {
      for (const raw of config.sources) {
        const source = {
          ...raw,
          location: raw.kind === 'directory' ? resolve(directory, raw.location) : raw.location,
        };
        current.phase = `正在构建 ${source.name}`;
        current.results.push(await indexer.sync(source, config, abort.signal));
      }
      current.state = 'completed';
      current.phase = '构建完成，请检查并发布';
    })
      .catch((error) => {
        current.state = 'failed';
        current.error = error instanceof KnowledgeError ? error.code : 'BUILD_FAILED';
        current.phase = '构建未完成';
      })
      .finally(() => {
        busy = false;
      });
    return reply.code(202).send(current);
  });
  app.get('/owner/build', async () => ({ job, busy }));
  app.get('/owner/build/:id/articles', async (request) =>
    withIndexer((i) => i.export(z.object({ id: z.string().uuid() }).parse(request.params).id)),
  );
  app.post('/owner/publish', async (request) =>
    mutate(async () => {
      const { buildId } = z.object({ buildId: z.string().uuid() }).strict().parse(request.body);
      return withIndexer(async (i, config) => {
        const build = (await i.status()).find((row) => row.build_id === buildId);
        if (!build || build.state !== 'ready') throw new KnowledgeError('BUILD_NOT_READY');
        const source = config.sources.find((item) => item.id === build.source_key);
        if (
          !source ||
          source.audience !== build.report.audience ||
          JSON.stringify([...source.tenantIds].sort()) !==
            JSON.stringify([...(build.report.tenantIds ?? [])].sort())
        )
          throw new KnowledgeError('BUILD_POLICY_CHANGED');
        const result = await i.publish(buildId);
        for (const file of ['server.json', 'server.docker.json']) {
          const current = await json(file);
          for (const p of current.projects) if (p.key === config.projectKey) p.knowledge = 'indexed';
          await save(file, current);
        }
        return result;
      });
    }),
  );
  app.post('/owner/apply', async (request) =>
    mutate(async () => {
      const { displayName, coreUrl } = z
        .object({
          displayName: z.string().trim().min(1).max(120),
          coreUrl: z
            .string()
            .url()
            .refine((value) => {
              const url = new URL(value);
              return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
            })
            .optional(),
        })
        .strict()
        .parse(request.body);
      // Fixed deployment operation supplied by the host. Never accept a command from the browser.
      for (const file of ['server.json', 'server.docker.json']) {
        const config = await json(file);
        config.setupCompleted = true;
        config.displayName = displayName;
        if (coreUrl) config.consoleOrigin = coreUrl;
        await save(file, config);
      }
      if (!options.apply) return { saved: true, applied: false };
      try {
        await options.apply();
        return { saved: true, applied: true };
      } catch {
        throw new KnowledgeError('SETTINGS_SAVED_RESTART_FAILED');
      }
    }),
  );
  const root = resolve(options.root ?? 'apps/console/dist');
  app.get('/', async (_request, reply) => reply.redirect('/setup'));
  app.get('/*', async (request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, pathname === '/setup' ? 'index.html' : '.' + pathname);
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    if (!file.startsWith(root + sep) || !mime[extname(file)]) return reply.code(404).send();
    try {
      return reply.type(mime[extname(file)]!).send(await readFile(file));
    } catch {
      return reply.code(404).send();
    }
  });
  app.addHook('onClose', async () => {
    abort.abort();
    await pendingJob;
  });
  await app.ready();
  return app;
}
