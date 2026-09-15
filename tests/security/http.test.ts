import { describe, it, expect } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { configSchema } from '../../scripts/config.js';

describe('HTTP content security policy', () => {
  it.each([
    ['http://localhost:4318', 'urn:agent18:demo-saas', '/console?view=cases', true],
    ['http://localhost:4318', 'urn:agent18:demo-saas', '/support', false],
    ['http://localhost:4318', 'urn:agent18:demo-saas', '/', false],
    ['https://support.example.com', 'urn:agent18:demo-saas', '/console', false],
    ['http://localhost:4318', 'urn:customer:saas', '/console', false],
  ])('scopes demo connections for %s %s %s', async (consoleOrigin, issuer, url, demo) => {
    const config = configSchema.parse({
      consoleOrigin,
      databaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
      queueDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
      opaUrl: 'http://127.0.0.1:1',
      workerToken: 'synthetic-test-workload-token-only',
      projects: [
        {
          key: 'synthetic',
          organizationId: crypto.randomUUID(),
          projectId: crypto.randomUUID(),
          issuer,
          audience: 'agent18:support',
          jwks: { keys: [] },
        },
      ],
    });
    const { app } = await buildApp(config, { dispatch: false });
    try {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      const csp = response.headers['content-security-policy'] as string;
      expect(csp.includes('http://localhost:4319')).toBe(demo);
      expect(csp.includes('http://127.0.0.1:4319')).toBe(demo);
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });
});
