import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson } from './atomic.js';
import { configSchema } from '../config.js';
/** Prepare an indexer-only container configuration; never mount application DB credentials in it. */
export async function prepareKnowledgeRuntime(directory: string) {
  const server = configSchema.parse(
    JSON.parse(await readFile(resolve(directory, 'server.docker.json'), 'utf8')),
  );
  const local = JSON.parse(await readFile(resolve(directory, 'indexer.json'), 'utf8'));
  const db = new URL(local.databaseUrl),
    network = new URL(server.databaseUrl);
  if (db.username !== 'agent18_indexer') throw new Error('KNOWLEDGE_INDEXER_IDENTITY_REQUIRED');
  db.hostname = network.hostname;
  db.port = network.port;
  db.pathname = network.pathname;
  await mkdir(resolve(directory, 'knowledge-sources'), { recursive: true, mode: 0o700 });
  await mkdir(resolve(directory, 'knowledge-cache'), { recursive: true, mode: 0o700 });
  await atomicJson(resolve(directory, 'indexer.docker.json'), { databaseUrl: db.href });
  // Only indexing needs project identity and key; business API and customer authentication configs stay in Core.
  await atomicJson(resolve(directory, 'knowledge-worker.json'), {
    projects: server.projects.map((p) => ({
      organizationId: p.organizationId,
      projectId: p.projectId,
      key: p.key,
    })),
  });
}
