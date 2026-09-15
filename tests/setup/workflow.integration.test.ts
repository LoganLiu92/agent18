import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from '@agent18/persistence';
import { KnowledgeIndexer, IndexedKnowledgeProvider } from '@agent18/knowledge';
import { buildSetupApp } from '../../apps/setup/src/app.js';
import { buildApp } from '../../apps/server/src/app.js';
import { readConfig, localDirectory, configSchema } from '../../scripts/config.js';

describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')(
  'owner installation workflow with PostgreSQL',
  () => {
    let directory: string,
      app: Awaited<ReturnType<typeof buildSetupApp>>,
      core: Awaited<ReturnType<typeof buildApp>>,
      pool: InstanceType<typeof Pool>,
      indexer: KnowledgeIndexer,
      service: IndexedKnowledgeProvider;
    const key = 'setup-' + crypto.randomUUID().slice(0, 8),
      projectId = crypto.randomUUID(),
      organizationId = crypto.randomUUID();
    const headers = {
      host: 'localhost:4321',
      origin: 'http://localhost:4321',
      authorization: 'Bearer integration-owner',
    };
    const scope = { organizationId, projectId, tenantId: 'customer-a', subject: 'setup-test' };
    const source = (id: string, audience: 'customer' | 'internal') => ({
      id,
      name: id,
      kind: 'directory',
      location: resolve(directory, 'docs'),
      include: ['**/*.md'],
      audience,
    });
    let buildId: string;
    beforeAll(async () => {
      directory = await mkdtemp(resolve(tmpdir(), 'agent18-setup-workflow-'));
      const original = { ...readConfig(), setupCompleted: false };
      for (const file of ['server.json', 'server.docker.json'])
        await writeFile(resolve(directory, file), JSON.stringify(original));
      for (const file of ['migration.json', 'indexer.json'])
        await copyFile(resolve(localDirectory, file), resolve(directory, file));
      await mkdir(resolve(directory, 'docs'));
      await writeFile(
        resolve(directory, 'docs', 'guide.md'),
        '# Setup canary\n\nA test-only guide for deterministic knowledge publication.',
      );
      app = await buildSetupApp({ directory, token: 'integration-owner', apply: async () => {} });
      pool = new Pool({
        connectionString: JSON.parse(await readFile(resolve(directory, 'indexer.json'), 'utf8')).databaseUrl,
      });
      indexer = new KnowledgeIndexer(pool, { ...scope, tenantId: 'operator' }, resolve(directory, 'cache'));
    });
    afterAll(async () => {
      await app?.close();
      await core?.app.close();
      if (indexer)
        for (const source of ['customer-guide', 'internal-guide'])
          await indexer.disable(source).catch(() => {});
      // Close the reader pool explicitly; only synthetic sources were created and they remain disabled.
      await readerPool?.end();
      await pool?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    let readerPool: InstanceType<typeof Pool> | undefined;
    it('registers an isolated project, public metadata and customer entries without exposing owner APIs', async () => {
      const existing = readConfig(),
        project = {
          ...existing.projects[0],
          key,
          projectId,
          organizationId,
          displayName: 'Test support',
          knowledge: 'indexed',
          businessBridge: undefined,
          allowedOrigins: ['https://saas.example'],
        };
      const response = await app.inject({
        method: 'POST',
        url: '/owner/project',
        headers,
        payload: {
          project,
          organizationName: 'Setup test',
          projectName: 'Setup test',
          tenants: [{ id: 'customer-a', name: 'Customer A' }],
        },
      });
      expect(response.json()).toEqual({ projectKey: key });
      const saved = configSchema.parse(JSON.parse(await readFile(resolve(directory, 'server.json'), 'utf8')));
      expect(saved.projects).toHaveLength(existing.projects.length + 1);
      core = await buildApp(saved, { dispatch: false });
      const metadata = await core.app.inject({ url: '/public/projects/' + key });
      expect(metadata.json()).toEqual({
        projectKey: key,
        displayName: 'Test support',
        allowedOrigins: ['https://saas.example'],
      });
      expect(metadata.body).not.toContain('jwks');
      expect((await core.app.inject({ url: '/public/installation' })).json()).toMatchObject({
        setupCompleted: false,
        version: '0.4.0',
      });
      expect((await core.app.inject({ url: '/public/projects/absent' })).statusCode).toBe(404);
      for (const url of ['/', '/console', '/support'])
        expect((await core.app.inject({ url })).statusCode).toBe(200);
      expect(
        (
          await core.app.inject({
            url: '/owner/state',
            headers: { authorization: 'Bearer integration-owner' },
          })
        ).statusCode,
      ).toBe(404);
      readerPool = new Pool({ connectionString: existing.databaseUrl });
      service = new IndexedKnowledgeProvider(readerPool);
    });
    it('builds drafts, previews and publishes them with audience filtering enforced by the runtime reader', async () => {
      const config = {
        projectKey: key,
        mode: 'extractive',
        sources: [source('customer-guide', 'customer'), source('internal-guide', 'internal')],
      };
      expect(
        (await app.inject({ method: 'POST', url: '/owner/knowledge', headers, payload: config })).json(),
      ).toEqual({ saved: true });
      const started = await app.inject({ method: 'POST', url: '/owner/build', headers, payload: {} });
      expect(started.statusCode).toBe(202);
      let state: { job: { state: string; results: { buildId: string }[] } };
      await expect
        .poll(
          async () => {
            state = (await app.inject({ url: '/owner/build', headers })).json();
            return state.job.state;
          },
          { timeout: 15000, interval: 100 },
        )
        .toBe('completed');
      const job = (await app.inject({ url: '/owner/build', headers })).json().job;
      expect(job.results).toHaveLength(2);
      buildId = job.results[0].buildId;
      expect((await service.catalogue(scope)).articles).toHaveLength(0);
      const preview = (await app.inject({ url: `/owner/build/${buildId}/articles`, headers })).json();
      expect(preview[0].title).toContain('Setup canary');
      expect(preview[0].refs[0].path).toBe('guide.md');
      for (const result of job.results)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/owner/publish',
              headers,
              payload: { buildId: result.buildId },
            })
          ).json().published,
        ).toBe(true);
      const visible = await service.catalogue(scope);
      expect(visible.articles).toHaveLength(1);
      expect(visible.articles[0]!.title).toContain('Setup canary');
      expect(
        (await service.catalogue({ ...scope, projectId: readConfig().projects[0]!.projectId })).articles.some(
          (a) => a.title.includes('Setup canary'),
        ),
      ).toBe(false);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/owner/publish',
            headers,
            payload: { buildId: crypto.randomUUID() },
          })
        ).statusCode,
      ).toBe(400);
    });
    it('changing a source audience withdraws it immediately and prevents publishing a stale policy', async () => {
      const changed = {
        projectKey: key,
        mode: 'extractive',
        sources: [source('customer-guide', 'internal'), source('internal-guide', 'internal')],
      };
      expect(
        (await app.inject({ method: 'POST', url: '/owner/knowledge', headers, payload: changed })).statusCode,
      ).toBe(200);
      expect((await service.catalogue(scope)).articles).toHaveLength(0);
      expect(
        (await app.inject({ method: 'POST', url: '/owner/publish', headers, payload: { buildId } })).json(),
      ).toEqual({ error: { code: 'BUILD_POLICY_CHANGED' } });
      await app.inject({
        method: 'POST',
        url: '/owner/knowledge',
        headers,
        payload: {
          ...changed,
          sources: [source('customer-guide', 'customer'), source('internal-guide', 'internal')],
        },
      });
      expect(
        (await app.inject({ method: 'POST', url: '/owner/publish', headers, payload: { buildId } })).json()
          .published,
      ).toBe(true);
    });
    it('removing a source from saved configuration withdraws its previously published knowledge', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/owner/knowledge',
        headers,
        payload: { projectKey: key, mode: 'extractive', sources: [source('internal-guide', 'internal')] },
      });
      expect(response.statusCode).toBe(200);
      expect((await service.catalogue(scope)).articles).toHaveLength(0);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/owner/apply',
            headers,
            payload: { displayName: 'Installed test' },
          })
        ).json(),
      ).toEqual({ saved: true, applied: true });
      expect(
        JSON.parse(await readFile(resolve(directory, 'server.docker.json'), 'utf8')).setupCompleted,
      ).toBe(true);
    });
  },
);
