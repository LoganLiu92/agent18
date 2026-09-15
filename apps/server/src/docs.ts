import { openApi } from './openapi.js';
import { readFile } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { FastifyInstance } from 'fastify';
export const documents = [
  ['index', '开始使用', 'docs/README.md'],
  ['integration', '已有项目接入任务书', 'INTEGRATE.md'],
  ['reference/integration-acceptance', '目标系统验收报告', 'docs/reference/integration-acceptance.md'],
  ['overview/agent18-0.7-operations', '0.7 全场景运行机制', 'docs/overview/agent18-0.7-operations.md'],
  ['guides/observability', '页面采集、自动排查与巡检', 'docs/guides/observability.md'],
  ['overview/agent18-0.6-core', '0.6 核心抽象与升级', 'docs/overview/agent18-0.6-core.md'],
  ['reference/providers', 'Provider 与 Tool 注册规范', 'docs/reference/providers.md'],
  ['guides/installation', '安装与公开部署', 'docs/guides/installation.md'],
  ['guides/integration', '网站与身份接入', 'docs/guides/integration.md'],
  ['guides/conversation', '对话式助手', 'docs/guides/conversation.md'],
  ['guides/knowledge', '知识构建与更新', 'docs/guides/knowledge.md'],
  ['guides/business-queries', '业务查询与 OpenAPI', 'docs/guides/business-queries.md'],
  ['guides/business-actions', '业务代操作协议', 'docs/guides/business-actions.md'],
  ['guides/operations', '诊断、备份与恢复', 'docs/guides/operations.md'],
  ['reference/api', 'API 与 SDK 参考', 'docs/reference/api.md'],
  ['reference/configuration', '配置参考', 'docs/reference/configuration.md'],
  ['reference/standards', '技术标准与边界', 'docs/reference/standards.md'],
  ['overview', '整体运行机制与实现', 'docs/overview/agent18-0.5-overview.md'],
  ['contributing', '参与贡献', 'CONTRIBUTING.md'],
] as const;
export function documentationHtml(id: string, source: string) {
  const current = documents.find((d) => d[0] === id)!;
  const markdown = new MarkdownIt({ html: false, linkify: false });
  const defaultLink =
    markdown.renderer.rules.link_open ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index]!,
      href = token.attrGet('href') ?? '';
    if (/^(https?:)?\/\//.test(href)) token.attrSet('rel', 'noreferrer noopener');
    else if (!href.startsWith('/') && !href.startsWith('#')) {
      const [file, fragment] = href.split('#'),
        path = posix.normalize(posix.join(posix.dirname(current[2]), file!));
      const target = documents.find((d) => d[2] === path);
      if (target) token.attrSet('href', '/docs/' + target[0] + (fragment ? '#' + fragment : ''));
      else
        token.attrSet(
          'href',
          'https://github.com/LoganLiu92/agent18/blob/main/' + path + (fragment ? '#' + fragment : ''),
        );
    }
    return defaultLink(tokens, index, options, env, self);
  };
  markdown.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
    const title = tokens[index + 1]?.content ?? '';
    tokens[index]!.attrSet(
      'id',
      title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s/g, '-'),
    );
    return self.renderToken(tokens, index, options);
  };
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    current[1] +
    ' · agent18 文档</title><link rel="stylesheet" href="/docs.css"></head><body><header><a class="brand" href="/">a<span>18</span> agent18</a><span>开发者文档 · ' +
    openApi.info.version +
    '</span><a href="/openapi.json">OpenAPI JSON ↗</a></header><div class="layout"><aside><b>从接入到运行</b><nav>' +
    documents
      .map(
        (d) => '<a class="' + (d[0] === id ? 'active' : '') + '" href="/docs/' + d[0] + '">' + d[1] + '</a>',
      )
      .join('') +
    '</nav><a href="https://github.com/LoganLiu92/agent18">GitHub ↗</a></aside><main><article>' +
    markdown.render(source) +
    '</article><footer>agent18 · Apache-2.0 Core / MIT SDK · 文档随代码版本维护</footer></main></div></body></html>'
  );
}
export function registerDocs(app: FastifyInstance) {
  app.get('/docs', async (_request, reply) => reply.redirect('/docs/index'));
  app.get('/docs/*', async (request, reply) => {
    const id = (request.params as { '*': string })['*'],
      doc = documents.find((d) => d[0] === id);
    if (!doc) return reply.code(404).send({ error: { code: 'DOCUMENT_NOT_FOUND' } });
    return reply
      .type('text/html; charset=utf-8')
      .send(documentationHtml(doc[0], await readFile(resolve(doc[2]), 'utf8')));
  });
  app.get('/docs.css', async (_request, reply) =>
    reply.type('text/css').send(await readFile('apps/server/src/docs.css', 'utf8')),
  );
}
