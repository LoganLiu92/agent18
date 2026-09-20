import { it, expect } from 'vitest';
import { gitCredentialEnvironment } from '../../packages/knowledge/src/git-credentials.js';
import { sourceSchema } from '@agent18/knowledge';
it('binds private Git credentials to the exact repository without persisting a secret URL', () => {
  const source = sourceSchema.parse({
      id: 'private-docs',
      name: 'Private',
      kind: 'git',
      location: 'https://git.example.com/org/repo.git',
      credentialEnv: 'AGENT18_GIT_TEST',
    }),
    secret = Buffer.from('oauth2:synthetic-private-token-1234').toString('base64'),
    env = {
      AGENT18_GIT_TEST: secret,
      AGENT18_GIT_CREDENTIAL_BINDINGS: JSON.stringify({ AGENT18_GIT_TEST: source.location }),
    };
  expect(gitCredentialEnvironment(source, env)).toEqual({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.' + source.location + '.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + secret,
  });
  expect(JSON.stringify(source)).not.toContain(secret);
  expect(() =>
    gitCredentialEnvironment({ ...source, location: 'https://evil.example.com/repo.git' }, env),
  ).toThrow('GIT_CREDENTIAL_BINDING_DENIED');
  expect(() => gitCredentialEnvironment(source, { ...env, AGENT18_GIT_TEST: undefined })).toThrow(
    'GIT_CREDENTIAL_MISSING',
  );
  expect(gitCredentialEnvironment({ ...source, credentialEnv: undefined }, env)).toEqual({});
});
