import { it, expect } from 'vitest';
import { importOpenApi, queriesSchema } from '@agent18/actions';
import { demoOpenApi } from '../../examples/identity-bridge/queries.js';
import { documentationHtml } from '../../apps/server/src/docs.js';
import { demoPostQuery } from '../../examples/identity-bridge/queries.js';
it('requires explicit POST review, permits bounded body fields and keeps automatic import GET-only', () => {
  const parse = (q: unknown) => queriesSchema.safeParse({ baseUrl: 'https://saas.example', operations: [q] });
  expect(parse(demoPostQuery).success).toBe(true);
  for (const overrides of [
    { readOnly: false },
    { readOnly: undefined },
    { method: 'DELETE' },
    { method: 'GET' },
  ])
    expect(parse({ ...demoPostQuery, ...overrides }).success).toBe(false);
  for (const name of ['constructor', 'prototype', '__proto__'])
    expect(parse({ ...demoPostQuery, fields: [{ ...demoPostQuery.fields[0], name }] }).success).toBe(false);
  const imported = importOpenApi({
    ...demoOpenApi,
    paths: { ...demoOpenApi.paths, '/api/orders/search': { post: { operationId: 'orders.search' } } },
  });
  expect(imported.operations.some((q) => q.id === 'orders.search')).toBe(false);
  expect(imported.skipped).toHaveLength(1);
});
it('imports local schema references as disabled GET candidates and excludes write-only fields', () => {
  const result = importOpenApi(demoOpenApi);
  expect(result.skipped).toEqual([]);
  expect(result.operations).toHaveLength(3);
  expect(result.operations.every((q) => !q.enabled)).toBe(true);
  expect(result.operations[0]!.columns.map((c) => c.path)).toEqual(['id', 'customer', 'amount', 'status']);
  expect(result.operations[1]!.fields[0]).toMatchObject({ name: 'orderId', in: 'path', required: true });
});
it('never fetches remote references and reports unsupported definitions', () => {
  const doc = structuredClone(demoOpenApi) as any;
  doc.paths['/write'] = { post: { operationId: 'write' } };
  doc.paths['/remote'] = { $ref: 'http://127.0.0.1/private.json' };
  doc.paths['/circular'] = { $ref: '#/components/schemas/Circle' };
  doc.components.schemas.Circle = { $ref: '#/components/schemas/Circle' };
  doc.paths['/api/orders'].get.servers = [{ url: 'https://evil.example' }];
  const result = importOpenApi(doc);
  expect(result.operations.map((q) => q.id)).toEqual(['orders.get', 'preferences.get']);
  expect(result.skipped).toHaveLength(4);
});
it('rejects wildcard targets, redirects encoded as paths and mismatched path parameters', () => {
  const q = importOpenApi(demoOpenApi).operations[1]!;
  for (const path of ['//evil.example', '/../../credentials', '/a?url=x', '/a/{missing}', '/a/%2f'])
    expect(
      queriesSchema.safeParse({ baseUrl: 'https://saas.example', operations: [{ ...q, path }] }).success,
    ).toBe(false);
  for (const baseUrl of [
    'http://untrusted.example',
    'https://user:password@example.com',
    'https://example.com?key=secret',
  ])
    expect(queriesSchema.safeParse({ baseUrl, operations: [q] }).success).toBe(false);
  expect(
    queriesSchema.safeParse({
      baseUrl: 'https://example.com',
      operations: [{ ...q, columns: [{ path: '__proto__.key', label: 'unsafe' }] }],
    }).success,
  ).toBe(false);
});
it('renders documentation without active HTML and maps local documentation links', () => {
  const rendered = documentationHtml(
    'index',
    '<script>alert(1)</script>\n\n[Integration](guides/integration.md)\n\n[bad](javascript:alert(1))',
  );
  expect(rendered).not.toContain('<script>');
  expect(rendered).not.toContain('href="javascript:');
  expect(rendered).toContain('href="/docs/guides/integration"');
});

it('respects writeOnly on referenced response schemas and does not select private response arrays', () => {
  const doc = structuredClone(demoOpenApi) as any;
  doc.paths['/api/orders/{orderId}'].get.responses['200'].content['application/json'].schema.writeOnly = true;
  const result = importOpenApi(doc);
  expect(result.operations.some((q) => q.id === 'orders.get')).toBe(false);
  expect(result.skipped.some((s) => s.path === '/api/orders/{orderId}')).toBe(true);
});

it('binds analytics definitions to reviewed fields, dimensions and date parameters', () => {
  const q = {
    ...importOpenApi(demoOpenApi).operations[0]!,
    fields: [
      { name: 'start', label: 'Start date', in: 'query', type: 'string', required: true },
      { name: 'end', label: 'End date', in: 'query', type: 'string', required: true },
    ],
    metric: {
      id: 'sales.revenue',
      version: '1',
      definition: 'Settled revenue net of refunds, grouped by customer.',
      timezone: 'UTC',
      values: [{ column: 'amount', unit: 'currency', currency: 'USD' }],
      dimensions: ['customer'],
      period: { startField: 'start', endField: 'end' },
      maxDays: 90,
    },
  };
  const parse = (value: unknown) =>
    queriesSchema.safeParse({ baseUrl: 'https://saas.example', operations: [value] });
  expect(parse(q).success).toBe(true);
  for (const metric of [
    { ...q.metric, dimensions: ['privateField'] },
    { ...q.metric, timezone: 'invented-zone' },
    { ...q.metric, period: { startField: 'missing', endField: 'end' } },
    { ...q.metric, values: [{ column: 'amount', unit: 'currency', currency: 'mixed' }] },
  ])
    expect(parse({ ...q, metric }).success).toBe(false);
});
