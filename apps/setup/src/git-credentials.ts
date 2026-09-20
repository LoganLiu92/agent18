import { serializeEnv } from '../../../scripts/lib/env-file.js';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KnowledgeError } from '@agent18/knowledge';
export function registerGitCredentials(
  app: FastifyInstance,
  directory: string,
  mutate: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  const path = resolve(directory, 'knowledge.env'),
    read = async () => parseEnv(await readFile(path, 'utf8').catch(() => ''));
  app.get('/owner/knowledge/git-credentials', async () => {
    const env = await read();
    return {
      bindings: JSON.parse(env.AGENT18_GIT_CREDENTIAL_BINDINGS ?? '{}'),
      hosts: JSON.parse(env.AGENT18_KNOWLEDGE_GIT_HOSTS ?? '[]'),
    };
  });
  app.post('/owner/knowledge/git-credentials/revoke', (req) =>
    mutate(async () => {
      const { name } = z
        .object({
          name: z
            .string()
            .regex(/^AGENT18_GIT_[A-Z0-9_]{1,60}$/)
            .refine((v) => v !== 'AGENT18_GIT_CREDENTIAL_BINDINGS'),
        })
        .strict()
        .parse(req.body);
      const env = await read();
      const bindings = JSON.parse(env.AGENT18_GIT_CREDENTIAL_BINDINGS ?? '{}') as Record<string, string>;
      delete bindings[name];
      delete env[name];
      env.AGENT18_GIT_CREDENTIAL_BINDINGS = JSON.stringify(bindings);
      await writeFile(path, serializeEnv(env), { mode: 0o600 });
      await chmod(path, 0o600);
      return { revoked: true, restartRequired: true };
    }),
  );
  app.post('/owner/knowledge/git-credentials', (req) =>
    mutate(async () => {
      const input = z
          .object({
            name: z
              .string()
              .regex(/^AGENT18_GIT_[A-Z0-9_]{1,60}$/)
              .refine((v) => v !== 'AGENT18_GIT_CREDENTIAL_BINDINGS'),
            repository: z
              .string()
              .url()
              .max(1000)
              .refine((v) => {
                const u = new URL(v);
                return (
                  u.protocol === 'https:' &&
                  !u.username &&
                  !u.password &&
                  !u.search &&
                  !u.hash &&
                  (!u.port || u.port === '443') &&
                  u.pathname.endsWith('.git')
                );
              }),
            username: z.string().regex(/^[a-zA-Z0-9_.@-]{1,100}$/),
            token: z
              .string()
              .min(16)
              .max(4000)
              .regex(/^[A-Za-z0-9._~+\/=-]+$/),
          })
          .strict()
          .parse(req.body),
        env = await read(),
        bindings = JSON.parse(env.AGENT18_GIT_CREDENTIAL_BINDINGS ?? '{}') as Record<string, string>,
        hosts = JSON.parse(env.AGENT18_KNOWLEDGE_GIT_HOSTS ?? '[]') as string[];
      if (Object.keys(bindings).length >= 30 && !bindings[input.name])
        throw new KnowledgeError('CREDENTIAL_LIMIT');
      bindings[input.name] = input.repository;
      env.AGENT18_GIT_CREDENTIAL_BINDINGS = JSON.stringify(bindings);
      env[input.name] = Buffer.from(input.username + ':' + input.token).toString('base64');
      env.AGENT18_KNOWLEDGE_GIT_HOSTS = JSON.stringify([
        ...new Set([...hosts, new URL(input.repository).hostname]),
      ]);
      await writeFile(path, serializeEnv(env), { mode: 0o600 });
      await chmod(path, 0o600);
      return { saved: true, restartRequired: true };
    }),
  );
}
