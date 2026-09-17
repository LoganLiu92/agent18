import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Pool, caseView } from '@agent18/persistence';
import { addCaseMessage, caseMessages, messageInput } from '@agent18/application';
import { id } from '@agent18/contracts';
import { importOpenApi, queriesSchema, querySchema, bridgeSchema } from '@agent18/actions';
import { KnowledgeError } from '@agent18/knowledge';
import { configSchema } from '../../../scripts/config.js';
import { atomicJson } from '../../../scripts/lib/atomic.js';
import { diagnose } from '../../../scripts/lib/doctor.js';
import { demoOpenApi } from '../../../examples/identity-bridge/queries.js';
import { configureProject, projectInputSchema } from '../../../scripts/lib/project-config.js';

export function registerOperations(
  app: FastifyInstance,
  directory: string,
  mutate: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  const json = async (name: string) => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
  const config = async () => configSchema.parse(await json('server.json'));
  const projectKey = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
  async function project(raw: unknown) {
    const { projectKey: key } = z.object({ projectKey }).parse(raw);
    const p = (await config()).projects.find((p) => p.key === key);
    if (!p) throw new KnowledgeError('PROJECT_NOT_FOUND');
    return p;
  }
  const withAdmin = async <T>(fn: (db: InstanceType<typeof Pool>) => Promise<T>): Promise<T> => {
    const db = new Pool({
      connectionString: (await json('migration.json')).adminDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    try {
      return await fn(db);
    } finally {
      await db.end();
    }
  };
  app.get('/owner/doctor', () => diagnose(directory));
  app.get('/owner/examples/openapi', async () => demoOpenApi);
  app.post('/owner/openapi/import', { bodyLimit: 550000 }, async (request) =>
    importOpenApi(z.object({ document: z.unknown() }).strict().parse(request.body).document),
  );
  app.post('/owner/queries/review', async (request) => ({
    operation: querySchema.parse(request.body),
  }));
  app.get('/owner/projects/:projectKey', async (request) => {
    const p = await project(request.params);
    const tenants = await withAdmin((db) =>
      db.query(
        'SELECT tenant_id AS id,display_name AS name FROM core.tenants WHERE organization_id=$1 AND project_id=$2 ORDER BY tenant_id LIMIT 1000',
        [p.organizationId, p.projectId],
      ),
    );
    return { project: p, tenants: tenants.rows };
  });
  app.post('/owner/projects/:projectKey/identity', async (request) =>
    mutate(async () => {
      const p = await project(request.params);
      const input = projectInputSchema.parse(request.body);
      if (input.project.key !== p.key) throw new KnowledgeError('PROJECT_IDENTITY_CHANGED');
      // Identity editing does not replace independently managed business registrations.
      await configureProject(
        {
          ...input,
          project: {
            ...p,
            ...input.project,
            businessBridge: p.businessBridge,
            businessQueries: p.businessQueries,
            operations: p.operations,
          },
        },
        directory,
      );
      return { saved: true, restartRequired: true };
    }),
  );
  app.post('/owner/projects/:projectKey/business', async (request) =>
    mutate(async () => {
      const p = await project(request.params);
      const input = z
        .object({
          businessQueries: queriesSchema.optional(),
          businessBridge: bridgeSchema.optional(),
          dockerQueriesBaseUrl: queriesSchema.shape.baseUrl.optional(),
          dockerBridgeUrl: bridgeSchema.shape.url.optional(),
        })
        .strict()
        .parse(request.body);
      const files = [];
      for (const file of ['server.json', 'server.docker.json']) {
        const c = configSchema.parse(await json(file)),
          item = c.projects.find((v) => v.key === p.key)!;
        const docker = file === 'server.docker.json';
        if (input.businessQueries)
          item.businessQueries = {
            ...input.businessQueries,
            baseUrl: docker
              ? (input.dockerQueriesBaseUrl ??
                (input.businessQueries.baseUrl === p.businessQueries?.baseUrl
                  ? item.businessQueries?.baseUrl
                  : undefined) ??
                input.businessQueries.baseUrl)
              : input.businessQueries.baseUrl,
          };
        if (input.businessBridge)
          item.businessBridge = {
            ...input.businessBridge,
            url: docker
              ? (input.dockerBridgeUrl ??
                (input.businessBridge.url === p.businessBridge?.url ? item.businessBridge?.url : undefined) ??
                input.businessBridge.url)
              : input.businessBridge.url,
          };
        files.push({ file, data: configSchema.parse(c) });
      }
      for (const f of files) await atomicJson(resolve(directory, f.file), f.data);
      return { saved: true, restartRequired: true };
    }),
  );
  app.get('/owner/projects/:projectKey/cases', async (request) => {
    const p = await project(request.params);
    return withAdmin(async (db) => ({
      cases: (
        await db.query(
          'SELECT * FROM core.cases WHERE organization_id=$1 AND project_id=$2 ORDER BY updated_at DESC LIMIT 100',
          [p.organizationId, p.projectId],
        )
      ).rows.map((r) => ({ ...caseView(r), tenantId: r.tenant_id, subject: r.subject })),
    }));
  });
  const inCase = async <T>(
    params: unknown,
    fn: (
      db: InstanceType<typeof Pool>,
      scope: { organizationId: string; projectId: string; tenantId: string; subject: string },
      caseId: string,
    ) => Promise<T>,
  ) => {
    const p = await project(params),
      { caseId } = z.object({ caseId: id }).parse(params);
    const row = await withAdmin(
      async (db) =>
        (
          await db.query(
            'SELECT tenant_id,subject FROM core.cases WHERE id=$1 AND organization_id=$2 AND project_id=$3',
            [caseId, p.organizationId, p.projectId],
          )
        ).rows[0],
    );
    if (!row) throw new KnowledgeError('CASE_NOT_FOUND');
    const db = new Pool({
      connectionString: (await config()).databaseUrl,
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    try {
      return await fn(db, { ...p, tenantId: row.tenant_id, subject: row.subject }, caseId);
    } finally {
      await db.end();
    }
  };
  app.get('/owner/projects/:projectKey/cases/:caseId/messages', async (request) =>
    inCase(request.params, async (db, scope, caseId) => ({
      messages: await caseMessages(db, scope, caseId),
    })),
  );
  app.post('/owner/projects/:projectKey/cases/:caseId/messages', async (request) => {
    const input = messageInput.parse(request.body),
      key = id.parse(request.headers['idempotency-key']);
    return inCase(request.params, (db, scope, caseId) =>
      addCaseMessage(db, scope, caseId, 'support', input, key, request.id),
    );
  });
}
