import { referenceAnalytics, referenceAnalyticsConfig } from '../../examples/analytics-bridge/reference.js';
import { receiveDeployment } from '../../packages/application/src/deployment-feed.js';
import { TicketSyncRuntime, syncSignature } from '../../packages/application/src/ticket-sync.js';
import { referenceTicketBridge } from '../../examples/ticket-bridge/reference.js';
import type { Config } from '../../scripts/config.js';
import { ReportAutomation } from '../../packages/application/src/report-automation.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, scoped } from '@agent18/persistence';
import { KnowledgeIndexer, IndexedKnowledgeProvider, sourceSchema } from '@agent18/knowledge';
import { localDirectory, readConfig } from '../../scripts/config.js';
import { buildApp } from '../../apps/server/src/app.js';
import { buildSetupApp } from '../../apps/setup/src/app.js';
import { ConversationService, caseMessages, deleteCaseCapture } from '@agent18/application';
import { OperatorService, digest } from '../../apps/server/src/operators/service.js';
import { processGenerationJob } from '../../scripts/lib/knowledge-generation-worker.js';
import { processKnowledgeJob } from '../../scripts/lib/knowledge-worker.js';
import { privacyReplaySql } from '../../scripts/lib/privacy.js';
import { runRetention } from '../../scripts/lib/retention.js';
import { revokeRestoredOperatorSessions } from '../../scripts/lib/operator-restore.js';

describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')(
  'independent operator accounts in an isolated database',
  () => {
    const name = 'agent18_operator_test_' + randomBytes(6).toString('hex'),
      origin = 'http://127.0.0.1:14318';
    const password = 'Synthetic administrator passphrase ' + randomBytes(8).toString('hex');
    const staffPassword = 'Synthetic staff temporary passphrase ' + randomBytes(8).toString('hex');
    const permanentPassword = 'Synthetic staff permanent passphrase ' + randomBytes(8).toString('hex');
    let analyticsBridge: ReturnType<typeof referenceAnalytics>;
    const previousAnalyticsToken = process.env.AGENT18_ANALYTICS_REFERENCE;
    let syncBridge: ReturnType<typeof referenceTicketBridge>, runtimeConfig: Config;
    const syncSecret = 'isolated-ticket-sync-credential-20260920';
    let admin: InstanceType<typeof Pool>,
      db: InstanceType<typeof Pool>,
      app: Awaited<ReturnType<typeof buildApp>>,
      setup: Awaited<ReturnType<typeof buildSetupApp>>;
    let service: OperatorService,
      root: string,
      adminId: string,
      staffId: string,
      created = false;
    type Auth = { cookie: string; csrf: string };
    let owner: Auth, staff: Auth;
    const legacyBuilds = [randomUUID(), randomUUID()];
    const post = (url: string, payload: Record<string, unknown>, auth?: Auth) =>
      app.app.inject({
        method: 'POST',
        url,
        headers: { origin, ...(auth ? { cookie: auth.cookie, 'x-operator-csrf': auth.csrf } : {}) },
        payload,
      });
    async function login(username: string, pass: string) {
      const response = await post('/operator/login', { username, password: pass });
      expect(response.statusCode, response.body).toBe(200);
      const setCookie = String(response.headers['set-cookie']);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      const cookie = setCookie.split(';')[0]!;
      const state = await app.app.inject({ url: '/operator/session', headers: { cookie } });
      expect(state.statusCode).toBe(200);
      expect(state.json()).not.toHaveProperty('password_hash');
      return { cookie, csrf: state.json().csrf };
    }
    beforeAll(async () => {
      const migration = JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'));
      admin = new Pool({ connectionString: migration.adminDatabaseUrl });
      await admin.query(`CREATE DATABASE ${name}`);
      created = true;
      const adminUrl = new URL(migration.adminDatabaseUrl);
      adminUrl.pathname = '/' + name;
      db = new Pool({ connectionString: adminUrl.href });
      const client = await db.connect();
      try {
        await client.query(
          'CREATE TABLE public.agent18_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
        );
        for (const file of (await readdir('packages/persistence/migrations'))
          .filter((f) => f.endsWith('.sql'))
          .sort()) {
          await client.query('BEGIN');
          try {
            if (file === '016_knowledge_evidence.sql') {
              for (const [i, project] of readConfig().projects.slice(0, 2).entries()) {
                const source = randomUUID(),
                  article = randomUUID(),
                  build = legacyBuilds[i]!;
                await client.query(
                  `INSERT INTO knowledge.sources(id,organization_id,project_id,source_key,name,audience) VALUES($1,$2,$3,$4,'Legacy evidence fixture','internal')`,
                  [source, project.organizationId, project.projectId, 'legacy-' + source],
                );
                await client.query(
                  `INSERT INTO knowledge.builds(id,source_id,organization_id,project_id,revision,fingerprint,mode,state,report) VALUES($1,$2,$3,$4,'legacy-revision','legacy-fingerprint','extractive','ready',$5)`,
                  [
                    build,
                    source,
                    project.organizationId,
                    project.projectId,
                    JSON.stringify({ provenance: { snapshot: { observedAt: '2026-99-99T00:00:00Z' } } }),
                  ],
                );
                await client.query(
                  `INSERT INTO knowledge.articles(id,build_id,source_id,organization_id,project_id,title,body,category,tokens,refs,revision) VALUES($1,$2,$3,$4,$5,'Legacy guide','Historical unchanged body','overview','{}',$6,'legacy-revision')`,
                  [
                    article,
                    build,
                    source,
                    project.organizationId,
                    project.projectId,
                    JSON.stringify([
                      { path: 'old-guide.md', startLine: 1, endLine: 3, revision: 'legacy-revision' },
                      { path: 'bad.md', startLine: 9, endLine: 1 },
                      { path: 'different.md', startLine: 1, endLine: 2, revision: 'wrong-revision' },
                      { path: 'foreign.md', startLine: 1, endLine: 2, sourceId: randomUUID() },
                      null,
                      { path: 'large.md', startLine: '999999999999999', endLine: '999999999999999' },
                    ]),
                  ],
                );
              }
            }
            await client.query(await readFile(resolve('packages/persistence/migrations', file), 'utf8'));
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          }
        }
      } finally {
        client.release();
      }
      const config = readConfig(),
        appUrl = new URL(config.databaseUrl);
      appUrl.pathname = '/' + name;
      config.databaseUrl = appUrl.href;
      config.consoleOrigin = origin;
      const syncProject = config.projects.find((p) => p.key === 'invoice-demo')!;
      syncBridge = referenceTicketBridge(syncSecret, syncProject);
      await new Promise<void>((r) => syncBridge.server.listen(0, '127.0.0.1', r));
      syncProject.ticketSync = {
        enabled: true,
        url: 'http://127.0.0.1:' + (syncBridge.server.address() as { port: number }).port + '/events',
        credentialEnv: 'AGENT18_SYNC_TEST',
        tenantIds: ['aurora'],
      };
      analyticsBridge = referenceAnalytics('synthetic-analytics-service-token', syncProject);
      await new Promise<void>((r) => analyticsBridge.server.listen(0, '127.0.0.1', r));
      syncProject.analytics = referenceAnalyticsConfig(
        'http://127.0.0.1:' + (analyticsBridge.server.address() as { port: number }).port,
      );
      process.env.AGENT18_ANALYTICS_REFERENCE = 'synthetic-analytics-service-token';
      runtimeConfig = config;
      app = await buildApp(config, { dispatch: false });
      service = new OperatorService(app.db, config);
      root = await mkdtemp(join(tmpdir(), 'agent18-operator-setup-'));
      await writeFile(join(root, 'server.json'), JSON.stringify(config), { mode: 0o600 });
      setup = await buildSetupApp({ directory: root, token: 'synthetic-owner-bootstrap-access' });
    });
    afterAll(async () => {
      if (syncBridge) {
        await new Promise<void>((r) => syncBridge.server.close(() => r()));
        syncBridge.db.close();
      }
      if (analyticsBridge) {
        await new Promise<void>((r) => analyticsBridge.server.close(() => r()));
        analyticsBridge.db.close();
      }
      if (previousAnalyticsToken === undefined) delete process.env.AGENT18_ANALYTICS_REFERENCE;
      else process.env.AGENT18_ANALYTICS_REFERENCE = previousAnalyticsToken;
      await setup?.close();
      await app?.app.close();
      await db?.end();
      // pg-pool resolves end() before every socket has finished closing. A forced
      // drop can kill those closing clients and emit an unhandled 57P01 error.
      // A normal drop lets PostgreSQL wait for them and still exposes real leaks.
      if (created) await admin.query(`DROP DATABASE ${name}`);
      await admin?.end();
      if (root) await rm(root, { recursive: true, force: true });
    });
    it('requires the local Owner gate for one-time administrator bootstrap', async () => {
      const payload = { username: 'administrator', displayName: 'Administrator', password };
      const denied = await setup.inject({
        method: 'POST',
        url: '/owner/operators/bootstrap',
        headers: { host: 'localhost:4321' },
        payload,
      });
      expect(denied.statusCode).toBe(401);
      const headers = {
        host: 'localhost:4321',
        origin: 'http://localhost:4321',
        authorization: 'Bearer synthetic-owner-bootstrap-access',
      };
      const result = await setup.inject({
        method: 'POST',
        url: '/owner/operators/bootstrap',
        headers,
        payload,
      });
      expect(result.statusCode, result.body).toBe(200);
      adminId = result.json().id;
      await expect(service.bootstrap(payload, 'repeat')).rejects.toMatchObject({
        code: 'OPERATOR_ALREADY_INITIALIZED',
      });
      expect(
        (await db.query('SELECT password_hash FROM control.operator_accounts')).rows[0].password_hash,
      ).not.toContain(password);
    });
    it('separates customer credentials and rejects foreign-origin writes and missing CSRF', async () => {
      expect(
        (
          await app.app.inject({
            url: '/operator/session',
            headers: { authorization: 'Bearer customer-token' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.app.inject({
            method: 'POST',
            url: '/operator/login',
            headers: { origin: 'https://hostile.example' },
            payload: { username: 'administrator', password },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await post('/operator/login', { username: 'administrator', password: 'wrong' })).json().error.code,
      ).toBe('OPERATOR_LOGIN_FAILED');
      expect(
        (await post('/operator/login', { username: 'nonexistent', password: 'wrong' })).json().error.code,
      ).toBe('OPERATOR_LOGIN_FAILED');
      owner = await login('administrator', password);
      expect(
        (
          await app.app.inject({
            method: 'POST',
            url: '/operator/logout',
            headers: { origin, cookie: owner.cookie },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.app.inject({
            url: '/api/session',
            headers: { cookie: owner.cookie, 'x-project-key': 'invoice-demo' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.app.inject({
            url: '/operator/session',
            headers: { cookie: owner.cookie, origin: 'https://hostile.example' },
          })
        ).statusCode,
      ).toBe(403);
    });
    it('creates a staff account with no implicit project access and forces initial password change', async () => {
      const created = await post(
        '/operator/accounts',
        { username: 'staff', displayName: 'Knowledge editor', password: staffPassword },
        owner,
      );
      expect(created.statusCode, created.body).toBe(200);
      staffId = created.json().id;
      const updated = await post(
        '/operator/accounts/' + staffId,
        {
          enabled: true,
          administrator: false,
          memberships: [{ projectKey: 'invoice-demo', roles: ['knowledge_editor'] }],
        },
        owner,
      );
      expect(updated.statusCode, updated.body).toBe(200);
      staff = await login('staff', staffPassword);
      const session = await app.app.inject({ url: '/operator/session', headers: { cookie: staff.cookie } });
      expect(session.json().account.mustChangePassword).toBe(true);
      expect(session.json().projects).toEqual([]);
      expect(
        (await app.app.inject({ url: '/operator/projects/invoice-demo', headers: { cookie: staff.cookie } }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await post(
            '/operator/password',
            { currentPassword: staffPassword, password: permanentPassword },
            staff,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.app.inject({ url: '/operator/session', headers: { cookie: staff.cookie } })).statusCode,
      ).toBe(401);
      staff = await login('staff', permanentPassword);
    });
    it('enforces project and capability grants without granting account or publishing access', async () => {
      expect(
        (await app.app.inject({ url: '/operator/projects/invoice-demo', headers: { cookie: staff.cookie } }))
          .statusCode,
      ).toBe(200);
      expect(
        (await app.app.inject({ url: '/operator/projects/other-demo', headers: { cookie: staff.cookie } }))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.app.inject({ url: '/operator/accounts', headers: { cookie: staff.cookie } })).statusCode,
      ).toBe(403);
      expect(
        (
          await post(
            '/operator/accounts',
            { username: 'intruder', displayName: 'Unauthorized', password: staffPassword },
            staff,
          )
        ).statusCode,
      ).toBe(403);
      const s = await service.session(staff.cookie.split('=')[1]!);
      await expect(service.authorize(s, 'invoice-demo', 'knowledge_editor')).resolves.toMatchObject({
        key: 'invoice-demo',
      });
      await expect(service.authorize(s, 'invoice-demo', 'knowledge_publisher')).rejects.toMatchObject({
        code: 'OPERATOR_FORBIDDEN',
      });
      await expect(
        service.withPermission(s, 'invoice-demo', 'knowledge.edit', async (_client, p) => p.key),
      ).resolves.toBe('invoice-demo');
      for (const permission of ['knowledge.publish', 'source.configure'] as const)
        await expect(
          service.withPermission(s, 'invoice-demo', permission, async () => true),
        ).rejects.toMatchObject({ code: 'OPERATOR_FORBIDDEN' });
    });
    it('persists knowledge review and publication while isolating drafts, projects and customer visibility', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const get = (path: string, auth = owner) =>
        app.app.inject({ url: path, headers: { cookie: auth.cookie } });
      expect((await get(base)).statusCode).toBe(200);
      expect((await get('/operator/projects/other-demo/knowledge', staff)).statusCode).toBe(403);
      const project = readConfig().projects.find((p) => p.key === 'invoice-demo')!;
      const scope = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        tenantId: 'aurora',
        subject: 'alice',
      };
      const provider = new IndexedKnowledgeProvider(app.db);
      const draft = {
        title: 'Exchange rate troubleshooting',
        body: 'Set the exchange rate before submitting an invoice.',
        category: 'troubleshooting',
        audience: 'customer',
      };
      const rejected = await post(base + '/documents', { ...draft, title: 'sk-' + 'a'.repeat(30) }, staff);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe('KNOWLEDGE_SECRET_DETECTED');
      const created = await post(base + '/documents', draft, staff);
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id,
        path = base + '/documents/' + id;
      expect((await get(path)).json()).toMatchObject({ ...draft, state: 'draft', version: 1 });
      expect((await provider.catalogue(scope)).articles).toEqual([]);
      expect(
        (await scoped(app.db, scope, (c) => c.query('SELECT * FROM knowledge.documents'))).rowCount,
      ).toBe(0);
      expect((await get('/operator/projects/other-demo/knowledge/documents/' + id)).statusCode).toBe(404);
      expect((await post(path, { version: 1, action: 'approve' }, staff)).statusCode).toBe(403);
      expect((await post(path, { version: 1, action: 'publish' }, owner)).statusCode).toBe(409);
      expect((await post(path, { version: 1, action: 'submit' }, staff)).statusCode).toBe(200);
      expect((await post(path, { version: 1, action: 'save', content: draft }, staff)).statusCode).toBe(409);
      expect((await post(path, { version: 2, action: 'approve' }, owner)).statusCode).toBe(200);
      expect((await post(path, { version: 3, action: 'publish' }, staff)).statusCode).toBe(403);
      const published = await post(path, { version: 3, action: 'publish' }, owner);
      expect(published.statusCode, published.body).toBe(200);
      const first = (await provider.catalogue(scope)).articles[0]!;
      expect(first.title).toBe(draft.title);
      expect((await provider.article(scope, first.id))?.body).toBe(draft.body);
      const internal = {
        ...draft,
        body: 'Updated customer instructions for the next revision.',
        audience: 'customer',
      };
      expect((await post(path, { version: 4, action: 'save', content: internal }, staff)).statusCode).toBe(
        200,
      );
      // Editing a draft must not replace or hide the previously published customer version.
      expect((await provider.article(scope, first.id))?.body).toBe(draft.body);
      expect((await post(path, { version: 5, action: 'submit' }, staff)).statusCode).toBe(200);
      expect((await post(path, { version: 6, action: 'approve' }, owner)).statusCode).toBe(200);
      expect((await post(path, { version: 7, action: 'publish' }, owner)).statusCode).toBe(200);
      expect((await provider.catalogue(scope)).articles).toHaveLength(1);
      expect(await provider.article(scope, first.id)).toBeNull();
      const operator = (await get(base)).json();
      expect(operator.counts.articles).toBe(1);
      expect(operator.articles[0].audience).toBe('customer');
      expect((await get(base + '/articles/' + operator.articles[0].id)).json().body).toBe(internal.body);
      expect((await post(path, { version: 8, action: 'revoke' }, owner)).statusCode).toBe(200);
      expect((await get(base)).json().counts.articles).toBe(0);
      expect((await get(path)).json().history).toHaveLength(9);
      // Customer pool reuse cannot inherit the operator RLS session or read build history.
      expect((await scoped(app.db, scope, (c) => c.query('SELECT * FROM knowledge.builds'))).rowCount).toBe(
        0,
      );
      expect(
        (await scoped(app.db, scope, (c) => c.query('SELECT * FROM knowledge.document_history'))).rowCount,
      ).toBe(0);
      const audit = (await get('/operator/audit?targetId=' + id)).json().events;
      expect(audit.some((e: { action: string }) => e.action === 'knowledge.publish')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(draft.body);
      const revision = await get(path + '/revisions/1', staff);
      expect(revision.statusCode).toBe(200);
      expect(revision.json().snapshot).toEqual(draft);
      expect(
        (await get('/operator/projects/other-demo/knowledge/documents/' + id + '/revisions/1')).statusCode,
      ).toBe(404);
      expect((await post(path, { version: 9, action: 'restore', fromVersion: 1 }, staff)).statusCode).toBe(
        200,
      );
      expect((await get(path)).json()).toMatchObject({ ...draft, version: 10, state: 'draft' });
      expect((await post(path, { version: 10, action: 'submit' }, staff)).statusCode).toBe(200);
      expect((await post(path, { version: 11, action: 'return' }, owner)).statusCode).toBe(400);
      expect(
        (await post(path, { version: 11, action: 'return', reason: '请补充适用前提和业务依据。' }, staff))
          .statusCode,
      ).toBe(403);
      expect(
        (await post(path, { version: 11, action: 'return', reason: '请补充适用前提和业务依据。' }, owner))
          .statusCode,
      ).toBe(200);
      const returned = (await get(path)).json();
      expect(returned.state).toBe('draft');
      expect(returned.history[0].reason).toBe('请补充适用前提和业务依据。');
      expect((await get(path + '/revisions/1')).json().snapshot).toEqual(draft);
      expect((await provider.catalogue(scope)).articles).toEqual([]);
      await expect(app.db.query('DELETE FROM knowledge.document_history')).rejects.toMatchObject({
        code: '42501',
      });
    });
    it('runs persisted source scans through the restricted indexer and preserves evidence into reviewed documents', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const get = (path: string, auth = owner) =>
        app.app.inject({ url: path, headers: { cookie: auth.cookie } });
      const input = {
        source: {
          id: 'scan-guide',
          name: '扫描验收资料',
          kind: 'directory',
          location: root,
          include: ['guide.md'],
          audience: 'internal',
        },
        mode: 'extractive',
      };
      await writeFile(
        join(root, 'guide.md'),
        '# 汇率配置说明\n\n提交外币发票前，需要配置对应业务日期的汇率。此说明仅用于隔离验收。',
      );
      expect((await post(base + '/connections', input, staff)).statusCode).toBe(403);
      const created = await post(base + '/connections', input, owner);
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json().state).toBe('queued');
      const id = created.json().id;
      expect((await post(base + '/connections', input, owner)).statusCode).toBe(409);
      const indexerConfig = JSON.parse(await readFile(resolve(localDirectory, 'indexer.json'), 'utf8'));
      const url = new URL(indexerConfig.databaseUrl);
      url.pathname = '/' + name;
      const indexDb = new Pool({ connectionString: url.href });
      try {
        const options = { roots: [] as string[], gitHosts: [], cacheDirectory: join(root, 'git-cache') };
        expect(await processKnowledgeJob(indexDb, readConfig(), options)).toBe(true);
        let connection = (await get(base + '/connections')).json().connections[0];
        expect(connection).toMatchObject({ state: 'failed', error_code: 'SOURCE_ROOT_NOT_ALLOWED' });
        expect((await post(base + '/connections/' + id + '/scan', {}, owner)).statusCode).toBe(200);
        expect(await processKnowledgeJob(indexDb, readConfig(), { ...options, roots: [root] })).toBe(true);
        connection = (await get(base + '/connections')).json().connections[0];
        expect(connection).toMatchObject({ state: 'succeeded', error_code: null });
        const build = (await get(base + '/builds/' + connection.build_id, staff)).json();
        expect(build.files).toBe(1);
        expect(build.articles).toHaveLength(1);
        expect(build.articles[0].refs[0].path).toBe('guide.md');
        expect(
          (await get('/operator/projects/other-demo/knowledge/builds/' + connection.build_id)).statusCode,
        ).toBe(404);
        const project = readConfig().projects.find((p) => p.key === 'invoice-demo')!;
        const scope = { ...project, tenantId: 'aurora', subject: 'alice' };
        expect((await new IndexedKnowledgeProvider(app.db).catalogue(scope)).articles).toEqual([]);
        const imported = await post(base + '/articles/' + build.articles[0].id + '/draft', {}, staff);
        expect(imported.statusCode, imported.body).toBe(200);
        const document = imported.json().id,
          path = base + '/documents/' + document;
        expect((await post(base + '/articles/' + build.articles[0].id + '/draft', {}, staff)).json().id).toBe(
          document,
        );
        expect((await get(path)).json().evidence[0].path).toBe('guide.md');
        expect((await post(path, { version: 1, action: 'submit' }, staff)).statusCode).toBe(200);
        expect((await post(path, { version: 2, action: 'approve' }, owner)).statusCode).toBe(200);
        expect((await post(path, { version: 3, action: 'publish' }, owner)).statusCode).toBe(200);
        const library = (await get(base)).json();
        const article = library.articles.find((a: { title: string }) => a.title === build.articles[0].title);
        expect((await get(base + '/articles/' + article.id)).json().refs[0].path).toBe('guide.md');
        const importedDoc = (await get(path)).json();
        const customerDraft = await post(
          path + '/customer-draft',
          {
            version: 4,
            title: '外币发票汇率配置说明',
            body: importedDoc.body,
            category: importedDoc.category,
          },
          staff,
        );
        expect(customerDraft.statusCode, customerDraft.body).toBe(200);
        const customerPath = base + '/documents/' + customerDraft.json().id;
        for (const [version, action] of [
          [1, 'submit'],
          [2, 'approve'],
          [3, 'publish'],
        ] as const)
          expect((await post(customerPath, { version, action }, owner)).statusCode).toBe(200);
        expect((await get(path)).json()).toMatchObject({
          audience: 'internal',
          version: 4,
          state: 'published',
        });
        const customer = new IndexedKnowledgeProvider(app.db);
        const published = (await customer.catalogue(scope)).articles.find(
          (a) => a.title === '外币发票汇率配置说明',
        )!;
        const customerArticle = await customer.article(scope, published.id);
        expect(customerArticle?.references).toEqual([]);
        expect(customerArticle?.version).toMatch(/^publication-/);
        expect(JSON.stringify(customerArticle)).not.toContain('guide.md');
        expect((await get(base + '/articles/' + published.id)).json().refs[0].path).toBe('guide.md');
        const indexer = new KnowledgeIndexer(indexDb, scope, options.cacheDirectory);
        expect(await indexer.activeSourceKeys()).not.toContain('scan-guide');
        expect((await post(base + '/connections/' + id + '/scan', {}, owner)).statusCode).toBe(200);
        connection = (await get(base + '/connections')).json().connections[0];
        expect((await post(base + '/jobs/' + connection.job_id + '/cancel', {}, owner)).statusCode).toBe(200);
        expect(await processKnowledgeJob(indexDb, readConfig(), { ...options, roots: [root] })).toBe(false);
      } finally {
        await indexDb.end();
      }
    });
    it('persists confirmed topics and coverage without confusing drafts with publications', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const get = (path: string, auth = staff) =>
        app.app.inject({ url: path, headers: { cookie: auth.cookie } });
      const value = {
        domain: 'Invoice',
        title: 'Submitting invoices',
        description: 'Confirmed product scope',
        state: 'candidate',
        requiredCategories: ['workflows', 'api'],
      };
      const created = await post(base + '/topics', value, staff);
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id,
        path = base + '/topics/' + id;
      expect((await get(base + '/topics')).json().topics[0]).toMatchObject({
        id,
        state: 'candidate',
        version: 1,
        document_count: 0,
      });
      expect((await get('/operator/projects/other-demo/knowledge/topics/' + id, owner)).statusCode).toBe(404);
      expect((await get('/operator/projects/other-demo/knowledge/topics', staff)).statusCode).toBe(403);
      const doc = {
        title: 'Topic guide',
        body: 'Create an invoice, check its fields and submit it.',
        category: 'workflows',
        audience: 'customer',
      };
      const docId = (await post(base + '/documents', doc, staff)).json().id;
      const foreignId = (await post('/operator/projects/other-demo/knowledge/documents', doc, owner)).json()
        .id;
      expect(
        (await post(path, { action: 'link', version: 1, documentId: foreignId }, owner)).statusCode,
      ).toBe(404);
      expect((await post(path, { action: 'link', version: 1, documentId: docId }, staff)).statusCode).toBe(
        200,
      );
      expect((await post(path, { action: 'save', version: 1, content: value }, staff)).statusCode).toBe(409);
      expect(
        (await post(path, { action: 'save', version: 2, content: { ...value, state: 'confirmed' } }, staff))
          .statusCode,
      ).toBe(200);
      let detail = (await get(path)).json();
      expect(detail).toMatchObject({ state: 'confirmed', version: 3 });
      expect(detail.coverage).toContainEqual({ category: 'workflows', internal: false, customer: false });
      const docPath = base + '/documents/' + docId;
      for (const [version, action] of [
        [1, 'submit'],
        [2, 'approve'],
        [3, 'publish'],
      ] as const)
        expect((await post(docPath, { version, action }, owner)).statusCode).toBe(200);
      expect(
        (await post(docPath, { version: 4, action: 'save', content: { ...doc, category: 'api' } }, staff))
          .statusCode,
      ).toBe(200);
      detail = (await get(path)).json();
      expect(detail.coverage).toContainEqual({ category: 'workflows', internal: false, customer: true });
      expect(detail.coverage).toContainEqual({ category: 'api', internal: false, customer: false });
      expect(detail.documents[0]).toMatchObject({
        id: docId,
        category: 'api',
        audience: 'customer',
        state: 'draft',
        published_category: 'workflows',
        published_audience: 'customer',
      });
      const otherDoc = (
        await post(
          base + '/documents',
          { ...doc, title: 'Business policy supplement', audience: 'internal' },
          staff,
        )
      ).json();
      expect(
        (await post(path, { action: 'link', version: 3, documentId: otherDoc.id }, staff)).statusCode,
      ).toBe(200);
      expect((await get(path)).json().documents).toHaveLength(2);
      expect((await post(docPath, { version: 5, action: 'revoke' }, owner)).statusCode).toBe(200);
      expect((await get(path)).json().coverage).toContainEqual({
        category: 'workflows',
        internal: false,
        customer: false,
      });
      expect((await post(path, { action: 'unlink', version: 4, documentId: docId }, staff)).statusCode).toBe(
        200,
      );
      expect((await get(path)).json().documents).toHaveLength(1);
      expect((await get(docPath)).statusCode).toBe(200);
      const project = readConfig().projects.find((p) => p.key === 'invoice-demo')!;
      const scope = { ...project, tenantId: 'aurora', subject: 'alice' };
      expect((await scoped(app.db, scope, (c) => c.query('SELECT * FROM knowledge.topics'))).rowCount).toBe(
        0,
      );
      expect(
        (await scoped(app.db, scope, (c) => c.query('SELECT * FROM knowledge.topic_documents'))).rowCount,
      ).toBe(0);
      await expect(
        scoped(app.db, scope, (c) =>
          c.query(
            `INSERT INTO knowledge.topics(id,organization_id,project_id,domain,title,updated_by) VALUES(gen_random_uuid(),$1,$2,'Denied','Customer topic',$3)`,
            [project.organizationId, project.projectId, adminId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        db.query(
          `INSERT INTO knowledge.topic_documents(topic_id,document_id,organization_id,project_id,linked_by) VALUES($1,$2,$3,$4,$5)`,
          [id, foreignId, project.organizationId, project.projectId, adminId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      expect(
        (await get('/operator/audit?targetId=' + id, owner))
          .json()
          .events.some((e: { action: string }) => e.action === 'knowledge.topic.link'),
      ).toBe(true);
    });
    it('backfills legacy evidence without inventing provenance or changing publication and is idempotent', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const get = (path: string) => app.app.inject({ url: path, headers: { cookie: staff.cookie } });
      const snapshot = await get(base + '/snapshots/' + legacyBuilds[0]);
      expect(snapshot.statusCode, snapshot.body).toBe(200);
      expect(snapshot.json()).toMatchObject({
        id: legacyBuilds[0],
        observed_at: null,
        provenance_state: 'legacy',
        active_build_id: null,
        reference_count: 6,
        evidence_count: 1,
        deployment: { status: 'unknown', revision: null },
      });
      expect(snapshot.json().evidence[0]).toMatchObject({
        path: 'old-guide.md',
        start_line: 1,
        end_line: 3,
        content_hash: null,
        provenance_state: 'legacy',
      });
      await db.query('SELECT knowledge.capture_build_evidence($1)', [legacyBuilds[0]]);
      expect((await get(base + '/snapshots/' + legacyBuilds[0])).json().evidence).toEqual(
        snapshot.json().evidence,
      );
      expect(
        (await db.query('SELECT body FROM knowledge.articles WHERE build_id=$1', [legacyBuilds[0]])).rows[0]
          .body,
      ).toBe('Historical unchanged body');
      await expect(
        app.db.query('SELECT knowledge.capture_build_evidence($1)', [legacyBuilds[0]]),
      ).rejects.toMatchObject({ code: '42501' });
      for (const table of ['source_snapshots', 'source_evidence']) {
        await expect(
          app.db.query(`UPDATE knowledge.${table} SET provenance_state='legacy'`),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });
    it('links independent multi-source evidence with explicit relation, review and project isolation', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const get = (path: string, auth = staff) =>
        app.app.inject({ url: path, headers: { cookie: auth.cookie } });
      const snapshots = (await get(base + '/snapshots')).json();
      const scanned = snapshots.snapshots.find((s: { name: string }) => s.name === '扫描验收资料');
      const current = (await get(base + '/snapshots/' + scanned.id)).json();
      expect(current).toMatchObject({ provenance_state: 'recorded', evidence_count: 1 });
      expect(current.observed_at).not.toBeNull();
      expect(current.evidence[0].content_hash).toMatch(/^[a-f0-9]{64}$/);
      const legacy = (await get(base + '/snapshots/' + legacyBuilds[0])).json().evidence[0];
      const foreign = (
        await get('/operator/projects/other-demo/knowledge/snapshots/' + legacyBuilds[1], owner)
      ).json().evidence[0];
      expect((await get(base + '/snapshots/' + legacyBuilds[1], owner)).statusCode).toBe(404);
      const topic = (
        await post(
          base + '/topics',
          {
            domain: 'Evidence',
            title: 'Invoice evidence',
            description: 'Source relationship test',
            state: 'candidate',
            requiredCategories: ['overview'],
          },
          staff,
        )
      ).json();
      const path = base + '/topics/' + topic.id;
      const link = {
        action: 'evidence-link',
        version: 1,
        evidenceId: current.evidence[0].id,
        relation: 'supports',
        note: '支持汇率配置前置条件，部署行为尚未验证。',
        confirmed: true,
      };
      expect((await post(path, { ...link, evidenceId: foreign.id }, owner)).statusCode).toBe(404);
      expect((await post(path, link, staff)).statusCode).toBe(200);
      expect((await post(path, { ...link, version: 2 }, staff)).statusCode).toBe(409);
      expect(
        (
          await post(
            path,
            {
              ...link,
              version: 2,
              evidenceId: legacy.id,
              relation: 'contradicts',
              note: '旧说明可能不同，待确认适用版本。',
              confirmed: false,
            },
            staff,
          )
        ).statusCode,
      ).toBe(200);
      let detail = (await get(path)).json();
      expect(detail.evidence).toHaveLength(2);
      expect(detail.evidence.find((e: { id: string }) => e.id === legacy.id)).toMatchObject({
        relation: 'contradicts',
        confirmed: false,
        observed_at: null,
      });
      expect(detail.evidence.find((e: { id: string }) => e.id === current.evidence[0].id)).toMatchObject({
        relation: 'supports',
        confirmed: true,
      });
      expect(detail.documents).toEqual([]); // A topic can have evidence before any draft exists.
      expect(
        (await post(path, { action: 'evidence-unlink', evidenceId: legacy.id, version: 3 }, staff))
          .statusCode,
      ).toBe(200);
      detail = (await get(path)).json();
      expect(detail.evidence).toHaveLength(1);
      expect((await get(base + '/snapshots/' + legacyBuilds[0])).json().evidence).toHaveLength(1);
      const project = readConfig().projects.find((p) => p.key === 'invoice-demo')!;
      const scope = { ...project, tenantId: 'aurora', subject: 'alice' };
      for (const table of ['source_snapshots', 'source_evidence', 'topic_evidence'])
        expect(
          (await scoped(app.db, scope, (c) => c.query(`SELECT * FROM knowledge.${table}`))).rowCount,
        ).toBe(0);
      await expect(
        db.query(
          `INSERT INTO knowledge.topic_evidence(topic_id,evidence_id,organization_id,project_id,relation,note,linked_by) VALUES($1,$2,$3,$4,'context','Cross project denied',$5)`,
          [topic.id, foreign.id, project.organizationId, project.projectId, adminId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      expect(
        (await get('/operator/audit?targetId=' + topic.id, owner))
          .json()
          .events.some((e: { action: string }) => e.action === 'knowledge.topic.evidence-link'),
      ).toBe(true);
    });
    it('retains exact source text, queues bounded generation and imports separate reviewed customer documents', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const get = (path: string, auth = staff) =>
        app.app.inject({ url: path, headers: { cookie: auth.cookie } });
      const snapshots = (await get(base + '/snapshots')).json().snapshots;
      const snapshot = snapshots.find((v: { name: string }) => v.name === '扫描验收资料');
      const evidence = (await get(base + '/snapshots/' + snapshot.id)).json().evidence[0];
      const text = (await get(base + '/evidence/' + evidence.id + '/content')).json();
      expect(text).toMatchObject({ status: 'verified', path: 'guide.md' });
      expect(text.body).toContain('配置对应业务日期的汇率');
      await writeFile(
        join(root, 'guide.md'),
        '# Changed current working tree\nThe historical snapshot must remain unchanged.',
      );
      expect((await get(base + '/evidence/' + evidence.id + '/content')).json().body).toBe(text.body);
      const old = (await get(base + '/snapshots/' + legacyBuilds[0])).json().evidence[0];
      expect((await get(base + '/evidence/' + old.id + '/content')).json()).toMatchObject({
        status: 'unavailable',
        body: null,
      });
      expect(
        (await get('/operator/projects/other-demo/knowledge/evidence/' + evidence.id + '/content', owner))
          .statusCode,
      ).toBe(404);
      const topicContent = {
        domain: 'Generation',
        title: '汇率配置',
        description: '核对汇率前置条件',
        state: 'confirmed',
        requiredCategories: ['overview', 'workflows'],
      };
      const topic = (await post(base + '/topics', topicContent, staff)).json();
      const path = base + '/topics/' + topic.id;
      expect(
        (
          await post(
            path,
            {
              version: 1,
              action: 'evidence-link',
              evidenceId: evidence.id,
              relation: 'supports',
              note: '已核对固定原文，部署状态未知',
              confirmed: true,
            },
            staff,
          )
        ).statusCode,
      ).toBe(200);
      const request = { version: 2, categories: ['overview', 'workflows'], evidenceIds: [evidence.id] };
      const queued = await post(path + '/generate', request, staff);
      expect(queued.statusCode, queued.body).toBe(200);
      const id = queued.json().id;
      expect((await post(path + '/generate', request, staff)).json().id).toBe(id);
      const url = new URL(
        JSON.parse(await readFile(resolve(localDirectory, 'indexer.json'), 'utf8')).databaseUrl,
      );
      url.pathname = '/' + name;
      const indexDb = new Pool({ connectionString: url.href });
      try {
        const model = {
          identity: 'synthetic-generation-model',
          name: 'test-only',
          complete: async () => ({
            tokens: 80,
            value: {
              articles: [
                {
                  title: '汇率配置概述',
                  body: '提交外币发票前，需要配置对应业务日期的汇率。实际线上部署行为仍需验证。',
                  category: 'overview',
                  evidenceIds: [evidence.id],
                },
                {
                  title: '提交前检查',
                  body: '提交前核对业务日期及对应汇率。缺少证据的办理方式须向管理员确认。',
                  category: 'workflows',
                  evidenceIds: [evidence.id],
                },
              ],
              gaps: ['缺少部署版本与生产行为证据'],
            },
          }),
        };
        expect(await processGenerationJob(indexDb, readConfig(), { model })).toBe(true);
        const job = (await get(base + '/generations/' + id)).json();
        expect(job.state).toBe('succeeded');
        expect(job.result.calls).toBe(1);
        expect(job.imported).toEqual([]);
        expect(
          (await get('/operator/projects/other-demo/knowledge/generations/' + id, owner)).statusCode,
        ).toBe(404);
        const imported = await post(base + '/generations/' + id + '/import', { index: 0 }, staff);
        expect(imported.statusCode, imported.body).toBe(200);
        expect((await post(base + '/generations/' + id + '/import', { index: 0 }, staff)).json().id).toBe(
          imported.json().id,
        );
        const docPath = base + '/documents/' + imported.json().id;
        const beforeFreshness = await get(docPath + '/freshness');
        expect(beforeFreshness.json()).toMatchObject({ changed: 0, unknown: 0 });
        const freshProject = readConfig().projects.find((p) => p.key === 'invoice-demo')!;
        const freshScope = { ...freshProject, tenantId: 'operator', subject: 'freshness-test' };
        await new KnowledgeIndexer(indexDb, freshScope, join(root, 'git-cache')).sync(
          sourceSchema.parse({
            id: 'scan-guide',
            name: '扫描验收资料',
            kind: 'directory',
            location: root,
            include: ['guide.md'],
            audience: 'internal',
          }),
          { mode: 'extractive', maxModelCalls: 0 },
        );
        expect((await get(docPath + '/freshness')).json()).toMatchObject({
          changed: 1,
          unknown: 0,
          deployment: { status: 'unknown' },
        });
        expect((await get(base + '/evidence/' + evidence.id + '/content')).json().body).toBe(text.body);

        expect((await get(docPath)).json()).toMatchObject({
          state: 'draft',
          audience: 'internal',
          generation_job_id: id,
        });
        expect(
          (
            await post(
              docPath + '/customer-draft',
              {
                version: 1,
                title: '客户说明',
                body: '客户需要先配置业务日期对应的汇率。',
                category: 'overview',
              },
              staff,
            )
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await post(
              docPath,
              {
                version: 1,
                action: 'save',
                content: {
                  title: '客户说明',
                  body: '客户需要先配置业务日期对应的汇率。',
                  category: 'overview',
                  audience: 'customer',
                },
              },
              staff,
            )
          ).statusCode,
        ).toBe(409);
        expect((await post(docPath, { version: 1, action: 'submit' }, staff)).statusCode).toBe(200);
        expect((await post(docPath, { version: 2, action: 'approve' }, owner)).statusCode).toBe(200);
        const payload = {
          version: 3,
          title: '如何准备外币发票',
          body: '提交外币发票前，请确认业务日期对应的汇率已配置。',
          category: 'workflows',
        };
        const derived = await post(docPath + '/customer-draft', payload, staff);
        expect(derived.statusCode, derived.body).toBe(200);
        expect((await post(docPath + '/customer-draft', payload, staff)).json().id).toBe(derived.json().id);
        const childPath = base + '/documents/' + derived.json().id;
        expect((await get(childPath)).json()).toMatchObject({
          audience: 'customer',
          state: 'draft',
          derived_from_version: 3,
          derivationChanged: false,
        });
        expect((await post(childPath, { version: 1, action: 'publish' }, owner)).statusCode).toBe(409);
        expect(
          (
            await post(
              docPath,
              {
                version: 3,
                action: 'save',
                content: {
                  title: '修订内部说明',
                  body: '业务日期的汇率是提交外币发票的前置条件。',
                  category: 'overview',
                  audience: 'internal',
                },
              },
              staff,
            )
          ).statusCode,
        ).toBe(200);
        expect((await get(childPath)).json().derivationChanged).toBe(true);
        expect(
          (
            await post(
              path,
              { action: 'save', version: 2, content: { ...topicContent, description: '主题范围调整' } },
              staff,
            )
          ).statusCode,
        ).toBe(200);
        expect((await post(base + '/generations/' + id + '/import', { index: 1 }, staff)).statusCode).toBe(
          409,
        );
        const next = await post(path + '/generate', { ...request, version: 3 }, staff);
        await processGenerationJob(indexDb, readConfig(), {});
        expect((await get(base + '/generations/' + next.json().id)).json()).toMatchObject({
          state: 'failed',
          error_code: 'MODEL_NOT_CONFIGURED',
        });
        const bad = await post(path + '/generate', { ...request, version: 3 }, staff);
        await processGenerationJob(indexDb, readConfig(), {
          model: {
            identity: 'invalid-reference',
            complete: async () => ({
              tokens: 1,
              value: {
                articles: [
                  {
                    title: 'Invalid citation',
                    body: 'This paragraph cites an unknown evidence identifier.',
                    category: 'overview',
                    evidenceIds: [randomUUID()],
                  },
                ],
                gaps: [],
              },
            }),
          },
        });
        expect((await get(base + '/generations/' + bad.json().id)).json()).toMatchObject({
          state: 'failed',
          error_code: 'GENERATION_REFERENCES_INVALID',
        });
        const running = (await post(path + '/generate', { ...request, version: 3 }, staff)).json();
        await processGenerationJob(indexDb, readConfig(), {
          model: {
            ...model,
            complete: async () => {
              expect(
                (await post(base + '/generations/' + running.id + '/cancel', {}, staff)).statusCode,
              ).toBe(200);
              return model.complete();
            },
          },
        });
        expect((await get(base + '/generations/' + running.id)).json()).toMatchObject({
          state: 'cancelled',
          result: null,
        });
        const interrupted = (await post(path + '/generate', { ...request, version: 3 }, staff)).json();
        await db.query(
          "UPDATE control.knowledge_generation_jobs SET state='running',lease_until=now()-interval '1 minute' WHERE id=$1",
          [interrupted.id],
        );
        expect(await processGenerationJob(indexDb, readConfig(), { model })).toBe(false);
        expect((await get(base + '/generations/' + interrupted.id)).json()).toMatchObject({
          state: 'failed',
          error_code: 'WORKER_INTERRUPTED',
        });
        const cancelled = (await post(path + '/generate', { ...request, version: 3 }, staff)).json();
        expect((await post(base + '/generations/' + cancelled.id + '/cancel', {}, staff)).statusCode).toBe(
          200,
        );
        expect(await processGenerationJob(indexDb, readConfig(), { model })).toBe(false);
        const revoked = (await post(path + '/generate', { ...request, version: 3 }, staff)).json();
        await db.query('UPDATE control.operator_accounts SET enabled=false WHERE id=$1', [staffId]);
        try {
          await processGenerationJob(indexDb, readConfig(), { model });
        } finally {
          await db.query('UPDATE control.operator_accounts SET enabled=true WHERE id=$1', [staffId]);
        }
        expect((await get(base + '/generations/' + revoked.id)).json()).toMatchObject({
          state: 'failed',
          error_code: 'GENERATION_ACTOR_REVOKED',
        });
        const project = readConfig().projects.find((p) => p.key === 'invoice-demo')!;
        const scope = { ...project, tenantId: 'aurora', subject: 'alice' };
        expect(
          (await scoped(app.db, scope, (c) => c.query('SELECT * FROM knowledge.source_fragments'))).rowCount,
        ).toBe(0);
        expect(
          (await scoped(app.db, scope, (c) => c.query('SELECT * FROM control.knowledge_generation_jobs')))
            .rowCount,
        ).toBe(0);
        await expect(
          scoped(indexDb, scope, (c) =>
            c.query('UPDATE knowledge.source_fragments SET body=$1', ['tampered']),
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          scoped(indexDb, scope, (c) =>
            c.query(
              `INSERT INTO knowledge.source_fragments(build_id,organization_id,project_id,path,start_line,end_line,content_hash,body) VALUES($1,$2,$3,'late.md',1,1,$4,'late')`,
              [snapshot.id, project.organizationId, project.projectId, 'a'.repeat(64)],
            ),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await indexDb.end();
      }
    });
    it('generates one topic from separate engineering and business snapshots without losing contradictory provenance', async () => {
      const base = '/operator/projects/invoice-demo/knowledge',
        get = (path: string) => app.app.inject({ url: path, headers: { cookie: staff.cookie } });
      const url = new URL(
        JSON.parse(await readFile(resolve(localDirectory, 'indexer.json'), 'utf8')).databaseUrl,
      );
      url.pathname = '/' + name;
      const indexDb = new Pool({ connectionString: url.href }),
        project = readConfig().projects.find((p) => p.key === 'invoice-demo')!;
      try {
        await writeFile(join(root, 'rules.ts'), 'export const maxUploadBytes = 10 * 1024 * 1024;');
        await writeFile(
          join(root, 'policy.md'),
          '# Business upload policy\nThe published guide describes a 20 MB upload allowance.',
        );
        const indexer = new KnowledgeIndexer(
          indexDb,
          { ...project, tenantId: 'operator', subject: 'multi-source-test' },
          join(root, 'git-cache'),
        );
        const ids: string[] = [];
        for (const [key, file] of [
          ['engineering-rules', 'rules.ts'],
          ['business-policy', 'policy.md'],
        ]) {
          const build = await indexer.sync(
            sourceSchema.parse({
              id: key,
              name: key,
              kind: 'directory',
              location: root,
              include: [file],
              audience: 'internal',
            }),
            { mode: 'extractive', maxModelCalls: 0 },
          );
          const evidence = (await get(base + '/snapshots/' + build.buildId)).json().evidence[0];
          ids.push(evidence.id);
        }
        const topic = (
          await post(
            base + '/topics',
            {
              domain: 'Files',
              title: 'Upload limits',
              description: 'Compare implementation and existing business policy',
              state: 'confirmed',
              requiredCategories: ['overview'],
            },
            staff,
          )
        ).json();
        for (const [i, id] of ids.entries())
          expect(
            (
              await post(
                base + '/topics/' + topic.id,
                {
                  action: 'evidence-link',
                  version: i + 1,
                  evidenceId: id,
                  relation: i === 0 ? 'supports' : 'contradicts',
                  note: i === 0 ? '实现约束为 10 MB' : '业务说明为 20 MB，尚未确认正确口径',
                  confirmed: true,
                },
                staff,
              )
            ).statusCode,
          ).toBe(200);
        const job = (
          await post(
            base + '/topics/' + topic.id + '/generate',
            { version: 3, categories: ['overview'], evidenceIds: ids },
            staff,
          )
        ).json();
        let supplied: unknown;
        await processGenerationJob(indexDb, readConfig(), {
          model: {
            identity: 'multi-source-fixture',
            complete: async (_system, input) => {
              supplied = input;
              return {
                tokens: 55,
                value: {
                  articles: [
                    {
                      title: 'Upload limit disagreement',
                      body: 'The implementation specifies 10 MB while the existing guide specifies 20 MB. The correct public limit needs human review; no deployment version is evidenced.',
                      category: 'overview',
                      evidenceIds: ids,
                    },
                  ],
                  gaps: ['Confirm applicable deployment and business policy before publishing.'],
                },
              };
            },
          },
        });
        expect(supplied).toMatchObject({
          audience: 'internal',
          evidence: expect.arrayContaining([
            expect.objectContaining({ path: 'rules.ts', relation: 'supports' }),
            expect.objectContaining({ path: 'policy.md', relation: 'contradicts' }),
          ]),
        });
        const imported = await post(base + '/generations/' + job.id + '/import', { index: 0 }, staff);
        expect(imported.statusCode, imported.body).toBe(200);
        const document = (await get(base + '/documents/' + imported.json().id)).json();
        expect(document.state).toBe('draft');
        expect(document.evidence).toHaveLength(2);
        expect(new Set(document.evidence.map((e: { sourceId: string }) => e.sourceId)).size).toBe(2);
        expect((await get(base + '/documents/' + document.id + '/freshness')).json()).toMatchObject({
          changed: 0,
          unknown: 0,
        });
        const row = (await db.query('SELECT * FROM knowledge.source_fragments WHERE path=$1', ['rules.ts']))
          .rows[0];
        await db.query('UPDATE knowledge.source_fragments SET body=$2 WHERE build_id=$1', [
          row.build_id,
          'Corrupted retained text',
        ]);
        try {
          expect((await get(base + '/evidence/' + ids[0] + '/content')).statusCode).toBe(409);
          expect(
            (
              await post(
                base + '/topics/' + topic.id + '/generate',
                { version: 3, categories: ['overview'], evidenceIds: ids },
                staff,
              )
            ).statusCode,
          ).toBe(409);
        } finally {
          await db.query('UPDATE knowledge.source_fragments SET body=$2 WHERE build_id=$1', [
            row.build_id,
            row.body,
          ]);
        }
      } finally {
        await indexDb.end();
      }
    });
    it('enforces tenant grants, separates notes, tracks ticket transitions and derives reviewed knowledge', async () => {
      const p = readConfig().projects.find((p) => p.key === 'invoice-demo')!,
        base = '/operator/projects/invoice-demo';
      const scope = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        tenantId: 'aurora',
        subject: 'alice',
      };
      const id = randomUUID();
      await db.query(
        "INSERT INTO core.tenants(organization_id,project_id,tenant_id,display_name) VALUES($1,$2,'aurora','Aurora') ON CONFLICT DO NOTHING",
        [p.organizationId, p.projectId],
      );
      await db.query(
        "INSERT INTO core.cases(id,organization_id,project_id,tenant_id,subject,title,description,context,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,'Support isolation test','Customer issue description','{}',$6,'test')",
        [id, p.organizationId, p.projectId, 'aurora', 'alice', randomUUID()],
      );
      const get = (path: string, auth = owner) =>
        app.app.inject({ url: base + path, headers: { cookie: auth.cookie } });
      expect((await get('/tickets/' + id)).statusCode).toBe(404);
      expect((await get('/tickets', staff)).statusCode).toBe(403);
      expect(
        (await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: ['aurora'] }, owner))
          .statusCode,
      ).toBe(200);
      let detail = (await get('/tickets/' + id)).json();
      expect(detail.ticket.id).toBe(id);
      let version = detail.ticket.ticket_version;
      const note = {
        action: 'note',
        version,
        body: 'Internal staff note, never customer content',
        requestKey: randomUUID(),
      };
      expect((await post(base + '/tickets/' + id, note, owner)).statusCode).toBe(200);
      expect((await post(base + '/tickets/' + id, note, owner)).json().replayed).toBe(true);
      expect((await post(base + '/tickets/' + id, { ...note, body: 'Different' }, owner)).statusCode).toBe(
        409,
      );
      expect(await caseMessages(app.db, scope, id)).toHaveLength(0);
      const stale = await post(
        base + '/tickets/' + id,
        { action: 'assign', version, assigneeId: null, team: 'Support', priority: 'high' },
        owner,
      );
      expect(stale.statusCode).toBe(409);
      version++;
      expect(
        (
          await post(
            base + '/tickets/' + id,
            { action: 'reply', version, body: 'Public support response', requestKey: randomUUID() },
            owner,
          )
        ).statusCode,
      ).toBe(200);
      expect((await caseMessages(app.db, scope, id)).map((m) => m.body)).toEqual(['Public support response']);
      version++;
      expect(
        (
          await post(
            base + '/tickets/' + id,
            { action: 'status', version, status: 'resolved', reason: 'Verified fix' },
            owner,
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await post(
            base + '/tickets/' + id,
            {
              action: 'status',
              version,
              status: 'resolved',
              reason: 'Verified fix',
              resolution: {
                summary: 'Reconfigured the exchange rate',
                rootCause: 'Missing configuration',
                verification: 'verified',
                publicSummary: 'Please retry after exchange rate setup.',
              },
            },
            owner,
          )
        ).statusCode,
      ).toBe(200);
      version++;
      detail = (await get('/tickets/' + id)).json();
      expect(detail.ticket.status).toBe('resolved');
      const draft = {
        version,
        title: 'Resolve configuration issues',
        body: 'Verify the required exchange rate configuration and retry the operation.',
      };
      const created = await post(base + '/tickets/' + id + '/knowledge', draft, owner);
      expect(created.statusCode, created.body).toBe(200);
      expect((await post(base + '/tickets/' + id + '/knowledge', draft, owner)).json().id).toBe(
        created.json().id,
      );
      const knowledge = (
        await db.query('SELECT audience,state,origin_case_id FROM knowledge.documents WHERE id=$1', [
          created.json().id,
        ])
      ).rows[0];
      expect(knowledge).toMatchObject({ audience: 'internal', state: 'draft', origin_case_id: id });
      expect((await get('/tickets/' + id + '/investigation')).statusCode).toBe(200);
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: [] }, owner);
      expect((await get('/tickets/' + id)).statusCode).toBe(404);
      expect((await get('/tickets/' + id + '/investigation')).statusCode).toBe(404);
      const history = new ConversationService(app.db),
        key = randomUUID();
      const createdConversation = await history.create(scope, { title: 'Persistent support' }, key),
        cid = createdConversation.conversation.id;
      expect((await history.create(scope, { title: 'Persistent support' }, key)).replayed).toBe(true);
      const messageKey = randomUUID();
      expect(
        (
          await history.append(
            scope,
            cid,
            { role: 'user', body: 'Please help with this invoice' },
            messageKey,
          )
        ).sequence,
      ).toBe(1);
      expect(
        (
          await history.append(
            scope,
            cid,
            { role: 'user', body: 'Please help with this invoice' },
            messageKey,
          )
        ).replayed,
      ).toBe(true);
      await expect(
        history.append(scope, cid, { role: 'assistant', body: 'Forged receipt' }, messageKey),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await history.append(
        scope,
        cid,
        {
          role: 'assistant',
          body: 'Saved display only, no execution authority',
          references: [
            { kind: 'query', id: 'historical-query-request', observedAt: '2026-09-20T00:00:00.000Z' },
          ],
        },
        randomUUID(),
      );
      expect((await history.detail(scope, cid)).messages[1]!.references).toEqual([
        { kind: 'query', id: 'historical-query-request', observedAt: '2026-09-20T00:00:00.000Z' },
      ]);
      await history.link(scope, cid, id);
      expect((await history.detail(scope, cid)).cases).toHaveLength(1);
      await expect(history.detail({ ...scope, subject: 'bob' }, cid)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        history.append({ ...scope, tenantId: 'other' }, cid, { role: 'user', body: 'Denied' }, randomUUID()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await scoped(app.db, scope, async (c) =>
        expect((await c.query('SELECT * FROM core.ticket_notes WHERE case_id=$1', [id])).rows).toHaveLength(
          0,
        ),
      );
      await history.remove(scope, cid, 'privacy-test');
      await expect(history.detail(scope, cid)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(
        (
          await db.query('SELECT body,result_refs FROM core.conversation_messages WHERE conversation_id=$1', [
            cid,
          ])
        ).rows.every((r) => r.body === '' && r.result_refs.length === 0),
      ).toBe(true);
      expect(
        (await db.query('SELECT resource_type FROM control.privacy_tombstones WHERE resource_id=$1', [cid]))
          .rows[0].resource_type,
      ).toBe('conversation');
      expect(await caseMessages(app.db, scope, id)).toHaveLength(1);
    });
    it('keeps analytics, engineering evidence and saved reports within live grants', async () => {
      const p = readConfig().projects.find((p) => p.key === 'invoice-demo')!,
        base = '/operator/projects/invoice-demo';
      const get = (path: string, auth = owner) =>
        app.app.inject({ url: base + path, headers: { cookie: auth.cookie } });
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: ['aurora'] }, owner);
      const result = await get('/insights?days=30&tenant=aurora');
      expect(result.statusCode, result.body).toBe(200);
      const expected = +(
        await db.query(
          "SELECT count(*) FROM core.cases WHERE project_id=$1 AND tenant_id='aurora' AND deleted_at IS NULL AND created_at>=now()-interval '30 days'",
          [p.projectId],
        )
      ).rows[0].count;
      expect(result.json().byStatus.reduce((n: number, x: { count: number }) => n + x.count, 0)).toBe(
        expected,
      );
      expect(result.json().definitionVersion).toBe('support-metrics-v1');
      expect((await get('/insights?tenant=unauthorized')).statusCode).toBe(403);
      const input = {
        title: 'Support aggregate snapshot',
        days: 30,
        tenant: 'aurora',
        requestKey: randomUUID(),
      };
      const saved = await post(base + '/insights/reports', input, owner);
      expect(saved.statusCode, saved.body).toBe(200);
      const rid = saved.json().id;
      expect((await post(base + '/insights/reports', input, owner)).json().id).toBe(rid);
      expect((await post(base + '/insights/reports', { ...input, days: 31 }, owner)).statusCode).toBe(409);
      expect((await get('/operations')).statusCode).toBe(200);
      await db.query(
        "UPDATE control.operator_memberships SET roles=ARRAY['support'] WHERE operator_id=$1 AND project_id=$2",
        [staffId, p.projectId],
      );
      await post(base + '/support/access/' + staffId, { allTenants: false, tenantIds: ['aurora'] }, owner);
      expect((await get('/tickets', staff)).statusCode).toBe(200);
      expect((await get('/operations', staff)).statusCode).toBe(403);
      expect((await get('/insights/reports/' + rid, staff)).statusCode).toBe(404);
      await db.query(
        "UPDATE control.operator_memberships SET roles=ARRAY['knowledge_editor'] WHERE operator_id=$1 AND project_id=$2",
        [staffId, p.projectId],
      );
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: [] }, owner);
      expect((await get('/insights/reports/' + rid)).statusCode).toBe(404);
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: ['aurora'] }, owner);
      const deletion = await post(base + '/insights/reports/' + rid + '/delete', {}, owner);
      expect(deletion.statusCode, deletion.body).toBe(200);
      expect(
        (await db.query('SELECT resource_type FROM control.privacy_tombstones WHERE resource_id=$1', [rid]))
          .rows[0].resource_type,
      ).toBe('insight');
    });
    it('previews retention without writes and replays deletion after simulated backup restoration', async () => {
      const p = readConfig().projects.find((p) => p.key === 'invoice-demo')!,
        base = '/operator/projects/invoice-demo';
      const scope = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        tenantId: 'aurora',
        subject: 'alice',
      };
      const history = new ConversationService(app.db),
        id = (await history.create(scope, { title: 'Retention fixture' }, randomUUID())).conversation.id;
      await history.append(scope, id, { role: 'user', body: 'Old personal transcript' }, randomUUID());
      await db.query("UPDATE core.conversations SET updated_at=now()-interval '60 days' WHERE id=$1", [id]);
      const config = await post(
        base + '/retention',
        {
          conversation_days: 30,
          ticket_days: null,
          attachment_days: null,
          evidence_days: null,
          audit_days: null,
        },
        owner,
      );
      expect(config.statusCode, config.body).toBe(200);
      const preview = await runRetention(db, false);
      expect(preview.results.find((r) => r.kind === 'conversation')?.selected).toBe(1);
      expect((await history.detail(scope, id)).messages[0]?.body).toBe('Old personal transcript');
      await runRetention(db, true);
      await expect(history.detail(scope, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const tombstones = (
        await db.query('SELECT * FROM control.privacy_tombstones WHERE resource_id=$1', [id])
      ).rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
      await db.query("UPDATE core.conversations SET title='Backup text',deleted_at=NULL WHERE id=$1", [id]);
      await db.query(
        "UPDATE core.conversation_messages SET body='Restored private content' WHERE conversation_id=$1",
        [id],
      );
      await db.query(privacyReplaySql(tombstones));
      expect(
        (await db.query('SELECT body FROM core.conversation_messages WHERE conversation_id=$1', [id])).rows[0]
          .body,
      ).toBe('');
      await expect(history.detail(scope, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const ticket = randomUUID();
      await db.query(
        "INSERT INTO core.cases(id,organization_id,project_id,tenant_id,subject,title,description,context,idempotency_key,request_hash,status,ticket_status,updated_at) VALUES($1,$2,$3,'aurora','alice','Old closed ticket','Private case text','{}',$4,'old','resolved','closed',now()-interval '90 days')",
        [ticket, p.organizationId, p.projectId, randomUUID()],
      );
      await db.query(
        "INSERT INTO core.case_messages(id,case_id,organization_id,project_id,tenant_id,subject,author_kind,body,request_key) VALUES($1,$2,$3,$4,'aurora','alice','customer','Private followup',$5)",
        [randomUUID(), ticket, p.organizationId, p.projectId, randomUUID()],
      );
      await post(
        base + '/retention',
        {
          conversation_days: 30,
          ticket_days: 60,
          attachment_days: null,
          evidence_days: null,
          audit_days: null,
        },
        owner,
      );
      await runRetention(db, true);
      expect(
        (await db.query('SELECT description,deleted_at FROM core.cases WHERE id=$1', [ticket])).rows[0],
      ).toMatchObject({ description: '', deleted_at: expect.any(Date) });
      await expect(caseMessages(app.db, scope, ticket)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(
        (await db.query('SELECT body FROM core.case_messages WHERE case_id=$1', [ticket])).rows[0].body,
      ).toBe('[已删除]');
    });
    it('requires scoped evidence for conflicts and manual publisher resolution', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const topic = (
        await post(
          base + '/topics',
          {
            domain: 'Conflict fixture',
            title: 'Upload limits',
            description: 'Evidence review',
            state: 'confirmed',
            requiredCategories: ['overview'],
          },
          owner,
        )
      ).json().id;
      const ids: string[] = [];
      let version = 1;
      for (const body of ['Maximum upload size = 20 MB', 'MAX_UPLOAD_SIZE = 10 MB']) {
        const d = await post(
          base + '/documents',
          { title: 'Upload policy ' + ids.length, body, category: 'overview', audience: 'internal' },
          owner,
        );
        expect(d.statusCode, d.body).toBe(200);
        ids.push(d.json().id);
        const linked = await post(
          base + '/topics/' + topic,
          { action: 'link', version, documentId: d.json().id },
          owner,
        );
        expect(linked.statusCode, linked.body).toBe(200);
        version++;
      }
      const detected = await post(base + '/conflicts/scan', { topicId: topic }, staff);
      expect(detected.statusCode, detected.body).toBe(200);
      expect(detected.json()).toMatchObject({
        method: 'explicit-numeric-assignment-v1',
        requiresScopeReview: true,
      });
      expect(detected.json().candidates).toHaveLength(1);
      const payload = {
        topicId: topic,
        ruleKey: 'Upload file limit',
        comparisonScope: 'Enterprise / release 2.0 / single file',
        claims: ids.map((id, i) => ({ kind: 'document', id, version: '1', value: i ? '10 MB' : '20 MB' })),
      };
      const created = await post(base + '/conflicts', payload, staff);
      expect(created.statusCode, created.body).toBe(200);
      const cid = created.json().id,
        decision = {
          version: 1,
          state: 'resolved',
          reason: 'Reviewed both sources and requested the documented limit be corrected.',
        };
      expect((await post(base + '/conflicts/' + cid, decision, staff)).statusCode).toBe(403);
      expect((await post(base + '/conflicts/' + cid, decision, owner)).statusCode).toBe(200);
      expect((await post(base + '/conflicts/' + cid, decision, owner)).statusCode).toBe(409);
      expect(
        (
          await post(
            base + '/conflicts',
            { ...payload, claims: payload.claims.map((x) => ({ ...x, version: '99' })) },
            owner,
          )
        ).statusCode,
      ).toBe(409);
      const impact = await app.app.inject({ url: base + '/impact', headers: { cookie: owner.cookie } });
      expect(impact.statusCode, impact.body).toBe(200);
      const rows = (await db.query('SELECT state FROM knowledge.documents WHERE id=ANY($1::uuid[])', [ids]))
        .rows;
      expect(rows.every((r) => r.state === 'draft')).toBe(true);
    });
    it('pauses SLA on waiting states, retains elapsed time on reopen and exposes only assigned updates', async () => {
      const p = readConfig().projects.find((p) => p.key === 'invoice-demo')!,
        base = '/operator/projects/invoice-demo';
      const scope = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        tenantId: 'aurora',
        subject: 'alice',
      };
      const get = (path: string) => app.app.inject({ url: base + path, headers: { cookie: owner.cookie } });
      const policy = await post(
        base + '/support/settings',
        { enabled: true, targets: { low: 1440, normal: 60, high: 30, urgent: 10 } },
        owner,
      );
      expect(policy.statusCode, policy.body).toBe(200);
      const id = randomUUID();
      await db.query(
        "INSERT INTO core.cases(id,organization_id,project_id,tenant_id,subject,title,description,context,idempotency_key,request_hash,assignee_id) VALUES($1,$2,$3,'aurora','alice','SLA lifecycle fixture','Synthetic test content','{}',$4,'sla',$5)",
        [id, p.organizationId, p.projectId, randomUUID(), adminId],
      );
      await db.query("UPDATE core.cases SET sla_clock_started_at=now()-interval '50 minutes' WHERE id=$1", [
        id,
      ]);
      let detail = (await get('/tickets/' + id)).json();
      expect(detail.ticket.sla).toMatchObject({
        targetMinutes: 60,
        elapsedMinutes: 50,
        paused: false,
        breached: false,
      });
      const pause = await post(
        base + '/tickets/' + id,
        {
          action: 'status',
          version: detail.ticket.ticket_version,
          status: 'waiting_customer',
          reason: 'Waiting for customer verification',
        },
        owner,
      );
      expect(pause.statusCode, pause.body).toBe(200);
      detail = (await get('/tickets/' + id)).json();
      expect(detail.ticket.sla).toMatchObject({ paused: true, elapsedMinutes: 50 });
      await db.query("UPDATE core.cases SET first_response_started_at=now()-interval '5 hours' WHERE id=$1", [
        id,
      ]);
      detail = (await get('/tickets/' + id)).json();
      expect(detail.ticket.firstResponseSla).toMatchObject({
        targetMinutes: 240,
        elapsedMinutes: 300,
        completed: false,
        breached: true,
      });
      const internalNote = await post(
        base + '/tickets/' + id,
        {
          action: 'note',
          version: detail.ticket.ticket_version,
          body: 'Internal note does not stop the customer response clock',
          requestKey: randomUUID(),
        },
        owner,
      );
      expect(internalNote.statusCode, internalNote.body).toBe(200);
      detail = (await get('/tickets/' + id)).json();
      expect(detail.ticket.firstResponseSla.completed).toBe(false);

      expect(
        (await get('/support/notifications')).json().notifications.some((n: { id: string }) => n.id === id),
      ).toBe(true);
      await post(
        base + '/support/notifications/' + id + '/read',
        { version: detail.ticket.ticket_version },
        owner,
      );
      expect(
        (await get('/support/notifications')).json().notifications.some((n: { id: string }) => n.id === id),
      ).toBe(false);
      const resolve = await post(
        base + '/tickets/' + id,
        {
          action: 'status',
          version: detail.ticket.ticket_version,
          status: 'resolved',
          reason: 'Synthetic resolved verification',
          resolution: {
            summary: 'The required configuration was restored.',
            rootCause: 'Unverified',
            verification: 'hypothesis',
            publicSummary: 'Please retry the operation after reloading.',
          },
        },
        owner,
      );
      expect(resolve.statusCode, resolve.body).toBe(200);
      detail = (await get('/tickets/' + id)).json();
      expect(
        (
          await post(
            base + '/tickets/' + id,
            {
              action: 'status',
              version: detail.ticket.ticket_version,
              status: 'open',
              reason: 'Customer reported recurrence',
            },
            owner,
          )
        ).statusCode,
      ).toBe(200);
      detail = (await get('/tickets/' + id)).json();
      expect(detail.ticket.sla.elapsedMinutes).toBeGreaterThanOrEqual(50);
      expect(detail.ticket.firstResponseSla).toMatchObject({ completed: true, elapsedMinutes: 300 });
      expect(detail.ticket.sla.paused).toBe(false);
      expect(
        (await db.query('SELECT case_id FROM knowledge.case_review_signals WHERE case_id=$1', [id])).rowCount,
      ).toBe(1);
      await db.query(
        "INSERT INTO core.case_captures(case_id,organization_id,project_id,tenant_id,subject,payload) VALUES($1,$2,$3,'aurora','alice','{}')",
        [id, p.organizationId, p.projectId],
      );
      await expect(
        deleteCaseCapture(app.db, { ...scope, subject: 'bob' }, id, 'cross-subject'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await deleteCaseCapture(app.db, scope, id, 'erase-attachment');
      expect((await db.query('SELECT case_id FROM core.case_captures WHERE case_id=$1', [id])).rowCount).toBe(
        0,
      );
      expect(
        (
          await db.query(
            "SELECT resource_type FROM control.privacy_tombstones WHERE resource_id=$1 AND resource_type='attachment'",
            [id],
          )
        ).rowCount,
      ).toBe(1);
      expect((await get('/tickets/' + id + '/history?kind=events')).statusCode).toBe(200);
    });
    it('edits source connections with frozen job inputs, active-job protection and version checks', async () => {
      const base = '/operator/projects/invoice-demo/knowledge/connections';
      const input = {
        source: {
          id: 'maintenance-fixture',
          name: 'Maintenance source',
          kind: 'directory',
          location: root,
          include: ['**/*.md'],
          audience: 'internal',
          tenantIds: [],
        },
        mode: 'extractive',
      };
      const create = await post(base, input, owner);
      expect(create.statusCode, create.body).toBe(200);
      const id = create.json().id,
        path = base + '/' + id;
      const get = (url: string) => app.app.inject({ url, headers: { cookie: owner.cookie } });
      const original = (await get(path)).json();
      expect(original.version).toBe(1);
      const update = {
        ...original,
        source: { ...original.source, name: 'Updated source', include: ['docs/**/*.md'] },
      };
      delete update.id;
      expect((await post(path, update, owner)).json().error.code).toBe('SOURCE_JOB_ACTIVE');
      expect(
        (
          await post(
            '/operator/projects/invoice-demo/knowledge/jobs/' + create.json().jobId + '/cancel',
            {},
            owner,
          )
        ).statusCode,
      ).toBe(200);
      const saved = await post(path, update, owner);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().version).toBe(2);
      expect((await post(path, update, owner)).statusCode).toBe(409);
      expect((await post(path, { ...update, version: 2 }, staff)).statusCode).toBe(403);
      const rows = (
        await db.query(
          'SELECT connection_version,source_input FROM control.knowledge_jobs WHERE connection_id=$1 ORDER BY created_at,id',
          [id],
        )
      ).rows;
      expect(rows.map((r) => r.connection_version)).toEqual([1, 2]);
      expect(rows[0].source_input.source.name).toBe('Maintenance source');
      expect(rows[1].source_input.source.include).toEqual(['docs/**/*.md']);
      expect(
        (
          await post(
            '/operator/projects/invoice-demo/knowledge/jobs/' + saved.json().jobId + '/cancel',
            {},
            owner,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(
            path,
            { ...update, version: 2, source: { ...update.source, id: 'another-source' } },
            owner,
          )
        ).json().error.code,
      ).toBe('SOURCE_IDENTITY_IMMUTABLE');
      const page = (await get(base + '?offset=100000')).json();
      expect(page).toEqual({ connections: [], nextOffset: null });
      expect((await get('/operator/projects/other-demo/knowledge/connections/' + id)).statusCode).toBe(404);
    });
    it('evaluates only published public knowledge and snapshots results across revocation', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const get = (path: string) => app.app.inject({ url: path, headers: { cookie: owner.cookie } });
      async function publish(audience: 'customer' | 'internal', body: string) {
        const created = await post(
          base + '/documents',
          { title: 'Evaluation beacon guide', body, category: 'overview', audience },
          owner,
        );
        expect(created.statusCode, created.body).toBe(200);
        const id = created.json().id;
        for (const [index, action] of ['submit', 'approve', 'publish'].entries())
          expect(
            (await post(base + '/documents/' + id, { version: index + 1, action }, owner)).statusCode,
          ).toBe(200);
        return id;
      }
      const publicId = await publish('customer', 'Evaluation beacon explains the safe public workflow.');
      const internalId = await publish(
        'internal',
        'Evaluation beacon private engineering details must remain internal.',
      );
      const search = await post(base + '/evaluation/search', { question: 'Evaluation beacon' }, owner);
      expect(search.statusCode, search.body).toBe(200);
      expect(search.json().citations.some((c: { sourceId: string }) => c.sourceId === publicId)).toBe(true);
      expect(search.body).not.toContain('private engineering');
      expect(
        (
          await post(
            base + '/evaluation/questions',
            { question: 'Evaluation beacon', expectedSources: [internalId] },
            owner,
          )
        ).statusCode,
      ).toBe(400);
      const q = await post(
        base + '/evaluation/questions',
        { question: 'Evaluation beacon', expectedSources: [publicId] },
        owner,
      );
      expect(q.statusCode, q.body).toBe(200);
      const input = { questionIds: [q.json().id] };
      const run = await post(base + '/evaluation/run', input, owner);
      expect(run.statusCode, run.body).toBe(200);
      expect(run.json().results[0]).toMatchObject({ passed: true, version: 1, expectedSources: [publicId] });
      const frozen = run.json().results;
      expect(
        (await post(base + '/documents/' + publicId, { version: 4, action: 'revoke' }, owner)).statusCode,
      ).toBe(200);
      const second = await post(base + '/evaluation/run', input, owner);
      expect(second.json().results[0].passed).toBe(false);
      const runs = (await get(base + '/evaluation')).json().runs;
      expect(runs.find((r: { id: string }) => r.id === run.json().id).results).toEqual(frozen);
      expect(
        (await post(base + '/evaluation/questions/' + q.json().id + '/archive', { version: 2 }, owner))
          .statusCode,
      ).toBe(409);
      expect(
        (await post(base + '/evaluation/questions/' + q.json().id + '/archive', { version: 1 }, owner))
          .statusCode,
      ).toBe(200);
      expect((await post(base + '/evaluation/run', input, owner)).statusCode).toBe(404);
      expect((await get('/operator/projects/other-demo/knowledge/evaluation')).json().questions).toEqual([]);
    });
    it('counts SLA in a frozen working calendar including holidays and DST', async () => {
      const calendar = {
        timezone: 'America/New_York',
        weekdays: [1, 2, 3, 4, 5],
        start: '09:00',
        end: '17:00',
        holidays: ['2026-03-09'],
      };
      const seconds = async (a: string, b: string, cal: unknown) =>
        +(await db.query('SELECT core.sla_seconds($1,$2,$3) AS seconds', [a, b, JSON.stringify(cal)])).rows[0]
          .seconds;
      // Friday 16:00 EST to Tuesday 10:00 EDT, with Monday a holiday: 1h + 1h.
      expect(await seconds('2026-03-06T21:00:00Z', '2026-03-10T14:00:00Z', calendar)).toBe(7200);
      expect(await seconds('2026-03-07T12:00:00Z', '2026-03-09T12:00:00Z', calendar)).toBe(0);
      expect(await seconds('2026-03-10T14:00:00Z', '2026-03-10T13:00:00Z', calendar)).toBe(0);
      const base = '/operator/projects/invoice-demo/support/settings';
      const valid = await post(
        base,
        { enabled: true, targets: { low: 4320, normal: 1440, high: 240, urgent: 60 }, calendar },
        owner,
      );
      expect(valid.statusCode, valid.body).toBe(200);
      expect(
        (await app.app.inject({ url: base, headers: { cookie: owner.cookie } })).json().settings.calendar,
      ).toEqual(calendar);
      expect(
        (
          await post(
            base,
            {
              enabled: true,
              targets: { low: 4320, normal: 1440, high: 240, urgent: 60 },
              calendar: { ...calendar, holidays: ['2026-02-30'] },
            },
            owner,
          )
        ).statusCode,
      ).toBe(400);
    });
    it('discovers reviewable scope candidates, maps evidence and merges without publishing', async () => {
      const p = runtimeConfig.projects.find((p) => p.key === 'invoice-demo')!,
        base = '/operator/projects/invoice-demo/knowledge';
      const snapshot = (
        await db.query(
          'SELECT DISTINCT e.snapshot_id FROM knowledge.source_evidence e JOIN knowledge.sources s ON s.id=(SELECT source_id FROM knowledge.builds WHERE id=e.snapshot_id) WHERE e.organization_id=$1 AND e.project_id=$2 AND s.enabled LIMIT 1',
          [p.organizationId, p.projectId],
        )
      ).rows[0].snapshot_id;
      const found = await post(base + '/topics/discover', { snapshotIds: [snapshot] }, owner);
      expect(found.statusCode, found.body).toBe(200);
      expect(found.json().candidates.length).toBeGreaterThan(0);
      const candidate = found.json().candidates[0],
        input = {
          snapshotIds: [snapshot],
          key: candidate.key,
          title: 'Discovered product domain',
          domain: 'Discovery test',
        },
        created = await post(base + '/topics/candidates', input, owner);
      expect(created.statusCode, created.body).toBe(200);
      expect((await post(base + '/topics/candidates', input, owner)).json().id).toBe(created.json().id);
      const detail = await app.app.inject({
        url: base + '/topics/' + created.json().id,
        headers: { cookie: owner.cookie },
      });
      expect(detail.json().state).toBe('candidate');
      expect(detail.json().evidence.every((e: { confirmed: boolean }) => !e.confirmed)).toBe(true);
      const target = await post(
        base + '/topics',
        {
          title: 'Merged product domain',
          domain: 'Discovery test',
          description: 'Explicit scope review',
          state: 'confirmed',
          requiredCategories: ['overview'],
        },
        owner,
      );
      expect(target.statusCode, target.body).toBe(200);
      const merged = await post(
        base + '/topics/' + created.json().id + '/merge',
        {
          version: 1,
          targetId: target.json().id,
          targetVersion: 1,
          reason: 'Same product domain confirmed by reviewer',
        },
        owner,
      );
      expect(merged.statusCode, merged.body).toBe(200);
      const after = (
        await app.app.inject({ url: base + '/topics/' + target.json().id, headers: { cookie: owner.cookie } })
      ).json();
      expect(after.state).toBe('candidate');
      expect(after.evidence.length).toBeGreaterThan(0);
      const reviewInput = {
        action: 'evidence-review',
        version: after.version,
        evidenceId: after.evidence[0].id,
        confirmed: true,
        relation: 'supports',
        note: 'Reviewed against the fixed source snapshot',
      };
      const reviewed = await post(base + '/topics/' + target.json().id, reviewInput, owner);
      expect(reviewed.statusCode, reviewed.body).toBe(200);
      expect((await post(base + '/topics/' + target.json().id, reviewInput, owner)).statusCode).toBe(409);
      const reviewedDetail = (
        await app.app.inject({ url: base + '/topics/' + target.json().id, headers: { cookie: owner.cookie } })
      ).json();
      expect(reviewedDetail.evidence[0]).toMatchObject({ confirmed: true, relation: 'supports' });

      expect(
        (await db.query('SELECT merged_into,state FROM knowledge.topics WHERE id=$1', [created.json().id]))
          .rows[0],
      ).toMatchObject({ merged_into: target.json().id, state: 'excluded' });
    });
    it('compares fixed customer drafts and atomically publishes or revokes reviewed publication sets', async () => {
      const base = '/operator/projects/invoice-demo/knowledge',
        ids: string[] = [];
      for (const [title, audience] of [
        ['Golden constellation guide', 'customer'],
        ['Internal constellation operations', 'internal'],
      ]) {
        const d = await post(
          base + '/documents',
          {
            title,
            body: 'Constellation onboarding requires an approved tenant profile and confirmed configuration.',
            audience,
            category: 'overview',
          },
          owner,
        );
        expect(d.statusCode, d.body).toBe(200);
        ids.push(d.json().id);
      }
      const question = await post(
        base + '/evaluation/questions',
        { question: 'constellation onboarding', expectedSources: [ids[0]] },
        owner,
      );
      expect(question.statusCode, question.body).toBe(200);
      const comparison = await post(
        base + '/evaluation/run',
        { questionIds: [question.json().id], candidateDocuments: [{ id: ids[0], version: 1 }] },
        owner,
      );
      expect(comparison.statusCode, comparison.body).toBe(200);
      expect(comparison.json().results[0]).toMatchObject({ passed: false, candidatePassed: true });
      expect(
        (
          await post(
            base + '/evaluation/run',
            { questionIds: [question.json().id], candidateDocuments: [{ id: ids[1], version: 1 }] },
            owner,
          )
        ).statusCode,
      ).toBe(404);
      for (const id of ids) {
        expect(
          (await post(base + '/documents/' + id, { action: 'submit', version: 1 }, owner)).statusCode,
        ).toBe(200);
        expect(
          (await post(base + '/documents/' + id, { action: 'approve', version: 2 }, owner)).statusCode,
        ).toBe(200);
      }
      const input = {
        title: 'Atomic reviewed release',
        requestKey: randomUUID(),
        documents: ids.map((id) => ({ id, version: 3 })),
      };
      expect(
        (
          await post(
            base + '/publication-sets',
            {
              ...input,
              documents: [
                { id: ids[0], version: 3 },
                { id: ids[1], version: 1 },
              ],
            },
            owner,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await db.query(
            'SELECT count(*) FROM knowledge.documents WHERE id=ANY($1::uuid[]) AND published_build_id IS NOT NULL',
            [ids],
          )
        ).rows[0].count,
      ).toBe('0');
      const published = await post(base + '/publication-sets', input, owner);
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json().members.length).toBe(2);
      expect((await post(base + '/publication-sets', input, owner)).json().replayed).toBe(true);
      expect(
        (await post(base + '/evaluation/run', { questionIds: [question.json().id] }, owner)).json().results[0]
          .passed,
      ).toBe(true);
      expect(
        (
          await post(
            base + '/publication-sets/' + published.json().id + '/revoke',
            { reason: 'Review requests a revised configuration guide' },
            owner,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await db.query('SELECT count(*) FROM knowledge.sources WHERE id=ANY($1::uuid[]) AND enabled', [ids]))
          .rows[0].count,
      ).toBe('0');
      expect(
        (
          await post(
            base + '/publication-sets/' + published.json().id + '/revoke',
            { reason: 'Already revoked release' },
            owner,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (await post(base + '/evaluation/run', { questionIds: [question.json().id] }, owner)).json().results[0]
          .passed,
      ).toBe(false);
    });
    it('records signed deployment provenance by incident time without substituting repository HEAD', async () => {
      const p = runtimeConfig.projects.find((p) => p.key === 'invoice-demo')!,
        base = '/operator/projects/invoice-demo/deployments';
      const source = (
        await db.query(
          'SELECT id,source_key FROM knowledge.sources WHERE organization_id=$1 AND project_id=$2 LIMIT 1',
          [p.organizationId, p.projectId],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO knowledge.connections(id,organization_id,project_id,source_key,name,spec,mode,created_by) VALUES($1,$2,$3,$4,'Deployment source',$5,'extractive',$6) ON CONFLICT(organization_id,project_id,source_key) DO UPDATE SET spec=excluded.spec",
        [
          randomUUID(),
          p.organizationId,
          p.projectId,
          source.source_key,
          JSON.stringify({ kind: 'git' }),
          adminId,
        ],
      );
      const input = {
        eventId: randomUUID(),
        service: 'checkout',
        environment: 'production',
        sourceId: source.id,
        commit: 'a'.repeat(40),
        artifactDigest: 'sha256:' + '1'.repeat(64),
        deployedAt: '2026-01-01T00:00:00Z',
        evidenceUrl: 'https://ci.example.com/builds/100',
        note: 'Verified against release pipeline artifact',
      };
      const recorded = await post(base, input, owner);
      expect(recorded.statusCode, recorded.body).toBe(200);
      expect((await post(base, input, owner)).json().replayed).toBe(true);
      expect((await post(base, { ...input, commit: 'c'.repeat(40) }, owner)).statusCode).toBe(409);
      const feed = {
          pipeline: 'release-main',
          credentialEnv: 'AGENT18_DEPLOY_TEST',
          bindings: [{ service: 'checkout', environment: 'production' as const, sourceId: source.id }],
        },
        projects = [{ ...p, deploymentFeed: feed }];
      const envelope = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        pipeline: feed.pipeline,
        deployment: {
          ...input,
          eventId: randomUUID(),
          commit: 'b'.repeat(40),
          deployedAt: '2026-02-01T00:00:00Z',
        },
      };
      const timestamp = String(Math.floor(Date.now() / 1000)),
        headers = {
          timestamp,
          eventId: envelope.deployment.eventId,
          signature: syncSignature(syncSecret, timestamp, envelope.deployment.eventId, envelope),
        };
      expect(
        await receiveDeployment(app.db, projects, envelope, headers, { AGENT18_DEPLOY_TEST: syncSecret }),
      ).toMatchObject({ replayed: false });
      expect(
        await receiveDeployment(app.db, projects, envelope, headers, { AGENT18_DEPLOY_TEST: syncSecret }),
      ).toMatchObject({ replayed: true });
      await expect(
        receiveDeployment(
          app.db,
          projects,
          { ...envelope, deployment: { ...envelope.deployment, service: 'wrong' } },
          headers,
          { AGENT18_DEPLOY_TEST: syncSecret },
        ),
      ).rejects.toThrow('DEPLOYMENT_BINDING_DENIED');
      const get = (at: string) =>
        app.app.inject({
          url: base + '?environment=production&service=checkout&at=' + encodeURIComponent(at),
          headers: { cookie: owner.cookie },
        });
      expect((await get('2026-01-15T00:00:00Z')).json().records[0].commit_hash).toBe('a'.repeat(40));
      expect((await get('2026-03-01T00:00:00Z')).json().records[0]).toMatchObject({
        commit_hash: 'b'.repeat(40),
        attestation: 'signed_pipeline',
        activeAtTime: true,
      });
      expect(
        (
          await post(
            base + '/' + envelope.deployment.eventId + '/revoke',
            { reason: 'Pipeline mapped incorrect artifact' },
            owner,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await get('2026-03-01T00:00:00Z'))
          .json()
          .records.every((r: { activeAtTime: boolean }) => !r.activeAtTime),
      ).toBe(true);
    });
    it('synchronizes metadata to an independent ticket store with signed idempotency and loop suppression', async () => {
      const p = runtimeConfig.projects.find((p) => p.key === 'invoice-demo')!,
        base = '/operator/projects/invoice-demo';
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: ['aurora'] }, owner);
      const ticket = (
        await db.query(
          "SELECT id,ticket_version FROM core.cases WHERE project_id=$1 AND tenant_id='aurora' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
          [p.projectId],
        )
      ).rows[0];
      const connect = await post(
        base + '/tickets/' + ticket.id + '/external',
        { action: 'connect', version: ticket.ticket_version },
        owner,
      );
      expect(connect.statusCode, connect.body).toBe(200);
      const runtime = new TicketSyncRuntime(app.db, runtimeConfig.projects, {
        AGENT18_SYNC_TEST: syncSecret,
      });
      syncBridge.setFailAfterCommit(true);
      expect(await runtime.tick()).toMatchObject({ state: 'pending', reason: 'SYNC_UPSTREAM_FAILED' });
      const first = (
        await db.query('SELECT id,payload FROM control.ticket_outbox WHERE case_id=$1', [ticket.id])
      ).rows[0];
      expect(first.payload).not.toHaveProperty('title');
      expect(first.payload).not.toHaveProperty('subject');
      syncBridge.setFailAfterCommit(false);
      await db.query('UPDATE control.ticket_outbox SET next_attempt=now() WHERE id=$1', [first.id]);
      expect(await runtime.tick()).toMatchObject({ state: 'delivered' });
      expect(syncBridge.db.prepare('SELECT count(*) n FROM receipts').get()!.n).toBe(1);
      const event = {
        eventId: randomUUID(),
        organizationId: p.organizationId,
        projectId: p.projectId,
        tenantId: 'aurora',
        ticketId: ticket.id,
        externalId: 'EXT-' + ticket.id,
        version: 2,
        status: 'in_progress',
        origin: 'external',
      };
      const receive = (input: typeof event, timestamp = String(Math.floor(Date.now() / 1000))) =>
        runtime.receive(input, {
          eventId: input.eventId,
          timestamp,
          signature: syncSignature(syncSecret, timestamp, input.eventId, input),
        });
      expect(await receive(event)).toMatchObject({ outcome: 'applied', replayed: false });
      expect(await receive(event)).toMatchObject({ outcome: 'applied', replayed: true });
      await expect(receive({ ...event, status: 'closed' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      expect(await receive({ ...event, eventId: randomUUID(), version: 1 })).toMatchObject({
        outcome: 'stale_ignored',
      });
      expect(await receive({ ...event, eventId: randomUUID(), version: 3, origin: 'agent18' })).toMatchObject(
        { outcome: 'echo_ignored' },
      );
      expect(
        (await db.query('SELECT count(*) FROM control.ticket_outbox WHERE case_id=$1', [ticket.id])).rows[0]
          .count,
      ).toBe('1');
      await expect(receive({ ...event, eventId: randomUUID() }, '1000000000')).rejects.toThrow(
        'SYNC_SIGNATURE_INVALID',
      );
      await db.query('UPDATE core.cases SET updated_at=now() WHERE id=$1', [ticket.id]);
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: [] }, owner);
      expect(await runtime.tick()).toMatchObject({ state: 'cancelled', reason: 'SYNC_PERMISSION_REVOKED' });
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: ['aurora'] }, owner);
    });
    it('queries and schedules approved business metrics with a service identity and fresh operator grants', async () => {
      const p = runtimeConfig.projects.find((p) => p.key === 'invoice-demo')!,
        base = '/operator/projects/invoice-demo';
      await db.query(
        "INSERT INTO core.tenants(organization_id,project_id,tenant_id,display_name) VALUES($1,$2,'alpha','Reference analytics tenant') ON CONFLICT DO NOTHING",
        [p.organizationId, p.projectId],
      );
      await post(
        base + '/support/access/' + adminId,
        { allTenants: false, tenantIds: ['aurora', 'alpha'] },
        owner,
      );
      const query = {
        metricId: 'sales.net',
        days: 7,
        tenant: 'alpha',
        dimensions: ['store'],
        title: 'Business snapshot',
        requestKey: randomUUID(),
      };
      const saved = await post(base + '/insights/analytics/query', query, owner);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().report.kind).toBe('analytics');
      expect(saved.json().report.scope).toEqual({ allTenants: false, tenantIds: ['alpha'] });
      expect((await post(base + '/insights/analytics/query', query, owner)).json()).toMatchObject({
        id: saved.json().id,
        replayed: true,
      });
      expect(
        (
          await post(
            base + '/insights/analytics/query',
            { ...query, tenant: 'beta', requestKey: randomUUID() },
            owner,
          )
        ).statusCode,
      ).toBe(403);
      const schedule = await post(
        base + '/insights/schedules',
        {
          title: 'Weekly conversion',
          definition: {
            kind: 'analytics_report',
            metricId: 'website.conversion',
            days: 7,
            dimensions: ['channel'],
            tenant: 'alpha',
            frequency: 'weekly',
            weekday: 1,
            time: '09:00',
            timezone: 'UTC',
          },
        },
        owner,
      );
      expect(schedule.statusCode, schedule.body).toBe(200);
      const job = await post(
        base + '/insights/schedules/' + schedule.json().id + '/run',
        { requestKey: randomUUID() },
        owner,
      );
      expect(job.statusCode, job.body).toBe(200);
      const runtime = new ReportAutomation(app.db, runtimeConfig.projects);
      expect(await runtime.tick()).toMatchObject({ id: job.json().id, state: 'completed' });
      const report = await app.app.inject({
        url: base + '/insights/reports/' + job.json().id,
        headers: { cookie: owner.cookie },
      });
      expect(report.statusCode, report.body).toBe(200);
      expect(report.json().payload.current.metricId).toBe('website.conversion');
      const stale = await post(
        base + '/insights/schedules/' + schedule.json().id + '/run',
        { requestKey: randomUUID() },
        owner,
      );
      const changed = structuredClone(runtimeConfig.projects);
      changed.find((x) => x.key === 'invoice-demo')!.analytics!.metrics[0]!.definition.version = '2';
      expect(await new ReportAutomation(app.db, changed).tick()).toMatchObject({
        id: stale.json().id,
        state: 'cancelled',
        reason: 'ANALYTICS_CONFIG_CHANGED',
      });
      const nativeFetch = globalThis.fetch;
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((r) => {
          entered = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
        if (String(args[0]).startsWith(p.analytics!.baseUrl)) {
          entered();
          await gate;
        }
        return nativeFetch(...args);
      });
      const pending = post(base + '/insights/analytics/query', { ...query, requestKey: randomUUID() }, owner);
      try {
        await Promise.race([
          started,
          pending.then((r) => {
            throw new Error('Query completed before external read: ' + r.statusCode + ' ' + r.body);
          }),
        ]);
        const revoked = await Promise.race([
          post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: ['aurora'] }, owner),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('External HTTP blocked permission revocation')), 3000),
          ),
        ]);
        expect(revoked.statusCode, revoked.body).toBe(200);
        release();
        expect((await pending).statusCode).toBe(403);
      } finally {
        release();
        await pending;
        fetchSpy.mockRestore();
      }
      expect(
        (
          await app.app.inject({
            url: base + '/insights/reports/' + saved.json().id,
            headers: { cookie: owner.cookie },
          })
        ).statusCode,
      ).toBe(404);
    });
    it('runs durable report schedules with isolated scope, pause, retry leases and live revocation', async () => {
      const base = '/operator/projects/invoice-demo';
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: ['aurora'] }, owner);
      const create = await post(
        base + '/insights/schedules',
        {
          title: 'Daily support',
          definition: { days: 30, tenant: 'aurora', frequency: 'daily', time: '09:00', timezone: 'UTC' },
        },
        owner,
      );
      expect(create.statusCode, create.body).toBe(200);
      const id = create.json().id;
      expect(
        (
          await post(
            base + '/insights/schedules',
            {
              title: 'Denied scope',
              definition: { days: 30, tenant: 'unknown', frequency: 'daily', time: '09:00', timezone: 'UTC' },
            },
            owner,
          )
        ).statusCode,
      ).toBe(403);
      const key = randomUUID(),
        queued = await post(base + '/insights/schedules/' + id + '/run', { requestKey: key }, owner);
      expect(queued.statusCode, queued.body).toBe(200);
      expect(
        (await post(base + '/insights/schedules/' + id + '/run', { requestKey: key }, owner)).json().id,
      ).toBe(queued.json().id);
      const runtime = new ReportAutomation(app.db, readConfig().projects),
        results = await Promise.all([runtime.tick(), runtime.tick()]);
      expect(
        results.some((r) => 'state' in r && r.state === 'completed'),
        JSON.stringify(results),
      ).toBe(true);
      const report = await app.app.inject({
        url: base + '/insights/reports/' + queued.json().id,
        headers: { cookie: owner.cookie },
      });
      expect(report.statusCode, report.body).toBe(200);
      expect(report.json().payload.scope).toEqual({ allTenants: false, tenantIds: ['aurora'] });
      expect(
        (await db.query('SELECT count(*) FROM control.insight_reports WHERE id=$1', [queued.json().id]))
          .rows[0].count,
      ).toBe('1');
      const second = await post(
        base + '/insights/schedules/' + id + '/run',
        { requestKey: randomUUID() },
        owner,
      );
      expect(
        (await post(base + '/insights/schedules/' + id, { version: 1, enabled: false }, owner)).statusCode,
      ).toBe(200);
      expect(
        (await db.query('SELECT state FROM control.automation_jobs WHERE id=$1', [second.json().id])).rows[0]
          .state,
      ).toBe('cancelled');
      expect(
        (await post(base + '/insights/schedules/' + id, { version: 1, enabled: true }, owner)).statusCode,
      ).toBe(409);
      expect(
        (await post(base + '/insights/schedules/' + id, { version: 2, enabled: true }, owner)).statusCode,
      ).toBe(200);
      const third = await post(
        base + '/insights/schedules/' + id + '/run',
        { requestKey: randomUUID() },
        owner,
      );
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: [] }, owner);
      expect(await runtime.tick()).toMatchObject({
        id: third.json().id,
        state: 'cancelled',
        reason: 'PERMISSION_REVOKED',
      });
      expect(
        (await db.query('SELECT enabled FROM control.report_schedules WHERE id=$1', [id])).rows[0].enabled,
      ).toBe(false);
      expect(
        (
          await app.app.inject({
            url: base + '/insights/reports/' + queued.json().id,
            headers: { cookie: owner.cookie },
          })
        ).statusCode,
      ).toBe(404);
      await post(base + '/support/access/' + adminId, { allTenants: false, tenantIds: ['aurora'] }, owner);
      const version = (await db.query('SELECT version FROM control.report_schedules WHERE id=$1', [id]))
        .rows[0].version;
      expect(
        (await post(base + '/insights/schedules/' + id + '/archive', { version }, owner)).statusCode,
      ).toBe(200);
      expect(
        (await post(base + '/insights/schedules/' + id + '/run', { requestKey: randomUUID() }, owner))
          .statusCode,
      ).toBe(404);
    });
    it('blocks high-priority customer publication until fixed candidates and semantic review pass', async () => {
      const base = '/operator/projects/invoice-demo/knowledge';
      const doc = (
        await post(
          base + '/documents',
          {
            title: 'Nebula archival contract',
            body: 'Nebula archival contract permits restore only from a reviewed snapshot.',
            category: 'overview',
            audience: 'customer',
          },
          owner,
        )
      ).json();
      const q = (
        await post(
          base + '/evaluation/questions',
          {
            question: 'Nebula archival contract',
            expectedSources: [doc.id],
            expectedAnswer: 'Restore requires a reviewed snapshot.',
            severity: 'high',
          },
          owner,
        )
      ).json();
      const empty = (
        await post(
          base + '/evaluation/questions',
          {
            question: 'zxqvnonexistentasteroidprotocol',
            expectedSources: [],
            expectNoAnswer: true,
            expectedAnswer: 'No evidence, do not invent an answer.',
          },
          owner,
        )
      ).json();
      const result = await post(
        base + '/evaluation/run',
        { questionIds: [q.id, empty.id], candidateDocuments: [{ id: doc.id, version: 1 }] },
        owner,
      );
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().results.find((r: { questionId: string }) => r.questionId === q.id)).toMatchObject({
        passed: false,
        candidatePassed: true,
        semanticReview: 'pending',
      });
      expect(
        result.json().results.find((r: { questionId: string }) => r.questionId === empty.id),
      ).toMatchObject({ passed: true, candidatePassed: true });
      for (const [i, action] of ['submit', 'approve'].entries())
        expect(
          (await post(base + '/documents/' + doc.id, { version: i + 1, action }, owner)).statusCode,
        ).toBe(200);
      expect(
        (await post(base + '/documents/' + doc.id, { version: 3, action: 'publish' }, owner)).json().error
          .code,
      ).toBe('KNOWLEDGE_EVAL_REVIEW_REQUIRED');
      const review = {
        runId: result.json().id,
        questionId: q.id,
        candidate: true,
        verdict: 'correct',
        note: 'Reviewed candidate text against the exact archival contract.',
      };
      expect((await post(base + '/evaluation/reviews', review, staff)).statusCode).toBe(403);
      expect((await post(base + '/evaluation/reviews', review, owner)).statusCode).toBe(200);
      expect(
        (await post(base + '/documents/' + doc.id, { version: 3, action: 'publish' }, owner)).statusCode,
      ).toBe(200);
      const forbidden = (
        await post(
          base + '/evaluation/questions',
          {
            question: 'Nebula archival contract',
            expectedSources: [],
            forbiddenSources: [doc.id],
            expectNoAnswer: true,
          },
          owner,
        )
      ).json();
      const failed = await post(base + '/evaluation/run', { questionIds: [forbidden.id] }, owner);
      expect(failed.json().results[0]).toMatchObject({ passed: false, forbiddenSources: [doc.id] });
      expect(
        (await post('/operator/projects/other-demo/knowledge/evaluation/reviews', review, owner)).statusCode,
      ).toBe(404);
    });
    it('records environment-scoped integration acceptance and expires it when configuration changes', async () => {
      const path = '/operator/projects/invoice-demo/integrations/readiness';
      const get = () =>
        app.app.inject({ url: path + '?environment=staging', headers: { cookie: owner.cookie } });
      const initial = (await get()).json();
      expect(initial.items.every((i: { status: string }) => i.status === 'unverified')).toBe(true);
      const input = {
        environment: 'staging',
        kind: 'knowledge',
        configHash: initial.configHash,
        status: 'passed',
        note: 'Executed a fixed published knowledge question set and verified tenant isolation.',
        evidenceRef: 'isolated-eval-report-20260920',
      };
      expect((await post(path, input, staff)).statusCode).toBe(403);
      expect((await post(path, input, owner)).statusCode).toBe(200);
      expect((await get()).json().items.find((i: { kind: string }) => i.kind === 'knowledge').status).toBe(
        'passed',
      );
      expect(
        (await app.app.inject({ url: path + '?environment=production', headers: { cookie: owner.cookie } }))
          .json()
          .items.every((i: { status: string }) => i.status === 'unverified'),
      ).toBe(true);
      const changedConfig = structuredClone(runtimeConfig);
      changedConfig.projects.find((p) => p.key === 'invoice-demo')!.displayName =
        'Configuration changed after acceptance';
      const changed = await buildApp(changedConfig, { dispatch: false });
      try {
        expect(
          (
            await changed.app.inject({
              url: path + '?environment=staging',
              headers: { cookie: owner.cookie },
            })
          )
            .json()
            .items.find((i: { kind: string }) => i.kind === 'knowledge').status,
        ).toBe('stale');
      } finally {
        await changed.app.close();
      }
      expect((await post(path, { ...input, configHash: '0'.repeat(64) }, owner)).statusCode).toBe(409);
    });
    it('revokes sessions on permission changes and prevents removing the last administrator', async () => {
      const stale = await service.session(staff.cookie.split('=')[1]!);
      expect(
        (
          await post(
            '/operator/accounts/' + adminId,
            { enabled: false, administrator: false, memberships: [] },
            owner,
          )
        ).json().error.code,
      ).toBe('OPERATOR_LAST_ADMIN');
      expect(
        (
          await post(
            '/operator/accounts/' + staffId,
            { enabled: false, administrator: false, memberships: [] },
            owner,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.app.inject({ url: '/operator/session', headers: { cookie: staff.cookie } })).statusCode,
      ).toBe(401);
      expect(
        (await post('/operator/login', { username: 'staff', password: permanentPassword })).statusCode,
      ).toBe(401);
      await expect(
        service.withPermission(stale, 'invoice-demo', 'knowledge.edit', async () => 'forbidden'),
      ).rejects.toMatchObject({ code: 'OPERATOR_FORBIDDEN' });
      expect(
        (
          await post(
            '/operator/accounts/' + staffId,
            { enabled: true, administrator: false, memberships: [] },
            owner,
          )
        ).statusCode,
      ).toBe(200);
      staff = await login('staff', permanentPassword);
      expect(
        (await app.app.inject({ url: '/operator/session', headers: { cookie: staff.cookie } })).json()
          .projects,
      ).toEqual([]);
    });
    it('expires idle sessions, resets passwords and records actors without credentials', async () => {
      const tokenHash = digest(staff.cookie.split('=')[1]!);
      await db.query(
        "UPDATE control.operator_sessions SET last_seen_at=now()-interval '31 minutes' WHERE token_hash=$1",
        [tokenHash],
      );
      expect(
        (await app.app.inject({ url: '/operator/session', headers: { cookie: staff.cookie } })).statusCode,
      ).toBe(401);
      const fresh = await login('staff', permanentPassword);
      expect(
        (await post('/operator/accounts/' + staffId + '/password', { password: staffPassword }, owner))
          .statusCode,
      ).toBe(200);
      expect(
        (await app.app.inject({ url: '/operator/session', headers: { cookie: fresh.cookie } })).statusCode,
      ).toBe(401);
      const logs = (await db.query('SELECT * FROM control.operator_audit')).rows;
      expect(
        logs.some(
          (r) => r.action === 'operator.permissions' && r.actor_id === adminId && r.target_id === staffId,
        ),
      ).toBe(true);
      for (const secret of [password, staffPassword, permanentPassword, owner.cookie])
        expect(JSON.stringify(logs)).not.toContain(secret);
      expect((await post('/operator/logout', {}, owner)).statusCode).toBe(200);
      expect(
        (await app.app.inject({ url: '/operator/session', headers: { cookie: owner.cookie } })).statusCode,
      ).toBe(401);
    });
    it('paginates and filters accounts and audit records without granting staff access', async () => {
      owner = await login('administrator', password);
      const get = (url: string) => app.app.inject({ url, headers: { cookie: owner.cookie } });
      const first = (await get('/operator/accounts?limit=1')).json();
      expect(first.accounts.map((a: { username: string }) => a.username)).toEqual(['administrator']);
      const second = (await get('/operator/accounts?limit=1&after=' + first.nextCursor)).json();
      expect(second.accounts.map((a: { username: string }) => a.username)).toEqual(['staff']);
      expect(second.nextCursor).toBeNull();
      expect((await get('/operator/accounts?search=knowledge&status=enabled')).json().accounts).toHaveLength(
        1,
      );
      expect((await get('/operator/accounts?search=%25')).json().accounts).toEqual([]);
      expect((await get('/operator/accounts?status=disabled')).json().accounts).toEqual([]);
      expect((await get('/operator/accounts?limit=999')).statusCode).toBe(400);
      const ids: string[] = [];
      let before = '';
      do {
        const response = await get('/operator/audit?limit=2' + (before ? '&before=' + before : ''));
        expect(response.headers['cache-control']).toBe('no-store');
        const page = response.json();
        ids.push(...page.events.map((e: { id: string }) => e.id));
        before = page.nextCursor;
      } while (before);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(
        Number((await db.query('SELECT count(*) FROM control.operator_audit')).rows[0].count),
      );
      const filtered = (await get('/operator/audit?action=operator.permissions&targetId=' + staffId)).json()
        .events;
      expect(filtered.length).toBeGreaterThan(0);
      expect(
        filtered.every(
          (e: { action: string; targetId: string }) =>
            e.action === 'operator.permissions' && e.targetId === staffId,
        ),
      ).toBe(true);
      staff = await login('staff', staffPassword);
      expect(
        (await app.app.inject({ url: '/operator/audit', headers: { cookie: staff.cookie } })).statusCode,
      ).toBe(403);
      await expect(app.db.query('DELETE FROM control.operator_audit')).rejects.toMatchObject({
        code: '42501',
      });
    });
    it('recovers only an existing administrator through local Owner access and forces password rotation', async () => {
      const recovered = 'Synthetic recovery password for isolated tests';
      const headers = {
        host: 'localhost:4321',
        origin: 'http://localhost:4321',
        authorization: 'Bearer synthetic-owner-bootstrap-access',
      };
      const payload = { username: 'administrator', confirmUsername: 'administrator', password: recovered };
      const call = (extra: Record<string, unknown> = {}) =>
        setup.inject({ method: 'POST', url: '/owner/operators/recover', headers, payload, ...extra });
      expect((await call({ remoteAddress: '192.0.2.9' })).statusCode).toBe(403);
      expect((await call({ headers: { host: 'localhost:4321' } })).statusCode).toBe(401);
      expect((await call({ headers: { ...headers, origin: 'https://foreign.example' } })).statusCode).toBe(
        403,
      );
      expect((await call({ payload: { ...payload, confirmUsername: 'different' } })).statusCode).toBe(400);
      expect(
        (await call({ payload: { ...payload, username: 'staff', confirmUsername: 'staff' } })).statusCode,
      ).toBe(404);
      expect((await post('/operator/recover', payload, owner)).statusCode).toBe(404);
      const old = await service.session(owner.cookie.split('=')[1]!);
      expect((await call()).statusCode).toBe(200);
      expect(
        (await app.app.inject({ url: '/operator/session', headers: { cookie: owner.cookie } })).statusCode,
      ).toBe(401);
      await expect(service.accounts(old)).rejects.toMatchObject({ code: 'OPERATOR_FORBIDDEN' });
      owner = await login('administrator', recovered);
      expect(
        (await app.app.inject({ url: '/operator/accounts', headers: { cookie: owner.cookie } })).statusCode,
      ).toBe(403);
      expect(
        (await post('/operator/password', { currentPassword: recovered, password }, owner)).statusCode,
      ).toBe(200);
      owner = await login('administrator', password);
      const logs = (
        await app.app.inject({
          url: '/operator/audit?action=operator.local_recovery',
          headers: { cookie: owner.cookie },
        })
      ).json().events;
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ actorId: null, targetId: adminId, targetUsername: 'administrator' });
      expect(JSON.stringify(logs)).not.toContain(recovered);
    });
    it('revokes restored sessions without deleting accounts or audit history', async () => {
      const count = Number((await db.query('SELECT count(*) FROM control.operator_audit')).rows[0].count);
      await db.query(revokeRestoredOperatorSessions);
      expect((await db.query('SELECT * FROM control.operator_sessions')).rowCount).toBe(0);
      expect((await db.query('SELECT * FROM control.operator_accounts')).rowCount).toBe(2);
      expect(Number((await db.query('SELECT count(*) FROM control.operator_audit')).rows[0].count)).toBe(
        count + 1,
      );
      expect(
        (await app.app.inject({ url: '/operator/session', headers: { cookie: owner.cookie } })).statusCode,
      ).toBe(401);
      owner = await login('administrator', password);
      const s = await service.session(owner.cookie.split('=')[1]!);
      await expect(
        service.withPermission(s, 'invoice-demo', 'source.configure', async (_client, p) => p.key),
      ).resolves.toBe('invoice-demo');
      // Old-schema compatibility is exercised transactionally, then rolled back.
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE control.operator_sessions RENAME TO saved_operator_sessions');
        await client.query(revokeRestoredOperatorSessions);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  },
);
