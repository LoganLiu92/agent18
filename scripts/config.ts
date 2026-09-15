import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { bridgeSchema } from '@agent18/actions';

export const localDirectory = resolve(process.env.AGENT18_LOCAL_DIR ?? '.local');
export const configSchema = z.object({
  setupCompleted: z.boolean().default(false),
  displayName: z.string().max(120).default('agent18'),
  databaseUrl: z.string(),
  queueDatabaseUrl: z.string(),
  opaUrl: z.string().url(),
  workerToken: z.string().min(32),
  consoleOrigin: z.string().url(),
  projects: z
    .array(
      z.object({
        key: z.string(),
        displayName: z.string().max(120).optional(),
        businessBridge: bridgeSchema.optional(),
        knowledge: z.enum(['fixture', 'indexed']).default('fixture'),
        allowedOrigins: z.array(z.string().url()).default([]),
        organizationId: z.string().uuid(),
        projectId: z.string().uuid(),
        issuer: z.string(),
        audience: z.string(),
        jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }),
      }),
    )
    .min(1),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(): Config {
  const raw = JSON.parse(
    readFileSync(process.env.AGENT18_CONFIG ?? resolve(localDirectory, 'server.json'), 'utf8'),
  );
  return configSchema.parse(raw);
}
