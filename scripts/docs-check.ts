import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import MarkdownIt from 'markdown-it';
import { z } from 'zod';
import { documents } from '../apps/server/src/docs.js';
import { openApi } from '../apps/server/src/openapi.js';

const root = resolve('.');
const manifest = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    overview: z.string(),
    capabilities: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.enum(['implemented', 'partial', 'planned']),
            zh: z.tuple([z.string(), z.string(), z.string()]),
            en: z.tuple([z.string(), z.string(), z.string()]),
            evidence: z.array(z.string()),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .parse(JSON.parse(await readFile('docs/release.json', 'utf8')));
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const errors: string[] = [];
const write = process.argv.includes('--write');
if (manifest.version !== version || openApi.info.version !== version)
  errors.push('Version mismatch: package.json, docs/release.json and OpenAPI must agree.');
const changelog = await readFile('CHANGELOG.md', 'utf8');
if (!new RegExp(`^## ${version.replaceAll('.', '\\.')}[ \\n]`, 'm').test(changelog))
  errors.push(`CHANGELOG.md: missing current ${version} release.`);
if (new Set(manifest.capabilities.map((c) => c.id)).size !== manifest.capabilities.length)
  errors.push('docs/release.json: duplicate capability id.');

async function fileExists(file: string, from: string) {
  const target = resolve(file);
  if (!target.startsWith(root + sep) || !(await stat(target).catch(() => undefined))?.isFile())
    errors.push(`${from}: missing repository file ${file}`);
}
await fileExists(manifest.overview, 'docs/release.json');
for (const capability of manifest.capabilities) {
  if (capability.status !== 'planned' && !capability.evidence.length)
    errors.push(`docs/release.json: ${capability.id} needs implementation/validation references.`);
  for (const path of capability.evidence) await fileExists(path, capability.id);
}
function release(file: string, language: 'zh' | 'en') {
  const link = relative(dirname(file), manifest.overview).split(sep).join('/');
  return language === 'zh'
    ? `当前版本：**${version} 集成预览**。实现范围见[运行机制综述](${link})；源码自托管，单机部署。`
    : `Current version: **${version} integration preview**. See the [runtime overview](${link}); source-based, single-host deployment.`;
}
function matrix(language: 'zh' | 'en') {
  const status =
    language === 'zh'
      ? { implemented: '已实现', partial: '部分实现', planned: '规划' }
      : { implemented: 'Implemented', partial: 'Partial', planned: 'Planned' };
  const header =
    language === 'zh'
      ? '| 能力 | 状态 | 可用内容 | 接入要求与边界 |'
      : '| Capability | Status | Available | Requirements and limits |';
  const rows = manifest.capabilities.map((capability) => {
    const [title, behavior, limits] = capability[language];
    return `| ${title} | ${status[capability.status]} | ${behavior} | ${limits} |`;
  });
  return [header, '| --- | --- | --- | --- |', ...rows].join('\n');
}
const generated = [
  ['README.md', 'zh', true],
  ['README.en.md', 'en', true],
  ['INTEGRATE.md', 'zh', false],
  ['CONTRIBUTING.md', 'zh', false],
  ['docs/README.md', 'zh', false],
  ['docs/planning/mvp-roadmap.md', 'zh', true],
] as const;
for (const [file, language, hasMatrix] of generated) {
  let source = await readFile(file, 'utf8');
  for (const kind of hasMatrix ? ['release', 'capabilities'] : ['release']) {
    // Reference comments stay invisible in both GitHub and the HTML-disabled handbook renderer.
    const begin = `[//]: # (agent18:${kind}:start)`;
    const end = `[//]: # (agent18:${kind}:end)`;
    const startIndex = source.indexOf(begin),
      endIndex = source.indexOf(end);
    if (
      startIndex < 0 ||
      endIndex < startIndex ||
      source.indexOf(begin, startIndex + 1) >= 0 ||
      source.indexOf(end, endIndex + 1) >= 0
    ) {
      errors.push(`${file}: missing or duplicate ${kind} generation markers.`);
      continue;
    }
    const block = `${begin}\n\n${kind === 'release' ? release(file, language) : matrix(language)}\n\n${end}`;
    const current = source.slice(startIndex, endIndex + end.length);
    if (current !== block) {
      if (write) source = source.slice(0, startIndex) + block + source.slice(endIndex + end.length);
      else errors.push(`${file}: stale ${kind}; review docs/release.json then run pnpm docs:sync.`);
    }
  }
  if (write) await writeFile(file, source);
}

const markdown = new MarkdownIt();
const maintained = new Set<string>([
  ...documents.map(([, , path]) => path),
  ...generated.map(([file]) => file),
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/planning/review-and-priorities.md',
]);
let links = 0;
for (const file of maintained) {
  const source = await readFile(file, 'utf8');
  for (const token of markdown.parse(source, {})) {
    for (const child of [token, ...(token.children ?? [])]) {
      const href =
        child.type === 'link_open'
          ? child.attrGet('href')
          : child.type === 'image'
            ? child.attrGet('src')
            : null;
      if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) continue;
      const path = decodeURIComponent(href.split('#')[0]!.split('?')[0]!);
      if (!path) continue;
      links++;
      await fileExists(resolve(dirname(file), path), file);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Docs verified: ${version}, ${manifest.capabilities.length} capabilities, ${maintained.size} documents, ${links} local links. Status claims still require scenario validation.`,
  );
