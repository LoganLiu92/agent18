import { it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createBackup, restoreBackup, activateRestore } from '../../scripts/lib/backup.js';
import { privacyReplaySql } from '../../scripts/lib/privacy.js';
it.skipIf(process.env.AGENT18_BACKUP_INTEGRATION !== '1')(
  'restores old schemas and reapplies privacy deletion before isolated activation',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent18-restore-check-'));
    const name = 'agent18_restore_check_' + randomBytes(6).toString('hex');
    const migration = JSON.parse(await readFile('.local/migration.json', 'utf8'));
    const admin = new Pool({ connectionString: migration.adminDatabaseUrl });
    const u = new URL(migration.adminDatabaseUrl);
    u.pathname = '/' + name;
    let db: Pool | undefined;
    const restored: string[] = [];
    const remap = (raw: string) => {
      const u = new URL(raw);
      u.pathname = '/' + name;
      return u.href;
    };
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      db = new Pool({ connectionString: u.href });
      for (const f of [
        'server.json',
        'server.docker.json',
        'worker.json',
        'worker.docker.json',
        'migration.json',
        'migration.docker.json',
        'indexer.json',
      ]) {
        const config = JSON.parse(await readFile(join('.local', f), 'utf8'));
        for (const k of ['databaseUrl', 'queueDatabaseUrl', 'adminDatabaseUrl'])
          if (config[k]) config[k] = remap(config[k]);
        await writeFile(join(root, f), JSON.stringify(config), { mode: 0o600 });
      }
      // Keep the existing Compose project, but all database targets and activation files are disposable.
      await writeFile(join(root, 'compose.env'), await readFile('.local/compose.env'), { mode: 0o600 });
      await db.query(
        'CREATE TABLE public.agent18_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const files = (await readdir('packages/persistence/migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      async function migrate(f: string) {
        const sql = await readFile(join('packages/persistence/migrations', f), 'utf8');
        await db!.query(sql);
        await db!.query('INSERT INTO public.agent18_migrations(name,checksum) VALUES($1,$2)', [
          f,
          createHash('sha256').update(sql).digest('hex'),
        ]);
      }
      for (const f of files.filter((f) => Number(f.slice(0, 3)) <= 17)) await migrate(f);
      await createBackup(root, join(root, 'old-backup'));
      const oldResult = await restoreBackup(root, join(root, 'old-backup'), false);
      if (!oldResult.database) throw new Error('RESTORE_DATABASE_MISSING');
      restored.push(oldResult.database);
      const oldUrl = new URL(u);
      oldUrl.pathname = '/' + oldResult.database;
      const oldDb = new Pool({ connectionString: oldUrl.href });
      try {
        if (
          Number((await oldDb.query('SELECT count(*) FROM public.agent18_migrations')).rows[0].count) !==
          files.length
        )
          throw new Error('UPGRADE_NOT_APPLIED');
      } finally {
        await oldDb.end();
      }

      for (const f of files.filter((f) => Number(f.slice(0, 3)) > 17)) await migrate(f);
      const cfg = JSON.parse(await readFile(join(root, 'server.json'), 'utf8')),
        p = cfg.projects[0],
        cid = randomUUID();
      await db.query(
        "INSERT INTO core.tenants(organization_id,project_id,tenant_id,display_name) VALUES($1,$2,'restore-qa','Restore fixture')",
        [p.organizationId, p.projectId],
      );
      await db.query(
        "INSERT INTO core.conversations(id,organization_id,project_id,tenant_id,subject,title,request_key) VALUES($1,$2,$3,'restore-qa','restore-customer','Private test conversation',$4)",
        [cid, p.organizationId, p.projectId, randomUUID()],
      );
      await db.query(
        "INSERT INTO core.conversation_messages(id,conversation_id,organization_id,project_id,tenant_id,subject,sequence,role,body,request_key) VALUES($1,$2,$3,$4,'restore-qa','restore-customer',1,'user','erase-me-content',$5)",
        [randomUUID(), cid, p.organizationId, p.projectId, randomUUID()],
      );
      await createBackup(root, join(root, 'new-backup'));
      await db.query(
        privacyReplaySql([
          {
            id: randomUUID(),
            organization_id: p.organizationId,
            project_id: p.projectId,
            tenant_id: 'restore-qa',
            subject: "restore-customer ' $privacy$",
            resource_type: 'conversation',
            resource_id: cid,
            created_at: new Date().toISOString(),
          },
        ]),
      );
      const next = await restoreBackup(root, join(root, 'new-backup'), false);
      if (!next.database) throw new Error('RESTORE_DATABASE_MISSING');
      restored.push(next.database);
      const targetUrl = new URL(u);
      targetUrl.pathname = '/' + next.database;
      const target = new Pool({ connectionString: targetUrl.href });
      try {
        const row = (
          await target.query('SELECT body FROM core.conversation_messages WHERE conversation_id=$1', [cid])
        ).rows[0];
        if (row.body !== '') throw new Error('DELETED_CONTENT_REVIVED');
        if (
          Number((await target.query('SELECT count(*) FROM control.privacy_tombstones')).rows[0].count) !== 1
        )
          throw new Error('LEDGER_MISSING');
      } finally {
        await target.end();
      }
      const applicationUrl = new URL(cfg.databaseUrl);
      const liveApp = new Pool({ connectionString: applicationUrl.href });
      try {
        await liveApp.query('SELECT 1');
        await expect(activateRestore(root, next.database)).rejects.toThrow('RESTORE_STOP_APPLICATION_FIRST');
      } finally {
        await liveApp.end();
      }
      await activateRestore(root, next.database);
      const activated = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));
      if (new URL(activated.databaseUrl).pathname !== '/' + next.database)
        throw new Error('ACTIVATION_NOT_APPLIED');
    } finally {
      await db?.end();
      // Let closing pool sockets drain; forced termination can emit idle-client errors.
      for (const n of restored) await admin.query(`DROP DATABASE ${n}`);
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
