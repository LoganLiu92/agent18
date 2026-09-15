import type {
  ReportCase,
  SupportCase,
  CaseDetail,
  CaseMessage,
  SearchResult,
  KnowledgeArticle,
  KnowledgeCatalogue,
  AnswerResult,
  ActionDefinition,
  ActionProposal,
  BusinessQuery,
  QueryResult,
} from '@agent18/contracts';
export type {
  ReportCase,
  SupportCase,
  CaseDetail,
  CaseMessage,
  SearchResult,
  KnowledgeArticle,
  KnowledgeCatalogue,
  AnswerResult,
  ActionDefinition,
  ActionProposal,
  BusinessQuery,
  QueryResult,
} from '@agent18/contracts';
export class Agent18Error extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
export type Session = {
  principal: { kind: 'customer'; tenantId: string; subject: string; projectId: string };
  capabilities: Record<string, string | boolean>;
  tool: { id: string; effect: string; policy: string };
};
export type Agent18Options = {
  baseUrl: string;
  projectKey: string;
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
};
export class Agent18 {
  private context: ReportCase['context'] = {};
  private readonly abort = new AbortController();
  constructor(private readonly options: Agent18Options) {}
  setContext(input: {
    pageUrl?: string;
    entityType?: 'invoice' | 'order' | 'other';
    entityId?: string;
    requestId?: string;
  }) {
    let pagePath: string | undefined;
    if (input.pageUrl) {
      try {
        const path = new URL(input.pageUrl, 'https://context.invalid').pathname;
        if (/^\/[a-zA-Z0-9/_-]{0,255}$/.test(path)) pagePath = path;
      } catch {
        /* Unparseable URLs are omitted. */
      }
    }
    // Never collect cookies, DOM, query strings, fragments, network payloads or full URLs.
    this.context = {
      ...(pagePath ? { pagePath } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId.slice(0, 100) } : {}),
      ...(input.requestId ? { requestId: input.requestId.slice(0, 100) } : {}),
    };
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
    this.abort.signal.throwIfAborted();
    const token = await this.options.getToken();
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl.replace(/\/$/, '')}${path}`,
      {
        method,
        signal: this.abort.signal,
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          authorization: `Bearer ${token}`,
          'x-project-key': this.options.projectKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Agent18Error(result.error?.code ?? 'REQUEST_FAILED', response.status);
    return result as T;
  }
  session() {
    return this.request<Session>('/api/session');
  }
  listCases() {
    return this.request<{ cases: SupportCase[] }>('/api/cases');
  }
  getCase(id: string) {
    return this.request<CaseDetail>(`/api/cases/${encodeURIComponent(id)}`);
  }
  caseMessages(id: string) {
    return this.request<{ messages: CaseMessage[] }>(`/api/cases/${encodeURIComponent(id)}/messages`);
  }
  addCaseMessage(id: string, body: string, key: string) {
    return this.request<{ replayed: boolean }>(
      `/api/cases/${encodeURIComponent(id)}/messages`,
      'POST',
      { body },
      key,
    );
  }
  setCaseStatus(id: string, status: 'resolved' | 'needs_human') {
    return this.request<{ case: SupportCase }>(`/api/cases/${encodeURIComponent(id)}/status`, 'POST', {
      status,
    });
  }
  reportCase(input: Omit<ReportCase, 'context'>, idempotencyKey: string) {
    return this.request<{ case: SupportCase; replayed: boolean }>(
      '/api/cases',
      'POST',
      { ...input, context: this.context },
      idempotencyKey,
    );
  }
  searchKnowledge(query: string) {
    return this.request<SearchResult>('/api/knowledge/search', 'POST', { query });
  }
  knowledgeCatalogue() {
    return this.request<KnowledgeCatalogue>('/api/knowledge/catalogue');
  }
  knowledgeArticle(id: string) {
    return this.request<KnowledgeArticle>(`/api/knowledge/articles/${encodeURIComponent(id)}`);
  }
  askKnowledge(query: string) {
    return this.request<AnswerResult>('/api/knowledge/ask', 'POST', { query });
  }
  listBusinessQueries() {
    return this.request<{ queries: BusinessQuery[] }>('/api/business/queries');
  }
  queryBusiness(queryId: string, args: Record<string, string | number | boolean>) {
    return this.request<QueryResult>('/api/business/query', 'POST', { queryId, arguments: args });
  }
  listActions() {
    return this.request<{ actions: ActionDefinition[] }>('/api/actions');
  }
  planAction(query: string) {
    return this.request<ActionProposal>('/api/actions/plan', 'POST', { query });
  }
  prepareAction(actionId: string, args: Record<string, string | number | boolean>) {
    return this.request<ActionProposal>('/api/actions/prepare', 'POST', { actionId, arguments: args });
  }
  listActionHistory() {
    return this.request<{ proposals: ActionProposal[] }>('/api/actions/proposals');
  }
  getAction(id: string) {
    return this.request<ActionProposal>(`/api/actions/proposals/${encodeURIComponent(id)}`);
  }
  confirmAction(id: string) {
    return this.request<ActionProposal>(`/api/actions/proposals/${encodeURIComponent(id)}/confirm`, 'POST', {
      confirmed: true,
    });
  }
  reconcileAction(id: string) {
    return this.request<ActionProposal>(
      `/api/actions/proposals/${encodeURIComponent(id)}/reconcile`,
      'POST',
      {},
    );
  }
  cancelRun(runId: string) {
    return this.request<{ runId: string; state: string; replayed: boolean }>(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      'POST',
      {},
    );
  }
  retryRun(runId: string, idempotencyKey: string) {
    return this.request<{ runId: string; replayed: boolean }>(
      `/api/runs/${encodeURIComponent(runId)}/retry`,
      'POST',
      {},
      idempotencyKey,
    );
  }
  destroy() {
    this.abort.abort();
    this.context = {};
  }
}
export { mountAssistant, mountFloatingAssistant, type AssistantOptions } from './widget.js';

export { openSupportPage } from './standalone.js';
