import { scoped, type Database } from '@agent18/persistence';
import type { Citation, SafeCitation, Scope, KnowledgeArticle } from '@agent18/contracts';
import type { KnowledgeProvider, ProviderContext } from '@agent18/provider-contracts';
import { tokens } from './scan.js';
import type { QueryResultRow } from 'pg';
const articleView = (r: QueryResultRow): KnowledgeArticle => ({
  id: r.id,
  title: r.title,
  body: r.body,
  category: r.category,
  source: `knowledge://${r.source_id}/${r.id}`,
  version: r.revision,
  observedAt: r.created_at.toISOString(),
  references: r.refs,
});
export class IndexedKnowledgeProvider implements KnowledgeProvider {
  manifest = {
    id: 'knowledge-indexed',
    version: '0.3.0',
    capabilities: ['knowledge.search'],
    mode: 'live' as const,
  };
  constructor(private readonly db: Database) {}
  async search(input: { query: string; limit: number }, context: ProviderContext): Promise<Citation[]> {
    context.signal.throwIfAborted();
    return scoped(this.db, context.scope, async (client) => {
      const terms = tokens(input.query).slice(0, 100);
      if (!terms.length) return [];
      const rows = (
        await client.query(
          `SELECT *, (SELECT count(*) FROM unnest(tokens) t WHERE t=ANY($1::text[])) AS score
        FROM knowledge.articles WHERE tokens && $1::text[] ORDER BY score DESC,created_at DESC,id LIMIT $2`,
          [terms, Math.min(input.limit, 5)],
        )
      ).rows;
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        excerpt: r.body.slice(0, 2000),
        source: `knowledge://${r.source_id}/${r.id}`,
        version: r.revision,
        observedAt: r.created_at.toISOString(),
        visibility: 'TENANT',
        scope: {
          organizationId: context.scope.organizationId,
          projectId: context.scope.projectId,
          tenantId: context.scope.tenantId,
        },
      }));
    });
  }
  async catalogue(scope: Scope) {
    return scoped(this.db, scope, async (client) => {
      const rows = (
        await client.query(
          'SELECT id,title,category,source_id,revision FROM knowledge.articles ORDER BY category,title,id LIMIT 501',
        )
      ).rows;
      return {
        articles: rows
          .slice(0, 500)
          .map((r) => ({ id: r.id, title: r.title, category: r.category, version: r.revision })),
        truncated: rows.length > 500,
      };
    });
  }
  async article(scope: Scope, id: string) {
    return scoped(this.db, scope, async (client) => {
      const r = (await client.query('SELECT * FROM knowledge.articles WHERE id=$1', [id])).rows[0];
      return r ? articleView(r) : null;
    });
  }
  async visible(scope: Scope, citations: SafeCitation[]) {
    if (!citations.length) return [];
    return scoped(this.db, scope, async (client) => {
      const ids = citations
        .filter((c) => c.source.startsWith('knowledge://'))
        .map((c) => c.id)
        .filter((id) => /^[0-9a-f-]{36}$/.test(id));
      const current = (
        await client.query('SELECT id FROM knowledge.articles WHERE id=ANY($1::uuid[])', [ids])
      ).rows;
      return citations.filter((c) => current.some((r) => r.id === c.id));
    });
  }
}
export class ProjectKnowledgeProvider implements KnowledgeProvider {
  manifest = {
    id: 'knowledge-project-router',
    version: '0.3.0',
    capabilities: ['knowledge.search'],
    mode: 'live' as const,
  };
  constructor(
    private readonly indexed: IndexedKnowledgeProvider,
    private readonly fixture: KnowledgeProvider,
    private readonly isIndexed: (scope: Scope) => boolean,
  ) {}
  search(input: { query: string; limit: number }, context: ProviderContext) {
    return (this.isIndexed(context.scope) ? this.indexed : this.fixture).search(input, context);
  }
  visible(scope: Scope, citations: SafeCitation[]) {
    return this.isIndexed(scope)
      ? this.indexed.visible(scope, citations)
      : Promise.resolve(citations.filter((c) => c.source.startsWith('fixture://')));
  }
}
