import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localDirectory } from './config.js';
import { configureProject } from './lib/project-config.js';
try {
  const path = process.argv[2];
  if (!path) throw new Error('Configuration file required');
  await configureProject(JSON.parse(await readFile(resolve(path), 'utf8')), localDirectory);
  console.log('Project and tenants provisioned; restart server to apply trusted configuration.');
} catch {
  console.error(
    'PROJECT_CONFIGURATION_FAILED: check schema, public JWKS, database and project identity; no credentials are logged.',
  );
  process.exitCode = 1;
}
