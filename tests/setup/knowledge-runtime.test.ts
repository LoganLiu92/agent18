import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareKnowledgeRuntime } from '../../scripts/lib/knowledge-runtime.js';
it('prepares only indexer credentials and project identities for the knowledge container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent18-runtime-'));
  try {
    const project = {
      key: 'test',
      organizationId: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      issuer: 'private-issuer',
      audience: 'private-audience',
      jwks: { keys: [] },
    };
    await writeFile(
      join(root, 'server.docker.json'),
      JSON.stringify({
        databaseUrl: 'postgres://agent18_app:application-secret@postgres:5432/isolated',
        queueDatabaseUrl: 'postgres://queue:queue-secret@postgres/isolated',
        opaUrl: 'http://opa:8181',
        workerToken: 'x'.repeat(32),
        consoleOrigin: 'http://localhost:4318',
        projects: [project],
      }),
    );
    const local = join(root, 'indexer.json');
    await writeFile(
      local,
      JSON.stringify({ databaseUrl: 'postgres://agent18_indexer:index-secret@127.0.0.1:15432/old' }),
    );
    await prepareKnowledgeRuntime(root);
    const credentials = JSON.parse(await readFile(join(root, 'indexer.docker.json'), 'utf8'));
    expect(credentials.databaseUrl).toBe('postgres://agent18_indexer:index-secret@postgres:5432/isolated');
    const minimal = await readFile(join(root, 'knowledge-worker.json'), 'utf8');
    expect(JSON.parse(minimal)).toEqual({
      projects: [{ key: project.key, organizationId: project.organizationId, projectId: project.projectId }],
    });
    for (const secret of ['application-secret', 'queue-secret', 'private-issuer', 'private-audience'])
      expect(minimal).not.toContain(secret);
    expect((await stat(join(root, 'indexer.docker.json'))).mode & 0o777).toBe(0o600);
    await writeFile(local, JSON.stringify({ databaseUrl: 'postgres://agent18_app:bad@localhost/isolated' }));
    await expect(prepareKnowledgeRuntime(root)).rejects.toThrow('KNOWLEDGE_INDEXER_IDENTITY_REQUIRED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
