import { scoped, type Database } from '@agent18/persistence';
import type { Citation, SafeCitation, Scope, KnowledgeArticle } from '@agent18/contracts';
import type { KnowledgeProvider, ProviderContext } from '@agent18/provider-contracts';
import { tokens } from './scan.js';
import type { QueryResultRow } from 'pg';
// Article IDs are immutable within a publication. Source commits and file references stay internal.
const publishedCitation = (r: QueryResultRow): SafeCitation => ({
  id: r.id,
  title: r.title,
  excerpt: r.body.slice(0, 2000),
  source: `knowledge://${r.source_id}/${r.id}`,
  version: `publication-${r.build_id}`,
  observedAt: r.created_at.toISOString(),
});
const articleView = (r: QueryResultRow): KnowledgeArticle => ({
  id: r.id,
  title: r.title,
  body: r.body,
  category: r.category,
  source: `knowledge://${r.source_id}/${r.id}`,
  version: `publication-${r.build_id}`,
  observedAt: r.created_at.toISOString(),
  // Keep the legacy field empty so older SDK readers remain compatible.
  references: [],
});
export async function rankedArticles(
  client: import('pg').PoolClient,
  terms: string[],
  limit: number,
  publicOnly = false,
  candidates: {
    id: string;
    source_id: string;
    build_id: string;
    title: string;
    body: string;
    category: string;
    tokens: string[];
    created_at: string;
  }[] = [],
) {
  if (candidates.length && !publicOnly) throw new Error('Candidate retrieval is operator-only');
  return (
    await client.query(
      `WITH visible AS (
 SELECT a.id,a.title,a.body,a.source_id,a.build_id::text,a.created_at,a.category,a.tokens FROM knowledge.articles a WHERE NOT(a.source_id=ANY($5::uuid[])) AND (NOT $3::boolean OR EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=a.source_id AND s.active_build_id=a.build_id AND s.enabled AND s.audience='customer' AND cardinality(s.tenant_ids)=0))
 UNION ALL SELECT * FROM jsonb_to_recordset($4::jsonb) AS d(id uuid,title text,body text,source_id uuid,build_id text,created_at timestamptz,category text,tokens text[])
 ) SELECT a.*, (
  (SELECT count(*) FROM unnest(a.tokens) t WHERE t=ANY($1::text[])) +
  2 * (SELECT count(*) FROM unnest($1::text[]) t WHERE position(t in lower(a.title)) > 0)
 ) / sqrt(GREATEST(cardinality(a.tokens),16)::float) AS score
 FROM visible a WHERE a.tokens && $1::text[] ORDER BY score DESC,a.created_at DESC,a.id LIMIT $2`,
      [terms, Math.min(limit, 5), publicOnly, JSON.stringify(candidates), candidates.map((d) => d.source_id)],
    )
  ).rows;
}
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
      const rows = await rankedArticles(client, terms, input.limit);
      return rows.map((r) => ({
        ...publishedCitation(r),
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
          'SELECT id,title,category,build_id FROM knowledge.articles ORDER BY category,title,id LIMIT 501',
        )
      ).rows;
      return {
        articles: rows.slice(0, 500).map((r) => ({
          id: r.id,
          title: r.title,
          category: r.category,
          version: `publication-${r.build_id}`,
        })),
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
        await client.query(
          'SELECT id,title,body,source_id,build_id,created_at FROM knowledge.articles WHERE id=ANY($1::uuid[])',
          [ids],
        )
      ).rows;
      // Re-project historical citations; never echo stored source metadata back to customers.
      return citations.flatMap((c) => {
        const row = current.find((r) => r.id === c.id && c.source === `knowledge://${r.source_id}/${r.id}`);
        return row ? [publishedCitation(row)] : [];
      });
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
