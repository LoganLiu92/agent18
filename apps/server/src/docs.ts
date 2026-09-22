import { openApi } from './openapi.js';
import { readFile } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { FastifyInstance } from 'fastify';
export const documents = [
  ['index', '开始使用', 'docs/README.md'],
  ['integration', '已有项目接入任务书', 'INTEGRATE.md'],
  ['reference/integration-acceptance', '目标系统验收报告', 'docs/reference/integration-acceptance.md'],
  [
    'overview/agent18-0.8-integration',
    '0.8 业务接口与语义上下文',
    'docs/overview/agent18-0.8-integration.md',
  ],
  ['guides/semantic-context', '宿主业务上下文与失败事件', 'docs/guides/semantic-context.md'],
  ['overview/agent18-0.7-operations', '0.7 全场景运行机制', 'docs/overview/agent18-0.7-operations.md'],
  ['guides/observability', '页面采集、自动排查与巡检', 'docs/guides/observability.md'],
  ['overview/agent18-0.6-core', '0.6 核心抽象与升级', 'docs/overview/agent18-0.6-core.md'],
  ['reference/providers', 'Provider 与 Tool 注册规范', 'docs/reference/providers.md'],
  ['guides/installation', '安装与公开部署', 'docs/guides/installation.md'],
  [
    'development/round18-integration-review',
    '新系统试接前复核',
    'docs/development/round18-integration-review.md',
  ],
  [
    'development/round17-product-workflows',
    '产品工作流与协议验收',
    'docs/development/round17-product-workflows.md',
  ],
  ['guides/advanced-workflows', '知识治理、分析与运行集成', 'docs/guides/advanced-workflows.md'],
  ['guides/support-workspace', '正式后台与完整接入', 'docs/guides/support-workspace.md'],
  [
    'development/round16-support-workspace',
    '持续支持与知识维护',
    'docs/development/round16-support-workspace.md',
  ],
  ['guides/operator-accounts', '独立后台账号与恢复', 'docs/guides/operator-accounts.md'],
  ['guides/integration', '网站与身份接入', 'docs/guides/integration.md'],
  ['guides/conversation', '对话式助手', 'docs/guides/conversation.md'],
  ['guides/knowledge', '知识构建与更新', 'docs/guides/knowledge.md'],
  ['guides/business-queries', '业务查询与 OpenAPI', 'docs/guides/business-queries.md'],
  ['guides/business-actions', '业务代操作协议', 'docs/guides/business-actions.md'],
  ['guides/operations', '诊断、备份与恢复', 'docs/guides/operations.md'],
  ['reference/api', 'API 与 SDK 参考', 'docs/reference/api.md'],
  ['reference/configuration', '配置参考', 'docs/reference/configuration.md'],
  ['reference/standards', '技术标准与边界', 'docs/reference/standards.md'],
  ['planning/mvp-roadmap', '能力现状与公开路线图', 'docs/planning/mvp-roadmap.md'],
  [
    'planning/product-development-plan-20260918',
    '产品分步开发计划',
    'docs/planning/product-development-plan-20260918.md',
  ],
  ['planning/m1-work-packages', 'M1 账号与知识中心开发包', 'docs/planning/m1-work-packages.md'],
  [
    'planning/knowledge-center-delivery-design',
    '知识中心页面与接口方案',
    'docs/planning/knowledge-center-delivery-design.md',
  ],
  [
    'planning/support-and-insights-work-packages',
    '工单与 Insights 开发包',
    'docs/planning/support-and-insights-work-packages.md',
  ],
  ['architecture/product-contracts', '产品领域合同', 'docs/architecture/product-contracts.md'],
  ['development/round9-foundation', '产品基础开发记录', 'docs/development/round9-foundation.md'],
  [
    'development/round10-operator-accounts',
    '账号运行闭环开发记录',
    'docs/development/round10-operator-accounts.md',
  ],
  ['development/round11-workspace', '正式工作空间与知识闭环', 'docs/development/round11-workspace.md'],
  [
    'development/round12-source-workflow',
    '来源扫描与修订审阅',
    'docs/development/round12-source-workflow.md',
  ],
  ['planning/review-and-priorities', '评审核验与研发优先级', 'docs/planning/review-and-priorities.md'],
  [
    'development/round14-source-evidence',
    '固定来源快照与主题证据关系',
    'docs/development/round14-source-evidence.md',
  ],
  [
    'development/round13-knowledge-map',
    '客户引用隔离与业务主题地图',
    'docs/development/round13-knowledge-map.md',
  ],
  [
    'development/round15-layered-generation',
    '分层生成与独立客户知识',
    'docs/development/round15-layered-generation.md',
  ],
  ['overview', '0.5 历史运行综述', 'docs/overview/agent18-0.5-overview.md'],
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
