import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSetupApp } from './app.js';
import { localDirectory } from '../../../scripts/config.js';
await mkdir(localDirectory, { recursive: true, mode: 0o700 });
const tokenPath = resolve(localDirectory, 'setup-access');
try {
  await writeFile(tokenPath, randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
const token = (await readFile(tokenPath, 'utf8')).trim();
if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('SETUP_ACCESS_FILE_INVALID');
const execute = promisify(execFile);
const app = await buildSetupApp({
  directory: localDirectory,
  token,
  apply: async () => {
    await execute(
      'docker',
      [
        'compose',
        '--env-file',
        resolve(localDirectory, 'compose.env'),
        '-f',
        'deploy/compose/compose.yaml',
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'server',
      ],
      { timeout: 90000, maxBuffer: 500000 },
    );
  },
});
await app.listen({ host: '127.0.0.1', port: 4321 });
console.log('Open http://localhost:4321/setup');
console.log(`Owner access code: ${token}`);
console.log(
  'This local configuration service can read selected source directories and save deployment settings. Stop with Ctrl+C when finished.',
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void app.close().then(() => process.exit(0)));
