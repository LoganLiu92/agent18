import { demoBridge, demoQueries } from './lib/demo-bridge.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localDirectory } from './config.js';
for (const file of ['server.json', 'server.docker.json']) {
  const path = resolve(localDirectory, file),
    config = JSON.parse(await readFile(path, 'utf8'));
  const project = config.projects.find((p: { key: string }) => p.key === 'invoice-demo');
  if (!project) throw new Error('Demo project not found');
  project.allowedOrigins = [...new Set([...(project.allowedOrigins ?? []), 'http://localhost:4319'])];
  project.businessBridge = demoBridge(file.includes('docker'));
  project.businessQueries = demoQueries(file.includes('docker'));
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
console.log('Demo action registered. Restart server and identity-demo to apply.');
