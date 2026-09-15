import type { Citation } from '@agent18/contracts';
import type { KnowledgeProvider, ProviderContext } from '@agent18/provider-contracts';

// Explicit synthetic fixtures. Production indexing, synchronization and source ACL revocation belong to M1.
const documents = [
  {
    id: 'invoice-submit',
    title: '发票提交失败：先收集哪些信息',
    keywords: ['发票', '提交', '失败', 'invoice', 'submit', 'failed'],
    excerpt:
      '请记录业务单号、操作时间和页面提供的请求编号，再检查必填信息。连续失败时提交问题报告，由支持团队结合服务日志排查。不要在问题描述中粘贴密钥、完整支付卡号或身份凭证。',
  },
  {
    id: 'invoice-create',
    title: '如何创建第一张发票',
    keywords: ['创建', '发票', '开票', 'create', 'invoice'],
    excerpt:
      '进入发票列表，选择“新建发票”，填写客户、明细与金额，保存草稿并核对后提交。本文为合成 SaaS 的演示流程，不包含真实国家的税务规则。',
  },
  {
    id: 'case-progress',
    title: '提交问题后如何跟进',
    keywords: ['问题', '进度', '支持', 'case', 'support'],
    excerpt:
      '在“我的问题”中打开报告，查看处理状态和引用资料。当前阶段只完成资料检索，后续处理需要支持人员介入；检索命中不代表故障已经定位或解决。',
  },
];
export class FixtureKnowledgeProvider implements KnowledgeProvider {
  readonly manifest = {
    id: 'knowledge-fixture',
    version: '1.0.0',
    capabilities: ['knowledge.search'],
    mode: 'fixture' as const,
  };
  async search(input: { query: string; limit: number }, context: ProviderContext): Promise<Citation[]> {
    context.signal.throwIfAborted();
    const query = input.query.toLocaleLowerCase();
    const { organizationId, projectId, tenantId } = context.scope;
    return documents
      .map((doc) => ({ doc, score: doc.keywords.filter((word) => query.includes(word)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(input.limit, 5))
      .map(({ doc }) => ({
        id: doc.id,
        title: doc.title,
        excerpt: doc.excerpt,
        source: `fixture://invoice-saas/${doc.id}`,
        version: this.manifest.version,
        observedAt: new Date().toISOString(),
        visibility: 'PUBLIC',
        scope: { organizationId, projectId, tenantId },
      }));
  }
}
