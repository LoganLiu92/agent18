import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { localDirectory } from './config.js';
import { runRetention } from './lib/retention.js';
const flags = process.argv.slice(2);
if (flags.some((f) => f !== '--apply')) throw new Error('Usage: pnpm retention [--apply]');
const config = JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'));
const db = new Pool({ connectionString: config.adminDatabaseUrl, max: 1 });
try {
  console.log(JSON.stringify(await runRetention(db, flags.includes('--apply')), null, 2));
} finally {
  await db.end();
}
