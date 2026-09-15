import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localDirectory, configSchema } from './config.js';
import { atomicJson } from './lib/atomic.js';
const [projectKey, publicOrigin] = process.argv.slice(2);
try {
  if (!projectKey || !publicOrigin)
    throw new Error('Usage: pnpm deploy:prepare <real-project-key> <https-public-origin>');
  const url = new URL(publicOrigin);
  if (url.protocol !== 'https:' || url.origin !== publicOrigin)
    throw new Error('PUBLIC_HTTPS_ORIGIN_REQUIRED');
  const outputs = [];
  for (const file of ['server.json', 'server.docker.json']) {
    const c = configSchema.parse(JSON.parse(await readFile(resolve(localDirectory, file), 'utf8')));
    const p = c.projects.find((p) => p.key === projectKey);
    if (
      !p ||
      p.issuer === 'urn:agent18:demo-saas' ||
      !p.jwks.keys.length ||
      !p.allowedOrigins.length ||
      p.allowedOrigins.some((o) => !o.startsWith('https://'))
    )
      throw new Error('REGISTER_REAL_HTTPS_PROJECT_FIRST');
    if (p.knowledge !== 'indexed') throw new Error('PUBLISH_AND_ENABLE_REAL_KNOWLEDGE_FIRST');
    outputs.push({
      file,
      previous: c,
      next: configSchema.parse({
        ...c,
        projects: [p],
        consoleOrigin: publicOrigin,
        setupCompleted: true,
        displayName: p.displayName ?? p.key,
      }),
    });
  }
  const stamp = Date.now();
  for (const v of outputs) {
    await atomicJson(resolve(localDirectory, `${v.file}.${stamp}.backup`), v.previous);
    await atomicJson(resolve(localDirectory, v.file), v.next);
  }
  console.log(
    'Public deployment configuration prepared. Only the selected real project is active. Start with pnpm deploy:start, stop identity-demo, and configure HTTPS using deploy/proxy/Caddyfile.example. Previous local config is preserved.',
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : 'DEPLOYMENT_PREPARATION_FAILED');
  process.exitCode = 1;
}
