import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Pool } from '@agent18/persistence';
import { canonical, toolDescriptorSchema } from '@agent18/provider-contracts';
import { localDirectory } from './config.js';
const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    transport: z.enum(['native', 'http', 'openapi', 'mcp']),
    capabilities: z.array(z.string().max(100)).min(1).max(50),
    tools: z
      .array(
        z
          .object({
            descriptor: toolDescriptorSchema,
            schemas: z
              .object({ input: z.record(z.string(), z.unknown()), output: z.record(z.string(), z.unknown()) })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const [command = 'list', argument, expectedHash] = process.argv.slice(2);
const config = JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'));
const db = new Pool({ connectionString: config.adminDatabaseUrl, max: 1 });
const snapshot = async (id: string) => ({
  provider: (
    await db.query('SELECT id,version,transport,capabilities FROM control.providers WHERE id=$1', [id])
  ).rows[0],
  tools: (
    await db.query(
      'SELECT id,version,effect,stage,audience,provider,capability,risk,resource_types,environment_policy,schemas FROM control.tools WHERE provider=$1 ORDER BY id',
      [id],
    )
  ).rows,
});
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
try {
  if (command === 'list') {
    console.log(
      JSON.stringify(
        {
          providers: (
            await db.query(
              'SELECT id,version,transport,review,reviewed_by,reviewed_at FROM control.providers ORDER BY id',
            )
          ).rows,
          tools: (
            await db.query(
              'SELECT id,version,capability,provider,review,effect,stage,risk FROM control.tools ORDER BY id',
            )
          ).rows,
        },
        null,
        2,
      ),
    );
  } else if (command === 'inspect') {
    const value = await snapshot(argument!);
    if (!value.provider) throw new Error('PROVIDER_NOT_FOUND');
    console.log(JSON.stringify({ ...value, fingerprint: digest(value) }, null, 2));
  } else {
    await db.query('BEGIN');
    // Serialize owner registry mutations with other invocations of this CLI.
    await db.query('SELECT pg_advisory_xact_lock(181819)');
    if (command === 'import') {
      const raw = await readFile(resolve(argument!), 'utf8');
      if (Buffer.byteLength(raw) > 200000) throw new Error('MANIFEST_TOO_LARGE');
      const candidate = manifestSchema.parse(JSON.parse(raw));
      if (new Set(candidate.tools.map((t) => t.descriptor.id)).size !== candidate.tools.length)
        throw new Error('DUPLICATE_TOOL');
      for (const { descriptor: t } of candidate.tools)
        if (t.provider !== candidate.id || !candidate.capabilities.includes(t.capability))
          throw new Error('MANIFEST_CAPABILITY_MISMATCH');
      await db.query(
        "INSERT INTO control.providers(id,version,review,transport,capabilities) VALUES($1,$2,'pending',$3,$4) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,transport=EXCLUDED.transport,capabilities=EXCLUDED.capabilities,review='pending',reviewed_at=NULL,reviewed_by=NULL",
        [candidate.id, candidate.version, candidate.transport, JSON.stringify(candidate.capabilities)],
      );
      await db.query("UPDATE control.tools SET review='revoked' WHERE provider=$1", [candidate.id]);
      for (const { descriptor: t, schemas } of candidate.tools) {
        const old = (await db.query('SELECT provider,version FROM control.tools WHERE id=$1', [t.id]))
          .rows[0];
        if (old && (old.provider !== candidate.id || old.version > t.version))
          throw new Error('TOOL_ID_OR_VERSION_CONFLICT');
        await db.query(
          "INSERT INTO control.tools(id,version,review,effect,stage,audience,provider,capability,risk,resource_types,environment_policy,schemas) VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,review='pending',effect=EXCLUDED.effect,stage=EXCLUDED.stage,audience=EXCLUDED.audience,provider=EXCLUDED.provider,capability=EXCLUDED.capability,risk=EXCLUDED.risk,resource_types=EXCLUDED.resource_types,environment_policy=EXCLUDED.environment_policy,schemas=EXCLUDED.schemas,reviewed_at=NULL,reviewed_by=NULL",
          [
            t.id,
            t.version,
            t.effect,
            t.stage,
            t.audience,
            t.provider,
            t.capability,
            t.risk,
            JSON.stringify(t.resourceTypes),
            JSON.stringify(t.environmentPolicy),
            JSON.stringify(schemas),
          ],
        );
      }
      console.log(
        JSON.stringify({
          provider: candidate.id,
          state: 'pending',
          fingerprint: digest(await snapshot(candidate.id)),
        }),
      );
    } else if (command === 'approve') {
      const value = await snapshot(argument!);
      if (!value.provider || !expectedHash || digest(value) !== expectedHash)
        throw new Error('REVIEW_FINGERPRINT_MISMATCH');
      await db.query(
        "UPDATE control.providers SET review='approved',reviewed_at=now(),reviewed_by='owner-cli' WHERE id=$1",
        [argument],
      );
      await db.query(
        "UPDATE control.tools SET review='approved',reviewed_at=now(),reviewed_by='owner-cli' WHERE provider=$1 AND review='pending'",
        [argument],
      );
      console.log(JSON.stringify({ provider: argument, state: 'approved', fingerprint: expectedHash }));
    } else if (command === 'revoke') {
      const result = await db.query(
        "UPDATE control.providers SET review='revoked',reviewed_at=now(),reviewed_by='owner-cli' WHERE id=$1",
        [argument],
      );
      if (!result.rowCount) throw new Error('PROVIDER_NOT_FOUND');
      console.log(JSON.stringify({ provider: argument, state: 'revoked' }));
    } else throw new Error('UNKNOWN_REGISTRY_COMMAND');
    await db.query('INSERT INTO control.security_events(id,request_id,reason) VALUES($1,$2,$3)', [
      crypto.randomUUID(),
      crypto.randomUUID(),
      'OWNER_REGISTRY_' + command.toUpperCase(),
    ]);
    await db.query('COMMIT');
  }
} catch (error) {
  await db.query('ROLLBACK');
  console.error(
    error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'REGISTRY_COMMAND_FAILED',
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
