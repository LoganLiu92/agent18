import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { localDirectory } from './config.js';

const config = JSON.parse(
  await readFile(process.env.AGENT18_MIGRATION_CONFIG ?? resolve(localDirectory, 'migration.json'), 'utf8'),
);
const client = new pg.Client(config.adminDatabaseUrl);
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(181818)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS public.agent18_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const role of ['agent18_owner', 'agent18_app', 'agent18_queue', 'agent18_indexer']) {
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
      const password =
        role === 'agent18_app'
          ? config.appPassword
          : role === 'agent18_indexer'
            ? config.indexerPassword
            : config.queuePassword;
      if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid generated database credential format');
      await client.query(
        `CREATE ROLE ${role} ${role === 'agent18_owner' ? 'NOLOGIN' : `LOGIN PASSWORD '${password}'`} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
    }
  }
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION agent18_queue');
  for (const file of (await readdir('packages/persistence/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = await readFile(resolve('packages/persistence/migrations', file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const applied = (
      await client.query('SELECT checksum FROM public.agent18_migrations WHERE name=$1', [file])
    ).rows[0];
    if (applied) {
      if (applied.checksum !== checksum) throw new Error(`Migration checksum changed: ${file}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.agent18_migrations (name,checksum) VALUES ($1,$2)', [
        file,
        checksum,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log(`Applied ${file}`);
  }
  // Queue DDL runs as the one-shot migrator. Runtime workers receive DML on this schema only.
  const boss = new PgBoss({ connectionString: config.adminDatabaseUrl, schema: 'pgboss' });
  boss.on('error', () => console.error('Queue migration error'));
  await boss.start();
  await boss.createQueue('support-investigation', {
    retryLimit: 8,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 120,
  });
  await boss.stop();
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO agent18_queue');
  await client.query('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO agent18_queue');
  await client.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO agent18_queue');
  console.log('Database and queue migrations ready.');
} finally {
  await client.query('SELECT pg_advisory_unlock(181818)');
  await client.end();
}
