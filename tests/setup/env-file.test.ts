import { it, expect } from 'vitest';
import { parseEnv } from 'node:util';
import { serializeEnv } from '../../scripts/lib/env-file.js';
it('round-trips nested JSON, paths and opaque secret characters without JSON double escaping', () => {
  const values = {
    BINDINGS: JSON.stringify({ AGENT18_GIT_TEST: 'https://example.com/team/repo.git' }),
    ROOTS: JSON.stringify(['/tmp/knowledge']),
    OPAQUE: 'sample$#value\\n',
    PATH_WITH_QUOTE: "/tmp/owner's docs",
  };
  expect(parseEnv(serializeEnv(values))).toEqual(values);
  expect(() => serializeEnv({ 'BAD\nKEY': 'x' })).toThrow('ENV_VALUE_UNSUPPORTED');
});
