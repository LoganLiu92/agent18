import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, scoped } from '@agent18/persistence';
import { KnowledgeIndexer, IndexedKnowledgeProvider, sourceSchema, type JsonModel } from '@agent18/knowledge';
import { localDirectory, readConfig } from '../../scripts/config.js';
import { buildApp } from '../../apps/server/src/app.js';
import { SignJWT, importJWK } from 'jose';
import type { Scope } from '@agent18/contracts';
import { ToolGateway, knowledgeBinding } from '@agent18/application';
import { builtInTools, evidenceBatchSchema } from '@agent18/provider-contracts';

describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')('published knowledge and isolation', () => {
  let indexDb: InstanceType<typeof Pool>,
    appDb: InstanceType<typeof Pool>,
    root: string,
    indexer: KnowledgeIndexer,
    provider: IndexedKnowledgeProvider,
    scope: Scope,
    source: ReturnType<typeof sourceSchema.parse>;
  let first: string,
    second: string,
    citationId: string,
    citationSource: string,
    calls = 0,
    invalid = false;
  const model: JsonModel = {
    identity: 'contract-model-' + randomUUID(),
    complete: async (_system, input) => {
      calls++;
      if (invalid)
        return {
          value: {
            articles: [
              {
                title: 'Invalid',
                body: 'Invalid citation example',
                category: 'api',
                references: ['invented'],
              },
            ],
          },
          tokens: 1,
        };
      const { chunks } = input as { chunks: { key: string; text: string }[] };
      return {
        value: {
          articles: [
            {
              title: 'Indexed integration example',
              body: chunks.map((c) => c.text).join('\n'),
              category: 'workflows',
              references: chunks.map((c) => c.key),
            },
          ],
        },
        tokens: 20,
      };
    },
  };
  beforeAll(async () => {
    const config = readConfig(),
      credentials = JSON.parse(await readFile(join(localDirectory, 'indexer.json'), 'utf8'));
    indexDb = new Pool({ connectionString: credentials.databaseUrl });
    appDb = new Pool({ connectionString: config.databaseUrl });
    scope = {
      organizationId: config.projects[0]!.organizationId,
      projectId: config.projects[0]!.projectId,
      tenantId: 'tenant-a',
      subject: 'knowledge-test',
    };
    root = await mkdtemp(join(tmpdir(), 'agent18-index-'));
    source = sourceSchema.parse({
      id: 'test-' + randomUUID(),
      name: 'Integration test',
      kind: 'directory',
      location: root,
      audience: 'customer',
      tenantIds: ['tenant-a'],
    });
    await writeFile(join(root, 'guide.md'), '# UniqueKnowledgeSpec\nuniquealphakey helps create reports.');
    indexer = new KnowledgeIndexer(indexDb, scope, root, model);
    provider = new IndexedKnowledgeProvider(appDb);
  });
  afterAll(async () => {
    if (indexDb && source) await indexer.disable(source.id);
    await indexDb?.end();
    await appDb?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const search = (p = scope, query = 'uniquealphakey') =>
    provider.search({ query, limit: 5 }, { scope: p, requestId: 'test', signal: AbortSignal.timeout(3000) });
  it('keeps a built draft invisible until explicit publication', async () => {
    const build = await indexer.sync(source, { mode: 'model', maxModelCalls: 10 });
    first = build.buildId;
    expect(build.modelCalls).toBe(1);
    expect(await search()).toHaveLength(0);
    await indexer.publish(first);
    const rows = await search();
    expect(rows).toHaveLength(1);
    citationId = rows[0]!.id;
    citationSource = rows[0]!.source;
    const article = await provider.article(scope, citationId);
    expect(article?.references).toEqual([]);
    expect(article?.version).toBe('publication-' + first);
    expect(rows[0]!.version).toBe(article?.version);
    expect(JSON.stringify(article)).not.toContain('guide.md');
    const exported = await indexer.export(first);
    expect(exported[0]?.provenance).toMatchObject({
      schemaVersion: 1,
      source: { kind: 'directory', commit: null },
      generation: { runId: first, mode: 'model', model: { identity: model.identity } },
      deployment: { status: 'unknown', revision: null },
    });
    expect(exported[0]?.refs[0]).toMatchObject({
      sourceId: exported[0]?.provenance.source.id,
      snapshotId: exported[0]?.provenance.snapshot.id,
    });
    expect(exported[0]?.refs[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('watch deduplicates unchanged drafts but rebuilds changed visibility without auto-publication', async () => {
    const beforeCalls = calls;
    const same = await indexer.sync(source, { mode: 'model', maxModelCalls: 10, skipUnchanged: true });
    expect(same.unchanged).toBe(true);
    expect(same.buildId).toBe(first);
    expect(calls).toBe(beforeCalls);
    const restricted = await indexer.sync(
      { ...source, audience: 'internal' },
      { mode: 'model', maxModelCalls: 10, skipUnchanged: true },
    );
    expect(restricted.buildId).not.toBe(first);
    expect(await search()).toHaveLength(0);
    const restored = await indexer.sync(source, { mode: 'model', maxModelCalls: 10, skipUnchanged: true });
    expect(restored.buildId).not.toBe(restricted.buildId);
    expect(await search()).toHaveLength(0);
    await indexer.publish(first);
  });
  it('revokes a published snapshot before a failed scan after audience tightening', async () => {
    await expect(
      indexer.sync(
        { ...source, audience: 'internal', location: join(root, 'missing-directory') },
        { mode: 'model', maxModelCalls: 10, skipUnchanged: true },
      ),
    ).rejects.toThrow();
    expect(await search()).toHaveLength(0);
    await indexer.sync(source, { mode: 'model', maxModelCalls: 10, skipUnchanged: true });
    await indexer.publish(first);
  });
  it('serves indexed catalogue, article and model-free answers with authenticated HTTP scope', async () => {
    const config = readConfig();
    config.projects[0]!.knowledge = 'indexed';
    const server = await buildApp(config, { dispatch: false });
    try {
      const identity = JSON.parse(await readFile(join(localDirectory, 'identity.json'), 'utf8'));
      const token = await new SignJWT({
        kind: 'customer',
        tenant_id: scope.tenantId,
        project_key: config.projects[0]!.key,
        roles: [],
      })
        .setSubject(scope.subject)
        .setProtectedHeader({ alg: 'EdDSA', kid: identity.publicJwk.kid })
        .setIssuer(config.projects[0]!.issuer)
        .setAudience(config.projects[0]!.audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(await importJWK(identity.privateJwk, 'EdDSA'));
      const headers = { authorization: `Bearer ${token}`, 'x-project-key': config.projects[0]!.key };
      const catalogue = await server.app.inject({ url: '/api/knowledge/catalogue', headers });
      expect(catalogue.json().articles.some((a: { id: string }) => a.id === citationId)).toBe(true);
      const article = await server.app.inject({ url: `/api/knowledge/articles/${citationId}`, headers });
      expect(article.statusCode).toBe(200);
      expect(article.json().references).toEqual([]);
      expect(article.json().version).toBe('publication-' + first);
      expect(article.body).not.toContain('guide.md');
      expect(article.body).not.toContain('organizationId');
      const answer = await server.app.inject({
        method: 'POST',
        url: '/api/knowledge/ask',
        headers,
        payload: { query: 'uniquealphakey' },
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json().mode).toBe('retrieval_only');
      expect(answer.json().citations[0].id).toBe(citationId);
      expect(answer.json().citations[0].version).toBe('publication-' + first);
    } finally {
      await server.app.close();
    }
  });
  it('re-projects legacy citations from the current authorized publication and rejects forged source links', async () => {
    const [current] = await search();
    const legacy = {
      ...current!,
      version: 'private-commit',
      title: 'stale internal title',
      excerpt: '/private/code.ts',
    };
    const { scope: _scope, visibility: _visibility, ...safeLegacy } = legacy;
    const visible = await provider.visible(scope, [safeLegacy]);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ id: citationId, version: 'publication-' + first });
    expect(JSON.stringify(visible)).not.toMatch(/private-commit|private\/code|stale internal/);
    expect(await provider.visible({ ...scope, tenantId: 'tenant-b' }, [safeLegacy])).toEqual([]);
    expect(
      await provider.visible(scope, [{ ...safeLegacy, source: `knowledge://${randomUUID()}/${citationId}` }]),
    ).toEqual([]);
    const binding = knowledgeBinding(provider);
    const evidence = evidenceBatchSchema.parse(
      await binding.tools[0]!.invoke(
        { query: 'uniquealphakey', limit: 5 },
        { scope, requestId: 'legacy-case', signal: AbortSignal.timeout(3000) },
      ),
    );
    evidence[0]!.citation = safeLegacy;
    evidence[0]!.summary = 'stale internal summary';
    evidence[0]!.provenance.sourceVersion = 'private-commit';
    const gateway = new ToolGateway(appDb, undefined as never, provider);
    const resolve = vi.spyOn(gateway.registry, 'resolve').mockResolvedValue({
      tool: builtInTools.find((t) => t.id === 'knowledge.search')!,
      fingerprint: 'test',
    });
    try {
      const projected = await gateway.visibleEvidence(scope, evidence);
      expect(projected).toHaveLength(1);
      expect(projected[0]!.citation).toEqual(visible[0]);
      expect(JSON.stringify(projected)).not.toMatch(/private-commit|stale internal/);
      expect(evidence[0]!.provenance.sourceVersion).toBe('private-commit');
    } finally {
      resolve.mockRestore();
    }
  });
  it('does not expose drafts, internal sources, different tenants, projects or unscoped SQL', async () => {
    expect(await search({ ...scope, tenantId: 'tenant-b' })).toHaveLength(0);
    expect(await search({ ...scope, projectId: readConfig().projects[1]!.projectId })).toHaveLength(0);
    expect((await appDb.query('SELECT * FROM knowledge.articles')).rowCount).toBe(0);
    await expect(appDb.query('SELECT * FROM knowledge.cache')).rejects.toMatchObject({ code: '42501' });
    await expect(indexDb.query('SELECT * FROM core.cases')).rejects.toMatchObject({ code: '42501' });
    // The app role now supports staff publication; RLS still denies every customer/unscoped write.
    expect((await appDb.query('UPDATE knowledge.sources SET enabled=false')).rowCount).toBe(0);
    expect(
      (await scoped(appDb, scope, (c) => c.query('UPDATE knowledge.sources SET enabled=false RETURNING id')))
        .rowCount,
    ).toBe(0);
    expect((await search())[0]!.id).toBe(citationId);
    await expect(appDb.query('DELETE FROM knowledge.sources')).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps staff-managed publications outside the CLI watch source set', async () => {
    const sourceId = randomUUID();
    await scoped(indexDb, scope, (c) =>
      c.query(
        `INSERT INTO knowledge.sources(id,organization_id,project_id,source_key,name,audience) VALUES($1,$2,$3,$4,'Staff article','internal')`,
        [sourceId, scope.organizationId, scope.projectId, 'staff-' + sourceId],
      ),
    );
    const keys = await indexer.activeSourceKeys();
    expect(keys).toContain(source.id);
    expect(keys).not.toContain('staff-' + sourceId);
  });
  it('reuses unchanged model outputs and leaves previous published build intact', async () => {
    const before = calls,
      result = await indexer.sync(source, { mode: 'model', maxModelCalls: 10 });
    expect(calls).toBe(before);
    expect(result.cacheHits).toBe(1);
    expect((await search())[0]!.id).toBe(citationId);
  });
  it('rejects hallucinated citations without replacing the published knowledge', async () => {
    await writeFile(join(root, 'guide.md'), '# Changed\nuniquebetakey has new facts.');
    invalid = true;
    await expect(indexer.sync(source, { mode: 'model', maxModelCalls: 10 })).rejects.toMatchObject({
      code: 'MODEL_REFERENCES_INVALID',
    });
    expect((await search())[0]!.id).toBe(citationId);
    invalid = false;
  });
  it('atomically switches a complete snapshot and revokes old citation access', async () => {
    second = (await indexer.sync(source, { mode: 'model', maxModelCalls: 10 })).buildId;
    await indexer.publish(second);
    expect(await search()).toHaveLength(0);
    expect(await search(scope, 'uniquebetakey')).toHaveLength(1);
    expect(await provider.article(scope, citationId)).toBeNull();
    expect(
      await provider.visible(scope, [
        {
          id: citationId,
          title: 'old',
          excerpt: 'old',
          source: citationSource,
          version: '1',
          observedAt: new Date().toISOString(),
        },
      ]),
    ).toEqual([]);
  });
  it('keeps internal publications private and freezes audience changes until publication', async () => {
    const internal = { ...source, audience: 'internal' as const };
    const build = await indexer.sync(internal, { mode: 'extractive', maxModelCalls: 10 });
    expect(await search(scope, 'uniquebetakey')).toHaveLength(0);
    await indexer.publish(build.buildId);
    expect(await search(scope, 'uniquebetakey')).toHaveLength(0);
    await indexer.sync(source, { mode: 'extractive', maxModelCalls: 10 });
    expect(await search(scope, 'uniquebetakey')).toHaveLength(0);
    // Republishing an old internal build retains its original internal audience.
    await indexer.publish(build.buildId);
    expect(await search(scope, 'uniquebetakey')).toHaveLength(0);
    await indexer.publish(second);
    expect(await search(scope, 'uniquebetakey')).toHaveLength(1);
  });
  it('source disable immediately removes all published articles and preserves builds', async () => {
    await indexer.disable(source.id);
    expect(await search(scope, 'uniquebetakey')).toHaveLength(0);
    expect(
      (await scoped(indexDb, scope, (c) => c.query('SELECT * FROM knowledge.builds WHERE id=$1', [second])))
        .rowCount,
    ).toBe(1);
  });
  it('ranks a focused guide above a broad overview without including hidden exact matches', async () => {
    const query = 'OpenAPI 接入业务查询';
    await writeFile(join(root, 'guide.md'), '# OpenAPI 业务查询\n导入接口定义，再选择角色并启用业务查询。');
    await writeFile(
      join(root, 'overview.md'),
      '# 系统概览\nOpenAPI 接入业务查询。' + Array.from({ length: 150 }, (_, i) => `module${i} `).join(''),
    );
    const build = await indexer.sync(source, { mode: 'extractive', maxModelCalls: 10 });
    try {
      await indexer.publish(build.buildId);
      expect((await search(scope, query))[0]?.title).toContain('guide.md');
      expect(
        (await search({ ...scope, tenantId: 'tenant-b' }, query)).some((r) =>
          /^(guide|overview)\.md/.test(r.title),
        ),
      ).toBe(false);
      await indexer.sync({ ...source, audience: 'internal' }, { mode: 'extractive', maxModelCalls: 10 });
      expect((await search(scope, query)).some((r) => r.title.includes('guide.md'))).toBe(false);
    } finally {
      await indexer.disable(source.id);
    }
  });
});
