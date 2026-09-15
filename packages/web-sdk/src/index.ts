import type { ClientContext } from '@agent18/contracts';
import { captureCollector, type CaptureOptions } from './capture.js';
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
  AssistantTurn,
  AssistantRoute,
} from '@agent18/contracts';
export type {
  PageCapture,
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
  AssistantTurn,
  AssistantRoute,
} from '@agent18/contracts';
export type { CaptureOptions } from './capture.js';
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
  capture?: CaptureOptions;
};
export class Agent18 {
  private context: ReportCase['context'] = {};
  private readonly abort = new AbortController();
  private readonly collector;
  constructor(private readonly options: Agent18Options) {
    this.collector = captureCollector(options.capture);
  }
  async capturePage() {
    this.abort.signal.throwIfAborted();
    const capture = this.collector.snapshot();
    if (capture && this.options.capture?.screenshot) {
      try {
        const url = this.options.baseUrl.replace(/\/$/, '') + '/sdk/capture.js';
        const module = (await import(/* @vite-ignore */ url)) as {
          captureViewport(): Promise<string | undefined>;
        };
        const screenshot = await module.captureViewport();
        if (screenshot) capture.screenshot = screenshot;
        else capture.notice += ' 截图过大，已省略。';
      } catch {
        capture.notice += ' 当前页面无法生成截图，其他上下文仍可提交。';
      }
    }
    this.abort.signal.throwIfAborted();
    return capture;
  }
  setContext(input: Omit<ClientContext, 'pagePath'> & { pageUrl?: string }) {
    let pagePath: string | undefined;
    if (input.pageUrl) {
      try {
        const path = new URL(input.pageUrl, 'https://context.invalid').pathname;
        if (/^\/[a-zA-Z0-9/_-]{0,255}$/.test(path)) pagePath = path;
      } catch {
        /* Unparseable URLs are omitted. */
      }
    }
    // Business context accepts explicit hints only; page capture is collected separately on report preview.
    const extras: Record<string, unknown> = {};
    for (const key of [
      'entity',
      'sessionId',
      'traceId',
      'environment',
      'appVersion',
      'frontendVersion',
      'correlationIds',
    ] as const)
      if (input[key] !== undefined) extras[key] = input[key];
    const bounded = (v: unknown, pattern: RegExp) => typeof v === 'string' && pattern.test(v);
    for (const key of ['sessionId', 'traceId', 'environment', 'appVersion', 'frontendVersion'] as const) {
      const pattern =
        key === 'traceId'
          ? /^[a-fA-F0-9]{16,32}$/
          : key === 'environment'
            ? /^[a-zA-Z0-9_.-]{1,64}$/
            : key.endsWith('Version')
              ? /^[a-zA-Z0-9_.+-]{1,80}$/
              : /^[a-zA-Z0-9_.:-]{1,128}$/;
      if (input[key] !== undefined && !bounded(input[key], pattern)) throw new Error('CONTEXT_INVALID');
    }
    if (input.entity) {
      const e = input.entity;
      if (
        !bounded(e.type, /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/) ||
        typeof e.id !== 'string' ||
        !e.id.length ||
        e.id.length > 128 ||
        (e.namespace !== undefined && !bounded(e.namespace, /^[a-zA-Z0-9_.-]{1,80}$/))
      )
        throw new Error('CONTEXT_INVALID');
      extras.entity = { type: e.type, id: e.id, ...(e.namespace ? { namespace: e.namespace } : {}) };
    }
    if (input.correlationIds) {
      const entries = Object.entries(input.correlationIds);
      if (
        entries.length > 10 ||
        entries.some(
          ([k, v]) => !bounded(k, /^[a-zA-Z0-9_.-]{1,40}$/) || !bounded(v, /^[a-zA-Z0-9_.:-]{1,128}$/),
        )
      )
        throw new Error('CONTEXT_INVALID');
      extras.correlationIds = Object.fromEntries(entries);
    }
    this.context = {
      ...(pagePath ? { pagePath } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId.slice(0, 100) } : {}),
      ...(input.requestId ? { requestId: input.requestId.slice(0, 100) } : {}),
      ...extras,
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
  routeConversation(input: AssistantTurn) {
    return this.request<AssistantRoute>('/api/assistant/route', 'POST', { ...input, context: this.context });
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
    this.collector.dispose();
    this.context = {};
  }
}
export { mountAssistant, mountFloatingAssistant, type AssistantOptions } from './widget.js';

export { openSupportPage } from './standalone.js';
