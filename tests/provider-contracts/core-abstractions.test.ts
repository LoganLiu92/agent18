import { expect, it } from 'vitest';
import { z } from 'zod';
import { contextSchema, type Evidence } from '@agent18/contracts';
import {
  ProviderRegistry,
  builtInTool,
  evidenceBatchSchema,
  validateEvidence,
} from '@agent18/provider-contracts';
import { Agent18 } from '@agent18/web-sdk';
const scope = {
  organizationId: '00000000-0000-4000-8000-000000000018',
  projectId: '10000000-0000-4000-8000-000000000018',
  tenantId: 'tenant-a',
  subject: 'alice',
};
const tool = builtInTool('test.logs', 'redacted-log', 'logs.search', 'READ', 'log');
const evidence = (): Evidence => ({
  id: crypto.randomUUID(),
  kind: 'log',
  source: 'log://storefront',
  observedAt: new Date().toISOString(),
  resource: { type: 'log', id: 'request-18' },
  summary: 'Synthetic downstream timeout',
  artifactRef: null,
  visibility: 'TENANT',
  sensitivity: 'CONFIDENTIAL',
  scope: { ...scope },
  provenance: {
    providerId: tool.provider,
    toolId: tool.id,
    toolVersion: 1,
    sourceVersion: 'deploy-18',
    requestId: 'request-18',
  },
});
it('accepts explicit domain-neutral context while rejecting unbounded data and implicit secrets', () => {
  expect(
    contextSchema.parse({
      entity: { namespace: 'crm', type: 'opportunity', id: 'opp-1' },
      traceId: 'a'.repeat(32),
      correlationIds: { request: 'req-1' },
    }).entity?.type,
  ).toBe('opportunity');
  for (const value of [
    { cookies: 'secret' },
    { traceId: 'invalid' },
    { correlationIds: Object.fromEntries(Array.from({ length: 11 }, (_, i) => ['key' + i, 'value'])) },
    { entity: { type: 'lead', id: 'x', credentials: 'secret' } },
  ])
    expect(contextSchema.safeParse(value).success).toBe(false);
});
it('SDK copies only explicit bounded context without importing host fields', async () => {
  let body = '';
  const sdk = new Agent18({
    baseUrl: 'http://test',
    projectKey: 'test',
    getToken: async () => 'test',
    fetch: async (_url, init) => {
      body = String(init?.body);
      return Response.json({});
    },
  });
  const entity = { namespace: 'crm', type: 'lead', id: 'lead-1', token: 'must-not-send' };
  sdk.setContext({
    pageUrl: '/crm?token=must-not-send',
    entity,
    sessionId: 'session-1',
    environment: 'staging',
  });
  entity.id = 'mutated';
  await sdk.reportCase({ title: 'Example issue', description: 'Details' }, crypto.randomUUID());
  expect(body).toContain('lead-1');
  expect(body).not.toContain('mutated');
  expect(body).not.toContain('must-not-send');
  expect(() => sdk.setContext({ correlationIds: { key: 'x'.repeat(129) } })).toThrow('CONTEXT_INVALID');
});
it('validates every evidence scope, provenance, resource and sensitivity before releasing a batch', () => {
  expect(validateEvidence([evidence()], scope, tool)[0]?.kind).toBe('log');
  for (const field of ['organizationId', 'projectId', 'tenantId', 'subject'] as const) {
    const e = evidence();
    e.scope[field] = field.endsWith('Id') && field !== 'tenantId' ? crypto.randomUUID() : 'other';
    expect(() => validateEvidence([evidence(), e], scope, tool)).toThrow('INVALID_SCOPE');
  }
  const changes = [
    { visibility: 'ENGINEERING' },
    { sensitivity: 'RESTRICTED' },
    { resource: { type: 'source', id: 'x' } },
    { provenance: { ...evidence().provenance, providerId: 'forged' } },
    { artifactRef: 'https://private.example/key' },
  ];
  for (const change of changes)
    expect(() => validateEvidence([{ ...evidence(), ...change }], scope, tool)).toThrow('INVALID_SCOPE');
});
it('rejects unknown evidence shape and knowledge without a citation', () => {
  expect(() =>
    validateEvidence(
      [{ ...evidence(), kind: 'knowledge', resource: { type: 'knowledge', id: 'x' } }],
      scope,
      { ...tool, resourceTypes: ['knowledge'] },
    ),
  ).toThrow('INVALID_SCOPE');
  expect(() => validateEvidence([{ ...evidence(), rawPayload: 'must-not-send' }], scope, tool)).toThrow(
    'INVALID_SCOPE',
  );
});
it('keeps provider domains independent from transport and rejects conflicting registrations', () => {
  const registry = new ProviderRegistry();
  const provider = {
    manifest: {
      id: tool.provider,
      version: '1.0.0',
      capabilities: ['logs.search'],
      mode: 'fixture' as const,
    },
    transport: 'mcp' as const,
    tools: [
      {
        descriptor: tool,
        inputSchema: z.object({}).strict(),
        outputSchema: evidenceBatchSchema,
        invoke: async () => [evidence()],
      },
    ],
  };
  registry.register(provider);
  expect(registry.list()[0]?.transport).toBe('mcp');
  expect(() => registry.register(provider)).toThrow('DUPLICATE_REGISTRATION');
  expect(() =>
    new ProviderRegistry().register({
      ...provider,
      manifest: { ...provider.manifest, capabilities: ['source.read'] },
    }),
  ).toThrow('INVALID_REGISTRATION');
});
