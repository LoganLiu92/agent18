import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { sourceSchema, scan } from '@agent18/knowledge';
const exec = promisify(execFile);
it('clones and rescans an authenticated HTTPS Git repository without writing credentials to disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent18-private-git-')),
    work = join(root, 'work'),
    repos = join(root, 'repos'),
    token = 'synthetic-only-private-repo-token',
    encoded = Buffer.from('oauth2:' + token).toString('base64');
  const saved = Object.fromEntries(
    ['AGENT18_GIT_INTEGRATION', 'AGENT18_GIT_CREDENTIAL_BINDINGS', 'GIT_SSL_CAINFO'].map((k) => [
      k,
      process.env[k],
    ]),
  );
  let calls = 0;
  const server = createServer();
  try {
    await mkdir(work);
    await mkdir(repos);
    await exec('git', ['init', work]);
    await writeFile(join(work, 'guide.md'), '# Private Product\nApproved private repository documentation.');
    await exec('git', ['-C', work, 'add', 'guide.md']);
    await exec('git', [
      '-C',
      work,
      '-c',
      'user.name=Isolated Test',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    ]);
    await exec('git', ['clone', '--bare', work, join(repos, 'repo.git')]);
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);
    server.setSecureContext({
      key: await readFile(join(root, 'key.pem')),
      cert: await readFile(join(root, 'cert.pem')),
    });
    server.on('request', (req, res) => {
      calls++;
      if (req.headers.authorization !== 'Basic ' + encoded) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }).end();
        return;
      }
      const url = new URL(req.url!, 'https://localhost'),
        child = spawn('git', ['http-backend'], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: repos,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method!,
            CONTENT_TYPE: req.headers['content-type'] ?? '',
            REMOTE_USER: 'oauth2',
          },
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c) => chunks.push(c));
      req.pipe(child.stdin);
      child.on('close', () => {
        const raw = Buffer.concat(chunks),
          at = raw.indexOf('\r\n\r\n');
        if (at < 0) {
          res.writeHead(500).end();
          return;
        }
        for (const line of raw.subarray(0, at).toString().split('\r\n')) {
          const pos = line.indexOf(':');
          if (pos > 0) {
            const k = line.slice(0, pos),
              v = line.slice(pos + 1).trim();
            if (k.toLowerCase() === 'status') res.statusCode = parseInt(v);
            else res.setHeader(k, v);
          }
        }
        res.end(raw.subarray(at + 4));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const location = 'https://127.0.0.1:' + (server.address() as { port: number }).port + '/repo.git';
    process.env.AGENT18_GIT_INTEGRATION = encoded;
    process.env.AGENT18_GIT_CREDENTIAL_BINDINGS = JSON.stringify({ AGENT18_GIT_INTEGRATION: location });
    process.env.GIT_SSL_CAINFO = join(root, 'cert.pem');
    const source = sourceSchema.parse({
        id: 'private-repo',
        name: 'Private reference',
        kind: 'git',
        location,
        credentialEnv: 'AGENT18_GIT_INTEGRATION',
      }),
      cache = join(root, 'cache'),
      snapshot = await scan(source, root, cache, AbortSignal.timeout(15000));
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]!.content).toContain('Approved private');
    expect(snapshot.revision).toMatch(/^[a-f0-9]{40}$/);
    const second = await scan(source, root, cache, AbortSignal.timeout(15000));
    expect(second.fingerprint).toBe(snapshot.fingerprint);
    expect(calls).toBeGreaterThan(1);
    const { createHash } = await import('node:crypto'),
      config = await readFile(
        join(cache, createHash('sha256').update(location).digest('hex'), 'config'),
        'utf8',
      );
    expect(config).not.toContain(token);
    expect(config).not.toContain(encoded);
    expect(config).not.toContain('extraHeader');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
