import { readFile, readdir, mkdir, copyFile, chmod, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { z } from 'zod';
import { parseEnv } from 'node:util';
import { atomicJson } from './atomic.js';
const manifestSchema = z
  .object({
    format: z.literal('agent18-backup-v1'),
    version: z.string(),
    createdAt: z.string(),
    files: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
            bytes: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(2)
      .max(200),
  })
  .strict();
async function checksum(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function composeRun(
  directory: string,
  args: string[],
  io: { input?: string; output?: string } = {},
) {
  const composeEnv = parseEnv(await readFile(resolve(directory, 'compose.env'), 'utf8'));
  const stack = composeEnv.AGENT18_STACK_NAME ?? process.env.AGENT18_STACK_NAME ?? 'agent18';
  const child = spawn(
    'docker',
    [
      'compose',
      '--project-name',
      stack,
      '--env-file',
      resolve(directory, 'compose.env'),
      '-f',
      'deploy/compose/compose.yaml',
      'exec',
      '-T',
      'postgres',
      ...args,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], shell: false },
  );
  let output = '';
  child.stderr.resume();
  if (!io.output)
    child.stdout.on('data', (chunk) => {
      if (output.length < 100000) output += chunk.toString();
    });
  if (!io.input) child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        child.once('error', () => reject(new Error('DOCKER_COMMAND_FAILED')));
        child.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error('DATABASE_BACKUP_COMMAND_FAILED')),
        );
      }),
      ...(io.input ? [pipeline(createReadStream(io.input), child.stdin)] : []),
      ...(io.output
        ? [pipeline(child.stdout, createWriteStream(io.output, { flags: 'wx', mode: 0o600 }))]
        : []),
    ]);
    return output;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}
export async function createBackup(directory: string, destination?: string) {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const target = resolve(
    destination ??
      resolve(
        directory,
        'backups',
        new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex'),
      ),
  );
  await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  try {
    const deployment = JSON.parse(await readFile(resolve(directory, 'server.docker.json'), 'utf8'));
    const database = new URL(deployment.databaseUrl);
    if (
      database.hostname !== 'postgres' ||
      new URL(deployment.queueDatabaseUrl).pathname !== database.pathname ||
      !/^\/[a-zA-Z0-9_]+$/.test(database.pathname)
    )
      throw new Error('BACKUP_REQUIRES_LOCAL_SHARED_POSTGRES');
    await composeRun(directory, ['pg_dump', '-U', 'postgres', '-d', database.pathname.slice(1), '-Fc'], {
      output: resolve(target, 'database.dump'),
    });
    const allowed =
      /^(server(?:\.docker)?\.json|worker(?:\.docker)?\.json|migration(?:\.docker)?\.json|indexer\.json|knowledge(?:\.[a-z][a-z0-9-]*)?\.json|model\.env|identity\.json|postgres-password)$/;
    for (const name of await readdir(directory))
      if (allowed.test(name)) {
        await copyFile(resolve(directory, name), resolve(target, name));
        await chmod(resolve(target, name), 0o600);
      }
    const businessPath = resolve(directory, 'business-data/preferences.sqlite');
    if (
      await stat(businessPath)
        .then((s) => s.isFile())
        .catch(() => false)
    ) {
      const db = new DatabaseSync(businessPath, { readOnly: true });
      try {
        await sqliteBackup(db, resolve(target, 'demo-business.sqlite'));
        await chmod(resolve(target, 'demo-business.sqlite'), 0o600);
      } finally {
        db.close();
      }
    }
    const files = [];
    for (const name of await readdir(target))
      files.push({
        name,
        bytes: (await stat(resolve(target, name))).size,
        sha256: await checksum(resolve(target, name)),
      });
    const manifest = manifestSchema.parse({
      format: 'agent18-backup-v1',
      version,
      createdAt: new Date().toISOString(),
      files,
    });
    await atomicJson(resolve(target, 'manifest.json'), manifest);
    return { directory: target, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), version };
  } catch (e) {
    await rm(target, { recursive: true, force: true });
    throw e;
  }
}
export async function verifyBackup(source: string) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8')));
  if (
    new Set(manifest.files.map((f) => f.name)).size !== manifest.files.length ||
    !manifest.files.some((f) => f.name === 'database.dump')
  )
    throw new Error('BACKUP_MANIFEST_INVALID');
  for (const f of manifest.files) {
    const path = resolve(source, f.name);
    const s = await stat(path);
    if (!s.isFile() || s.size !== f.bytes || (await checksum(path)) !== f.sha256)
      throw new Error('BACKUP_CHECKSUM_MISMATCH');
  }
  return manifest;
}
export async function restoreBackup(directory: string, source: string, verifyOnly = true) {
  const manifest = await verifyBackup(source);
  const database = 'agent18_restore_' + randomBytes(8).toString('hex');
  // Never overwrite a database. All DDL targets a fresh, internally generated name.
  await composeRun(directory, [
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE DATABASE ${database}`,
  ]);
  let keep = false;
  try {
    await composeRun(directory, ['pg_restore', '-U', 'postgres', '-d', database, '--exit-on-error'], {
      input: resolve(source, 'database.dump'),
    });
    const query =
      "SELECT json_build_object('cases',(SELECT count(*) FROM core.cases),'messages',(SELECT count(*) FROM core.case_messages),'articles',(SELECT count(*) FROM knowledge.articles),'proposals',(SELECT count(*) FROM core.action_proposals),'migrations',(SELECT count(*) FROM public.agent18_migrations))";
    const counts = JSON.parse(
      (
        await composeRun(directory, [
          'psql',
          '-U',
          'postgres',
          '-d',
          database,
          '-At',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          query,
        ])
      ).trim(),
    );
    const isolated = await composeRun(directory, [
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'SET ROLE agent18_app; SELECT count(*) FROM core.cases; SELECT count(*) FROM core.case_messages; SELECT count(*) FROM core.action_proposals;',
    ]);
    if (!/0\s+0\s+0\s*$/.test(isolated)) throw new Error('RESTORE_RLS_CHECK_FAILED');
    keep = !verifyOnly;
    if (keep) {
      await mkdir(resolve(directory, 'restores'), { recursive: true, mode: 0o700 });
      await atomicJson(resolve(directory, 'restores', database + '.json'), {
        database,
        source: resolve(source),
        verifiedAt: new Date().toISOString(),
        sourceVersion: manifest.version,
      });
    }
    return {
      verified: true,
      database: keep ? database : null,
      sourceVersion: manifest.version,
      counts,
      rls: 'unscoped application reads returned zero rows',
      configuration: 'Archived config preserved for operator review; active deployment unchanged.',
    };
  } finally {
    if (!keep)
      await composeRun(directory, [
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `DROP DATABASE ${database} WITH (FORCE)`,
      ]);
  }
}

export async function activateRestore(directory: string, database: string) {
  if (!/^agent18_restore_[a-f0-9]{16}$/.test(database)) throw new Error('RESTORE_DATABASE_INVALID');
  const marker = JSON.parse(await readFile(resolve(directory, 'restores', database + '.json'), 'utf8'));
  if (marker.database !== database) throw new Error('RESTORE_NOT_VERIFIED');
  await composeRun(directory, [
    'psql',
    '-U',
    'postgres',
    '-d',
    database,
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'SELECT count(*) FROM public.agent18_migrations',
  ]);
  const stamp = Date.now(),
    files = [
      'server.json',
      'server.docker.json',
      'worker.json',
      'worker.docker.json',
      'migration.json',
      'migration.docker.json',
      'indexer.json',
    ];
  const updates = [];
  for (const file of files) {
    const previous = JSON.parse(await readFile(resolve(directory, file), 'utf8')),
      next = structuredClone(previous);
    for (const key of ['databaseUrl', 'queueDatabaseUrl', 'adminDatabaseUrl'])
      if (next[key]) {
        const url = new URL(next[key]);
        if (!['localhost', '127.0.0.1', 'postgres'].includes(url.hostname))
          throw new Error('RESTORE_REQUIRES_LOCAL_POSTGRES');
        url.pathname = '/' + database;
        next[key] = url.toString();
      }
    updates.push({ file, previous, next });
  }
  for (const u of updates) await atomicJson(resolve(directory, `${u.file}.${stamp}.backup`), u.previous);
  for (const u of updates) await atomicJson(resolve(directory, u.file), u.next);
  return {
    database,
    configured: true,
    restartRequired: true,
    instruction:
      'Recreate server and worker using deploy:start. Original database and prior configuration copies are retained.',
  };
}
