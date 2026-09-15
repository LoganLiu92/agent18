import { createBackup, restoreBackup, activateRestore } from './lib/backup.js';
import { localDirectory } from './config.js';
const [command = 'create', path] = process.argv.slice(2);
try {
  if (command === 'create') console.log(JSON.stringify(await createBackup(localDirectory, path), null, 2));
  else if (command === 'activate' && path)
    console.log(JSON.stringify(await activateRestore(localDirectory, path), null, 2));
  else if ((command === 'verify' || command === 'restore') && path)
    console.log(JSON.stringify(await restoreBackup(localDirectory, path, command === 'verify'), null, 2));
  else
    throw new Error(
      'Usage: pnpm backup [output-directory] | pnpm backup:verify <backup-directory> | pnpm restore <backup-directory>',
    );
} catch (e) {
  console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'BACKUP_COMMAND_FAILED');
  process.exitCode = 1;
}
