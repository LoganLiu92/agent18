import { gitCredentialEnvironment } from './git-credentials.js';
import { readdir, realpath, lstat, open, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, sep, extname, matchesGlob } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KnowledgeError, type SourceConfig, type categories } from './config.js';
const exec = promisify(execFile);
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const extensions = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
  '.py',
  '.go',
  '.rs',
  '.cs',
  '.sql',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.xml',
  '.vue',
  '.svelte',
  '.html',
  '.css',
  '.proto',
  '.sh',
  '.properties',
  '.rb',
  '.php',
  '.kt',
  '.kts',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
]);
const blockedParts = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  'venv',
]);
export function permittedPath(path: string, source: SourceConfig): boolean {
  const parts = path.split('/');
  if (
    parts.some((p) => !p || p.startsWith('.') || blockedParts.has(p)) ||
    /(?:^|[./_-])(secrets?|credentials?|id_rsa|id_ed25519|pnpm-lock|package-lock|yarn\.lock)(?:[./_-]|$)/i.test(
      path,
    )
  )
    return false;
  if (!extensions.has(extname(path).toLowerCase()) && !['Dockerfile', 'Makefile'].includes(parts.at(-1)!))
    return false;
  return (
    source.include.some((pattern) => matchesGlob(path, pattern)) &&
    !source.exclude.some((pattern) => matchesGlob(path, pattern))
  );
}
export function containsSecret(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*["'](?!\$\{|<|YOUR_|your_|example|test|fixture|demo)[A-Za-z0-9_+\/-]{20,}["']/i.test(
    text,
  );
}
export type SourceFile = { path: string; content: string; sha: string };
export type Snapshot = {
  revision: string;
  fingerprint: string;
  files: SourceFile[];
  skipped: { path: string; reason: string }[];
  bytes: number;
};
async function git(args: string[], cwd?: string, credentials: NodeJS.ProcessEnv = {}): Promise<Buffer> {
  try {
    const r = await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        'protocol.file.allow=never',
        '-c',
        'credential.helper=',
        '-c',
        'http.followRedirects=false',
        ...args,
      ],
      {
        cwd,
        encoding: 'buffer',
        timeout: 60000,
        maxBuffer: 25_000_000,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))),
          GIT_CONFIG_COUNT: '0',
          ...credentials,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes',
        },
      },
    );
    return r.stdout;
  } catch {
    throw new KnowledgeError('GIT_READ_FAILED');
  }
}
export async function scan(
  source: SourceConfig,
  base: string,
  cache: string,
  signal: AbortSignal,
): Promise<Snapshot> {
  const files: SourceFile[] = [],
    skipped: Snapshot['skipped'] = [];
  let bytes = 0,
    visited = 0,
    revision = '';
  function check() {
    signal.throwIfAborted();
    if (++visited > 100000) throw new KnowledgeError('SCAN_ENTRY_LIMIT');
  }
  function accept(path: string, data: Buffer) {
    if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) {
      skipped.push({ path, reason: 'binary' });
      return;
    }
    const content = data.toString('utf8').replace(/\r\n/g, '\n');
    if (containsSecret(content)) {
      skipped.push({ path, reason: 'secret-pattern' });
      return;
    }
    bytes += data.length;
    if (bytes > source.maxTotalBytes || files.length >= source.maxFiles)
      throw new KnowledgeError('SOURCE_BUDGET_EXCEEDED');
    files.push({ path, content, sha: hash(content) });
  }
  if (source.kind === 'directory') {
    const root = await realpath(resolve(base, source.location));
    async function walk(dir: string) {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        check();
        const full = resolve(dir, entry.name),
          path = relative(root, full).split(sep).join('/');
        if (entry.isSymbolicLink()) {
          skipped.push({ path, reason: 'symlink' });
          continue;
        }
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !blockedParts.has(entry.name)) {
            const actual = await realpath(full);
            if (actual !== full || !actual.startsWith(root + sep))
              throw new KnowledgeError('SOURCE_PATH_CHANGED');
            await walk(full);
          }
        } else if (entry.isFile() && permittedPath(path, source)) {
          const info = await lstat(full);
          if (info.size > source.maxFileBytes || info.nlink > 1) {
            skipped.push({ path, reason: info.nlink > 1 ? 'hardlink' : 'file-too-large' });
            continue;
          }
          const fd = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const before = await fd.stat();
            if (before.ino !== info.ino || before.size > source.maxFileBytes)
              throw new KnowledgeError('SOURCE_PATH_CHANGED');
            const data = Buffer.alloc(source.maxFileBytes + 1);
            const { bytesRead } = await fd.read(data, 0, data.length, 0);
            const after = await fd.stat();
            if (
              bytesRead > source.maxFileBytes ||
              before.mtimeMs !== after.mtimeMs ||
              before.size !== bytesRead
            )
              throw new KnowledgeError('SOURCE_CHANGED_DURING_SCAN');
            accept(path, data.subarray(0, bytesRead));
          } finally {
            await fd.close();
          }
        }
      }
    }
    await walk(root);
  } else {
    if (
      !/^https:\/\/[^\s/@]+\/[^\s?#]+\.git$/.test(source.location) &&
      !/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+\.git$/.test(source.location)
    )
      throw new KnowledgeError('GIT_URL_INVALID');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const repo = resolve(cache, hash(source.location));
    const stat = await lstat(repo).catch(() => null);
    const credentials = gitCredentialEnvironment(source);
    if (!stat)
      await git(['clone', '--bare', '--no-hardlinks', '--', source.location, repo], undefined, credentials);
    else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new KnowledgeError('GIT_CACHE_INVALID');
    await git(['--git-dir', repo, 'fetch', '--no-tags', 'origin', source.ref], undefined, credentials);
    revision = (await git(['--git-dir', repo, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']))
      .toString()
      .trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new KnowledgeError('GIT_REVISION_INVALID');
    const entries = (await git(['--git-dir', repo, 'ls-tree', '-r', '-l', '-z', revision]))
      .toString()
      .split('\0');
    for (const entry of entries) {
      if (!entry) continue;
      check();
      const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry);
      if (!match) continue;
      const [, mode, oid, size, path] = match;
      if (!['100644', '100755'].includes(mode!) || !permittedPath(path!, source)) continue;
      if (Number(size) > source.maxFileBytes) {
        skipped.push({ path: path!, reason: 'file-too-large' });
        continue;
      }
      accept(path!, await git(['--git-dir', repo, 'cat-file', 'blob', oid!]));
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) throw new KnowledgeError('NO_INDEXABLE_FILES');
  const fingerprint = hash(JSON.stringify(files.map((f) => [f.path, f.sha])));
  return { files, skipped, bytes, revision: revision || fingerprint, fingerprint };
}
export type Chunk = {
  key: string;
  path: string;
  title: string;
  text: string;
  startLine: number;
  endLine: number;
  category: (typeof categories)[number];
};
export function chunkFiles(files: SourceFile[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const file of files) {
    const category: Chunk['category'] = /(?:troubleshoot|error|faq|故障)/i.test(file.path)
      ? 'troubleshooting'
      : /(?:config|deploy|setup|install|配置)/i.test(file.path)
        ? 'configuration'
        : /(?:route|controller|api|schema|contract)/i.test(file.path)
          ? 'api'
          : /(?:architecture|架构)/i.test(file.path)
            ? 'architecture'
            : /(?:guide|workflow|教程|手册)/i.test(file.path)
              ? 'workflows'
              : /readme/i.test(file.path)
                ? 'overview'
                : 'architecture';
    const lines = file.content.split('\n');
    let start = 1,
      text = '',
      heading = file.path;
    let fence = '';
    const markdown = /\.(md|mdx|rst|txt)$/i.test(file.path);
    const push = (end: number) => {
      if (text.trim())
        chunks.push({
          key: hash(`${file.path}:${start}:${text}`),
          path: file.path,
          title: heading.slice(0, 180),
          text: text.trim(),
          startLine: start,
          endLine: end,
          category,
        });
      text = '';
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const marker = markdown ? /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] : undefined;
      const isHeading = markdown && !fence && /^#{1,3}\s/.test(line);
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      }
      if ((text.length + line.length > 1500 || isHeading) && text.trim()) {
        push(i);
        start = i + 1;
      }
      if (isHeading) heading = `${file.path} · ${line.replace(/^#+\s*/, '')}`;
      if (line.length > 1500) {
        for (let offset = 0; offset < line.length; offset += 1500) {
          text = line.slice(offset, offset + 1500);
          start = i + 1;
          push(i + 1);
        }
        start = i + 2;
      } else {
        text += line + '\n';
      }
    }
    push(lines.length);
  }
  if (chunks.length > 20000) throw new KnowledgeError('CHUNK_BUDGET_EXCEEDED');
  return chunks;
}
export function tokens(text: string): string[] {
  const clean = text.toLowerCase();
  const out: string[] = clean.match(/[a-z0-9_]{2,60}/g) ?? [];
  for (const sequence of clean.match(/[\p{Script=Han}]+/gu) ?? [])
    for (let i = 0; i < sequence.length - 1; i++) out.push(sequence.slice(i, i + 2));
  return [...new Set(out)].slice(0, 1200);
}
