import { resolve } from 'node:path';
import { localDirectory } from './config.js';
import { startStack } from './lib/start-stack.js';

try {
  const [mode, ...extra] = process.argv.slice(2);
  if (!['demo', 'deploy'].includes(mode ?? '') || extra.length)
    throw new Error('Usage: pnpm demo:start | pnpm deploy:start');
  const demo = mode === 'demo';
  await startStack(
    [
      'compose',
      '--env-file',
      resolve(localDirectory, 'compose.env'),
      '-f',
      'deploy/compose/compose.yaml',
      ...(demo ? ['--profile', 'demo'] : []),
    ],
    { demo },
  );
  console.log('Current configuration loaded; Core is ready. Verify a customer request and a Worker run.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'STACK_START_FAILED');
  process.exitCode = 1;
}
