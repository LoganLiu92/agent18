import { dirname } from 'node:path';
import { prepareKnowledgeRuntime } from './knowledge-runtime.js';
import { spawn } from 'node:child_process';

/** Recreate file-mounted consumers even when only an atomic config replacement changed. */
export async function startStack(
  compose: string[],
  { build = true, demo = false }: { build?: boolean; demo?: boolean } = {},
) {
  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn('docker', [...compose, ...args], {
        stdio: 'inherit',
        timeout: 600000,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Compose ${args[0]} failed (${code ?? signal})`)),
      );
    });

  const envFile = compose[compose.indexOf('--env-file') + 1];
  if (!envFile || !compose.includes('--env-file')) throw new Error('COMPOSE_ENV_FILE_REQUIRED');
  await prepareKnowledgeRuntime(dirname(envFile));
  // Build before disrupting running consumers. PostgreSQL keeps its container and volume.
  if (build) await run(['build', 'server']);
  await run(['up', '-d', '--wait', 'postgres']);
  await run(['up', '-d', '--no-deps', '--force-recreate', 'opa']);
  // Keep the completed service so later `compose start` can verify server's migration dependency.
  // Recreate it on each deployment to read the current file mount, including restored DB targets.
  await run(['up', '--no-deps', '--force-recreate', '--exit-code-from', 'migrate', 'migrate']);
  await run(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'server']);
  await run(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'worker']);
  await run(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'knowledge-worker']);
  if (demo) await run(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'identity-demo']);
}
