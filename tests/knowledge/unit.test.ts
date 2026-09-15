import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  scan,
  sourceSchema,
  containsSecret,
  chunkFiles,
  tokens,
  hash,
  CompatibleModel,
  modelFromEnvironment,
  answerQuestion,
} from '@agent18/knowledge';

describe('knowledge ingestion and model boundaries', () => {
  it('reads code and docs, skips credentials, symlinks, hidden paths and generated dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent18-scan-'));
    try {
      await writeFile(join(root, 'guide.md'), '# 使用说明\n创建发票需要验证权限。');
      await writeFile(join(root, 'key.ts'), 'const value="sk-' + 'a'.repeat(30) + '";');
      await mkdir(join(root, 'node_modules'));
      await writeFile(join(root, 'node_modules', 'large.ts'), 'dependency');
      await writeFile(join(root, '.env'), 'KEY=private');
      await symlink('/etc/passwd', join(root, 'outside.txt'));
      const result = await scan(
        sourceSchema.parse({ id: 'test-docs', name: 'Docs', kind: 'directory', location: root }),
        '.',
        root,
        AbortSignal.timeout(5000),
      );
      expect(result.files.map((f) => f.path)).toEqual(['guide.md']);
      expect(result.skipped.map((s) => s.reason)).toContain('secret-pattern');
      expect(result.skipped.map((s) => s.reason)).toContain('symlink');
      expect(result.revision).toHaveLength(64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('fails the complete snapshot when a file budget is exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent18-budget-'));
    try {
      await writeFile(join(root, 'a.md'), 'one');
      await writeFile(join(root, 'b.md'), 'two');
      await expect(
        scan(
          sourceSchema.parse({
            id: 'test-budget',
            name: 'Budget',
            kind: 'directory',
            location: root,
            maxFiles: 1,
          }),
          '.',
          root,
          AbortSignal.timeout(5000),
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_BUDGET_EXCEEDED' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('defaults to internal and rejects unsafe git transports and model URLs', async () => {
    const source = sourceSchema.parse({
      id: 'test-git',
      name: 'Git',
      kind: 'git',
      location: 'file:///tmp/repo',
    });
    expect(source.audience).toBe('internal');
    await expect(scan(source, '.', '/tmp', AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'GIT_URL_INVALID',
    });
    expect(() =>
      modelFromEnvironment({
        AGENT18_MODEL_BASE_URL: 'http://public.example/v1',
        AGENT18_MODEL_NAME: 'x',
        AGENT18_MODEL_API_KEY: 'key',
      }),
    ).toThrow('MODEL_URL_INVALID');
    expect(() => modelFromEnvironment({ AGENT18_MODEL_NAME: 'x' })).toThrow('MODEL_CONFIGURATION_INCOMPLETE');
  });
  it('retains headings and line references and tokenizes Chinese and code identifiers', () => {
    const content = '# Hello\nFirst line\n## 接口\n创建发票权限';
    const chunks = chunkFiles([{ path: 'api.md', content, sha: hash(content) }]);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({ startLine: 3, endLine: 4, category: 'api' });
    expect(tokens('创建发票 validateInvoice')).toEqual(
      expect.arrayContaining(['创建', '发票', 'validateinvoice']),
    );
    expect(containsSecret('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });
  it('calls the configured compatible API without tools and validates JSON and errors', async () => {
    let mode = 'ok',
      captured: any;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      captured = JSON.parse(Buffer.concat(chunks).toString());
      if (mode === 'auth') {
        res.writeHead(401);
        res.end('secret upstream error');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: mode === 'truncated' ? 'length' : 'stop',
              message: { content: '{"answer":"supported","references":["1"]}' },
            },
          ],
          usage: { total_tokens: 123 },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const model = new CompatibleModel(
        modelFromEnvironment({
          AGENT18_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          AGENT18_MODEL_NAME: 'contract-test',
          AGENT18_MODEL_API_KEY: 'local-test-key',
        })!,
      );
      const result = await model.complete('JSON only', { query: 'example' }, AbortSignal.timeout(1000));
      expect(result.tokens).toBe(123);
      expect(captured.tools).toBeUndefined();
      expect(captured.response_format).toEqual({ type: 'json_object' });
      mode = 'auth';
      await expect(model.complete('JSON', {}, AbortSignal.timeout(1000))).rejects.toMatchObject({
        code: 'MODEL_AUTH_FAILED',
      });
      mode = 'truncated';
      await expect(model.complete('JSON', {}, AbortSignal.timeout(1000))).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it('rejects invented answer references and has an honest model-free fallback', async () => {
    const retrieval = {
      mode: 'retrieval_only' as const,
      notice: 'test',
      citations: [
        {
          id: '1',
          title: 'Test',
          excerpt: 'facts',
          source: 'fixture://test',
          version: '1',
          observedAt: new Date().toISOString(),
        },
      ],
    };
    expect((await answerQuestion(undefined, 'facts', retrieval)).mode).toBe('retrieval_only');
    await expect(
      answerQuestion(
        {
          identity: 'fake',
          complete: async () => ({ value: { answer: 'Invented', references: ['unknown'] }, tokens: 1 }),
        },
        'facts',
        retrieval,
      ),
    ).rejects.toMatchObject({ code: 'MODEL_ANSWER_INVALID' });
  });
});

it('does not turn shell comments inside Markdown code fences into knowledge headings', () => {
  const content = '# Guide\n```sh\n# run migration\npnpm db:migrate\n```\n## Next\nContinue here';
  const chunks = chunkFiles([{ path: 'README.md', content, sha: hash(content) }]);
  expect(chunks.map((c) => c.title)).toEqual(['README.md · Guide', 'README.md · Next']);
  expect(chunks[0]!.endLine).toBe(5);
  expect(chunks[1]!.startLine).toBe(6);
});
