import { it, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { registerGitCredentials } from '../../apps/setup/src/git-credentials.js';
it('stores exact repository bindings without returning tokens and revokes only the selected credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent18-git-credentials-')),
    app = Fastify();
  registerGitCredentials(app, dir, (fn) => fn());
  try {
    for (const name of ['AGENT18_GIT_ONE', 'AGENT18_GIT_TWO'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/owner/knowledge/git-credentials',
            payload: {
              name,
              repository: 'https://git.example.com/team/repo.git',
              username: 'oauth2',
              token: 'synthetic-credential-123456789',
            },
          })
        ).statusCode,
      ).toBe(200);
    const listing = await app.inject({ url: '/owner/knowledge/git-credentials' });
    expect(listing.body).not.toContain('synthetic-credential');
    expect(listing.json().bindings.AGENT18_GIT_ONE).toBe('https://git.example.com/team/repo.git');
    expect((await stat(join(dir, 'knowledge.env'))).mode & 0o777).toBe(0o600);
    const revoked = await app.inject({
      method: 'POST',
      url: '/owner/knowledge/git-credentials/revoke',
      payload: { name: 'AGENT18_GIT_ONE' },
    });
    expect(revoked.json()).toEqual({ revoked: true, restartRequired: true });
    const env = parseEnv(await readFile(join(dir, 'knowledge.env'), 'utf8'));
    expect(env.AGENT18_GIT_ONE).toBeUndefined();
    expect(env.AGENT18_GIT_TWO).toBeTruthy();
    expect(JSON.parse(env.AGENT18_GIT_CREDENTIAL_BINDINGS!)).toEqual({
      AGENT18_GIT_TWO: 'https://git.example.com/team/repo.git',
    });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
