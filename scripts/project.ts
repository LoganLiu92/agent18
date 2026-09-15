import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Pool } from '@agent18/persistence';
import { configSchema, localDirectory } from './config.js';
const inputSchema = z
  .object({
    project: configSchema.shape.projects.element,
    organizationName: z.string().min(1).max(200),
    projectName: z.string().min(1).max(200),
    tenants: z
      .array(z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(200) }).strict())
      .min(1)
      .max(1000),
  })
  .strict();
let db: InstanceType<typeof Pool> | undefined;
try {
  const path = process.argv[2];
  if (!path) throw new Error('Supply a deployment project configuration file');
  const input = inputSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8'))),
    p = input.project;
  if (
    !/^[a-z][a-z0-9-]{1,63}$/.test(p.key) ||
    !p.jwks.keys.length ||
    p.jwks.keys.some(
      (k) =>
        k.kty !== 'OKP' ||
        k.crv !== 'Ed25519' ||
        typeof k.x !== 'string' ||
        typeof k.kid !== 'string' ||
        ['d', 'p', 'q', 'k', 'dp', 'dq', 'qi', 'oth'].some((field) => field in k),
    )
  )
    throw new Error('Use public Ed25519 JWKS only');
  for (const origin of p.allowedOrigins)
    if (new URL(origin).origin !== origin)
      throw new Error('Origins must be exact scheme/host/port with no trailing slash or path');
  const files = ['server.json', 'server.docker.json'];
  const configurations = [];
  for (const file of files) {
    const target = resolve(localDirectory, file),
      config = JSON.parse(await readFile(target, 'utf8'));
    const old = config.projects.find((v: { key: string }) => v.key === p.key);
    if (old && (old.organizationId !== p.organizationId || old.projectId !== p.projectId))
      throw new Error('Existing project identity cannot be reassigned');
    config.projects = config.projects.filter((v: { key: string }) => v.key !== p.key);
    config.projects.push(p);
    configSchema.parse(config);
    configurations.push({ target, config });
  }
  db = new Pool({
    connectionString: JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'))
      .adminDatabaseUrl,
  });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO core.organizations(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name',
      [p.organizationId, input.organizationName],
    );
    const existing = (
      await client.query(
        'SELECT organization_id,id,project_key FROM core.projects WHERE project_key=$1 OR (organization_id=$2 AND id=$3)',
        [p.key, p.organizationId, p.projectId],
      )
    ).rows;
    if (
      existing.some(
        (r) => r.project_key !== p.key || r.organization_id !== p.organizationId || r.id !== p.projectId,
      )
    )
      throw new Error('Project identity conflict');
    await client.query(
      'INSERT INTO core.projects(organization_id,id,project_key,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,id) DO UPDATE SET display_name=excluded.display_name',
      [p.organizationId, p.projectId, p.key, input.projectName],
    );
    for (const tenant of input.tenants)
      await client.query(
        'INSERT INTO core.tenants(organization_id,project_id,tenant_id,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,project_id,tenant_id) DO UPDATE SET display_name=excluded.display_name',
        [p.organizationId, p.projectId, tenant.id, tenant.name],
      );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  for (const { target, config } of configurations)
    await writeFile(target, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log('Project and tenants provisioned; restart server to apply trusted configuration.');
} catch {
  console.error(
    'PROJECT_CONFIGURATION_FAILED: check schema, public JWKS, database and project identity; no credentials are logged.',
  );
  process.exitCode = 1;
} finally {
  await db?.end();
}
