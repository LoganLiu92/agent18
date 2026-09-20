import { serializeEnv } from '../../../scripts/lib/env-file.js';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { analyticsConfigSchema, ticketSyncConfigSchema, deploymentFeedSchema } from '@agent18/contracts';
import { configSchema } from '../../../scripts/config.js';
import { atomicJson } from '../../../scripts/lib/atomic.js';
import { KnowledgeError } from '@agent18/knowledge';
export function registerAnalyticsSetup(
  app: FastifyInstance,
  directory: string,
  mutate: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  const json = async (file: string) => JSON.parse(await readFile(resolve(directory, file), 'utf8'));
  app.post('/owner/projects/:projectKey/analytics', (req) =>
    mutate(async () => {
      const { projectKey } = z.object({ projectKey: z.string() }).parse(req.params),
        input = z
          .object({
            config: analyticsConfigSchema,
            dockerBaseUrl: analyticsConfigSchema.shape.baseUrl.optional(),
          })
          .strict()
          .parse(req.body),
        files = [];
      for (const file of ['server.json', 'server.docker.json']) {
        const c = configSchema.parse(await json(file)),
          p = c.projects.find((p) => p.key === projectKey);
        if (!p) throw new KnowledgeError('PROJECT_NOT_FOUND');
        p.analytics = {
          ...input.config,
          baseUrl:
            file === 'server.docker.json'
              ? (input.dockerBaseUrl ?? input.config.baseUrl)
              : input.config.baseUrl,
        };
        files.push({ file, config: c });
      }
      for (const f of files) await atomicJson(resolve(directory, f.file), f.config);
      return { saved: true, restartRequired: true };
    }),
  );
  app.post('/owner/projects/:projectKey/ticket-sync', (req) =>
    mutate(async () => {
      const { projectKey } = z.object({ projectKey: z.string() }).parse(req.params),
        input = ticketSyncConfigSchema.parse(req.body),
        files = [];
      for (const file of ['server.json', 'server.docker.json']) {
        const c = configSchema.parse(await json(file)),
          p = c.projects.find((p) => p.key === projectKey);
        if (!p) throw new KnowledgeError('PROJECT_NOT_FOUND');
        p.ticketSync = input;
        files.push({ file, config: c });
      }
      for (const f of files) await atomicJson(resolve(directory, f.file), f.config);
      return { saved: true, restartRequired: true };
    }),
  );
  app.post('/owner/projects/:projectKey/deployment-feed', (req) =>
    mutate(async () => {
      const { projectKey } = z.object({ projectKey: z.string() }).parse(req.params),
        input = deploymentFeedSchema.parse(req.body),
        files = [];
      for (const file of ['server.json', 'server.docker.json']) {
        const c = configSchema.parse(await json(file)),
          p = c.projects.find((p) => p.key === projectKey);
        if (!p) throw new KnowledgeError('PROJECT_NOT_FOUND');
        p.deploymentFeed = input;
        files.push({ file, config: c });
      }
      for (const f of files) await atomicJson(resolve(directory, f.file), f.config);
      return { saved: true, restartRequired: true };
    }),
  );
  app.post('/owner/analytics/credentials', (req) =>
    mutate(async () => {
      const { name, value } = z
          .object({
            name: z.string().regex(/^AGENT18_(ANALYTICS|SYNC|DEPLOY)_[A-Z0-9_]{1,60}$/),
            value: z
              .string()
              .min(16)
              .max(4000)
              .regex(/^[A-Za-z0-9._~+\/=-]+$/),
          })
          .strict()
          .parse(req.body),
        path = resolve(directory, 'analytics.env'),
        env = parseEnv(await readFile(path, 'utf8').catch(() => ''));
      if (Object.keys(env).length >= 30 && !(name in env)) throw new KnowledgeError('CREDENTIAL_LIMIT');
      env[name] = value;
      await writeFile(path, serializeEnv(env), { mode: 0o600 });
      await chmod(path, 0o600);
      return { saved: true, restartRequired: true };
    }),
  );
}
