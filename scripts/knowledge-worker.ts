import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Pool } from '@agent18/persistence';
import { CompatibleModel, modelFromEnvironment } from '@agent18/knowledge';
import { readConfig, localDirectory } from './config.js';
import { processKnowledgeJob } from './lib/knowledge-worker.js';
import { processGenerationJob } from './lib/knowledge-generation-worker.js';
const allowed = z.array(z.string().min(1)).max(30);
const roots = allowed.parse(JSON.parse(process.env.AGENT18_KNOWLEDGE_ROOTS ?? '[]'));
const gitHosts = allowed.parse(JSON.parse(process.env.AGENT18_KNOWLEDGE_GIT_HOSTS ?? '[]'));
const credentials = JSON.parse(
  await readFile(process.env.AGENT18_INDEXER_CONFIG ?? resolve(localDirectory, 'indexer.json'), 'utf8'),
);
const db = new Pool({ connectionString: credentials.databaseUrl, max: 4 });
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
const workerConfig = async () =>
  process.env.AGENT18_KNOWLEDGE_CONFIG
    ? z
        .object({
          projects: z.array(
            z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid(), key: z.string() }),
          ),
        })
        .parse(JSON.parse(await readFile(process.env.AGENT18_KNOWLEDGE_CONFIG, 'utf8')))
    : readConfig();
try {
  const model = modelFromEnvironment();
  console.log('Knowledge worker ready. Only configured roots and Git hosts are readable.');
  do {
    const processed = await processKnowledgeJob(db, await workerConfig(), {
      roots,
      gitHosts,
      cacheDirectory: process.env.AGENT18_KNOWLEDGE_CACHE ?? resolve(localDirectory, 'git-cache'),
      model: model ? new CompatibleModel(model) : undefined,
      signal: abort.signal,
    });
    const generated = await processGenerationJob(db, await workerConfig(), {
      model: model ? new CompatibleModel(model) : undefined,
      signal: abort.signal,
    });
    if (process.argv.includes('--once')) break;
    if (!processed && !generated) await delay(2000, undefined, { signal: abort.signal }).catch(() => {});
  } while (!abort.signal.aborted);
} finally {
  await db.end();
}
