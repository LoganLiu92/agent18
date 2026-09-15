import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Pool } from '@agent18/persistence';
import {
  KnowledgeIndexer,
  KnowledgeError,
  knowledgeConfigSchema,
  modelFromEnvironment,
  CompatibleModel,
} from '@agent18/knowledge';
import { localDirectory, readConfig } from './config.js';
import { id } from '@agent18/contracts';

const [command = 'status', argument] = process.argv.slice(2);
const path = resolve(process.env.AGENT18_KNOWLEDGE_CONFIG ?? resolve(localDirectory, 'knowledge.json'));
if (command === 'init') {
  await writeFile(
    path,
    JSON.stringify(
      {
        projectKey: 'invoice-demo',
        mode: 'extractive',
        maxModelCalls: 100,
        sources: [
          {
            id: 'agent18-docs',
            name: 'Agent18 使用文档',
            kind: 'directory',
            location: resolve('.'),
            include: ['README.md', 'docs/guides/**/*.md'],
            audience: 'customer',
            tenantIds: [],
          },
          {
            id: 'agent18-source',
            name: 'Agent18 内部实现',
            kind: 'directory',
            location: resolve('.'),
            include: ['apps/**/*.ts', 'packages/**/*.ts', 'providers/**/*.ts'],
            audience: 'internal',
          },
        ],
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created .local/knowledge.json. Review sources and audience, then run pnpm knowledge sync.');
} else {
  let db: InstanceType<typeof Pool> | undefined;
  try {
    const config = knowledgeConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const server = readConfig();
    const project = server.projects.find((p) => p.key === config.projectKey);
    if (!project) throw new KnowledgeError('PROJECT_NOT_FOUND');
    const credentials = JSON.parse(await readFile(resolve(localDirectory, 'indexer.json'), 'utf8'));
    db = new Pool({ connectionString: credentials.databaseUrl, max: 3 });
    const modelConfig = modelFromEnvironment();
    const indexer = new KnowledgeIndexer(
      db,
      { ...project, tenantId: 'operator', subject: 'knowledge-cli' },
      resolve(localDirectory, 'git-cache'),
      modelConfig ? new CompatibleModel(modelConfig) : undefined,
    );
    if (command === 'sync') {
      const sources = config.sources.filter((s) => !argument || s.id === argument);
      if (!sources.length) throw new KnowledgeError('SOURCE_NOT_FOUND');
      for (const source of sources) {
        if (source.kind === 'directory') source.location = resolve(dirname(path), source.location);
        console.log(JSON.stringify(await indexer.sync(source, config), null, 2));
      }
    } else if (command === 'status') console.log(JSON.stringify(await indexer.status(), null, 2));
    else if (command === 'export')
      console.log(JSON.stringify(await indexer.export(id.parse(argument)), null, 2));
    else if (command === 'publish')
      console.log(JSON.stringify(await indexer.publish(id.parse(argument)), null, 2));
    else if (command === 'disable')
      console.log(JSON.stringify(await indexer.disable(argument ?? ''), null, 2));
    else if (command === 'enable') {
      for (const file of ['server.json', 'server.docker.json']) {
        const target = resolve(localDirectory, file);
        const raw = JSON.parse(await readFile(target, 'utf8'));
        for (const p of raw.projects) if (p.key === config.projectKey) p.knowledge = 'indexed';
        await writeFile(target, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
      }
      console.log('Indexed provider enabled in local server configuration. Restart server to apply.');
    } else throw new KnowledgeError('UNKNOWN_COMMAND');
  } catch (error) {
    console.error(error instanceof KnowledgeError ? error.code : 'KNOWLEDGE_COMMAND_FAILED');
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}
