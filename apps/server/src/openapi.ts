import { z } from 'zod';
import {
  metricDefinitionSchema,
  conversationInput,
  conversationMessageInput,
  reportCaseSchema,
  caseSchema,
  contextSchema,
  safeCitationSchema,
  evidenceViewSchema,
  searchSchema,
  assistantTurnSchema,
  pageCaptureSchema,
} from '@agent18/contracts';
const schema = (s: z.ZodType) => z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input' });
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const array = (items: unknown) => ({ type: 'array', items });
const string = { type: 'string' },
  uuid = { type: 'string', format: 'uuid' },
  bool = { type: 'boolean' };
const args = { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } };
const field = object(
  {
    name: string,
    label: string,
    type: { enum: ['string', 'number', 'boolean'] },
    required: bool,
    enum: array(string),
  },
  ['name', 'label', 'type', 'required'],
);
const column = object({ path: string, label: string });
export const publicApiDefinitions: {
  method: 'get' | 'post';
  path: string;
  summary: string;
  tag: string;
  body?: unknown;
  response: unknown;
  idempotent?: boolean;
  created?: boolean;
}[] = [
  {
    method: 'get',
    path: '/api/conversations',
    summary: 'List the current customer conversations',
    tag: 'Conversations',
    response: object({
      conversations: array(object({ id: uuid, title: string, createdAt: string, updatedAt: string })),
      nextOffset: { type: ['integer', 'null'] },
    }),
  },
  {
    method: 'post',
    path: '/api/conversations',
    summary: 'Create an independent conversation',
    tag: 'Conversations',
    body: schema(conversationInput),
    response: object({
      conversation: object({ id: uuid, title: string, createdAt: string, updatedAt: string }),
      replayed: bool,
    }),
    idempotent: true,
  },
  {
    method: 'get',
    path: '/api/conversations/{id}',
    summary: 'Read display history without resuming actions',
    tag: 'Conversations',
    response: object({
      conversation: object({ id: uuid, title: string, createdAt: string, updatedAt: string }),
      messages: array(
        object({
          id: uuid,
          sequence: { type: 'integer' },
          role: { enum: ['user', 'assistant'] },
          body: string,
          origin: { const: 'client_display' },
          createdAt: string,
        }),
      ),
      nextAfter: { type: ['integer', 'null'] },
      cases: array(object({ id: uuid, title: string, status: string })),
    }),
  },
  {
    method: 'post',
    path: '/api/conversations/{id}/messages',
    summary: 'Append untrusted display text; does not execute tools',
    tag: 'Conversations',
    body: schema(conversationMessageInput),
    response: object({ id: uuid, sequence: { type: 'integer' }, replayed: bool }),
    idempotent: true,
  },
  {
    method: 'post',
    path: '/api/conversations/{id}/cases',
    summary: 'Link an owned ticket to an owned conversation',
    tag: 'Conversations',
    body: object({ caseId: uuid }),
    response: object({ linked: bool }),
  },
  {
    method: 'post',
    path: '/api/conversations/{id}/delete',
    summary: 'Delete message bodies and links, retaining separately reported tickets',
    tag: 'Conversations',
    body: object({}),
    response: object({ deleted: bool }),
  },
  {
    method: 'post',
    path: '/api/assistant/route',
    summary: 'Route a conversational turn to allowed capabilities without executing them',
    tag: 'Assistant',
    body: schema(assistantTurnSchema),
    response: {
      oneOf: [
        object({ kind: { enum: ['knowledge'] }, query: string }),
        object({ kind: { enum: ['query', 'action'] }, id: string, arguments: args }),
        object({ kind: { enum: ['help', 'cases', 'support', 'cancel'] } }),
      ],
    },
  },
  {
    method: 'get',
    path: '/api/session',
    summary: 'Verify current user and discover available capabilities',
    tag: 'Identity',
    response: ref('Session'),
  },
  {
    method: 'get',
    path: '/api/cases',
    summary: 'List current user cases, newest first, maximum 100',
    tag: 'Cases',
    response: object({ cases: array(ref('Case')) }),
  },
  {
    method: 'post',
    path: '/api/cases',
    summary: 'Report a case and enqueue investigation atomically',
    tag: 'Cases',
    body: schema(reportCaseSchema),
    response: object({ case: ref('Case'), replayed: bool }),
    idempotent: true,
    created: true,
  },
  {
    method: 'get',
    path: '/api/cases/{caseId}',
    summary: 'Read a case, run history and currently visible evidence',
    tag: 'Cases',
    response: ref('CaseDetail'),
  },
  {
    method: 'get',
    path: '/api/cases/{caseId}/messages',
    summary: 'Read latest 100 messages, oldest first',
    tag: 'Cases',
    response: object({ messages: array(ref('Message')) }),
  },
  {
    method: 'post',
    path: '/api/cases/{caseId}/messages',
    summary: 'Add a customer follow-up',
    tag: 'Cases',
    body: object({ body: { type: 'string', minLength: 1, maxLength: 4000 } }),
    response: object({ replayed: bool }),
    idempotent: true,
  },
  {
    method: 'post',
    path: '/api/cases/{caseId}/status',
    summary: 'Resolve or reopen own case; no new run is automatically started',
    tag: 'Cases',
    body: object({ status: { enum: ['resolved', 'needs_human'] } }),
    response: object({ case: ref('Case') }),
  },
  {
    method: 'post',
    path: '/api/knowledge/search',
    summary: 'Retrieve permitted published evidence',
    tag: 'Knowledge',
    body: schema(searchSchema),
    response: object({
      mode: { const: 'retrieval_only' },
      citations: array(ref('Citation')),
      notice: string,
    }),
  },
  {
    method: 'post',
    path: '/api/knowledge/ask',
    summary: 'Answer using retrieved evidence, or return retrieval when no model is configured',
    tag: 'Knowledge',
    body: schema(searchSchema),
    response: object({
      mode: { enum: ['model', 'retrieval_only'] },
      answer: { type: ['string', 'null'] },
      citations: array(ref('Citation')),
      notice: string,
    }),
  },
  {
    method: 'get',
    path: '/api/knowledge/catalogue',
    summary: 'Published catalogue, maximum 500 articles',
    tag: 'Knowledge',
    response: object({
      articles: array(object({ id: uuid, title: string, category: string, version: string })),
      truncated: bool,
    }),
  },
  {
    method: 'get',
    path: '/api/knowledge/articles/{articleId}',
    summary: 'Read one published article and source references',
    tag: 'Knowledge',
    response: ref('Article'),
  },
  {
    method: 'post',
    path: '/api/cases/{id}/capture/delete',
    summary: 'Erase customer-owned page capture and derived investigation reports',
    tag: 'Cases',
    body: object({}),
    response: object({ deleted: bool }),
  },
  {
    method: 'get',
    path: '/api/business/queries',
    summary: 'List enabled operations allowed for current user roles',
    tag: 'Business reads',
    response: object({ queries: array(ref('BusinessQuery')) }),
  },
  {
    method: 'post',
    path: '/api/business/query',
    summary: 'Execute registered GET using current bearer token; return projected fields',
    tag: 'Business reads',
    body: object({ queryId: string, arguments: args }),
    response: object(
      {
        metric: schema(metricDefinitionSchema),
        period: object({ start: string, end: string }),
        queryId: string,
        columns: array(column),
        rows: array({
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        }),
        truncated: bool,
        retrievedAt: { type: 'string', format: 'date-time' },
        requestId: string,
      },
      ['queryId', 'columns', 'rows', 'truncated', 'retrievedAt', 'requestId'],
    ),
  },
  {
    method: 'get',
    path: '/api/actions',
    summary: 'List enabled actions allowed for current user roles',
    tag: 'Business actions',
    response: object({ actions: array(ref('Action')) }),
  },
  {
    method: 'post',
    path: '/api/actions/plan',
    summary: 'Use model to propose one allowed action; never execute',
    tag: 'Business actions',
    body: schema(searchSchema),
    response: ref('Proposal'),
  },
  {
    method: 'post',
    path: '/api/actions/prepare',
    summary: 'Prepare exact preview, expiring in five minutes',
    tag: 'Business actions',
    body: object({ actionId: string, arguments: args }),
    response: ref('Proposal'),
  },
  {
    method: 'get',
    path: '/api/actions/proposals',
    summary: 'List latest 20 own proposals and receipts',
    tag: 'Business actions',
    response: object({ proposals: array(ref('Proposal')) }),
  },
  {
    method: 'get',
    path: '/api/actions/proposals/{proposalId}',
    summary: 'Read own proposal',
    tag: 'Business actions',
    response: ref('Proposal'),
  },
  {
    method: 'post',
    path: '/api/actions/proposals/{proposalId}/confirm',
    summary: 'Confirm exact stored preview; delivery uncertainty is preserved',
    tag: 'Business actions',
    body: object({ confirmed: { const: true } }),
    response: ref('Proposal'),
  },
  {
    method: 'post',
    path: '/api/actions/proposals/{proposalId}/reconcile',
    summary: 'Read business receipt without retrying a write',
    tag: 'Business actions',
    body: object({}),
    response: ref('Proposal'),
  },
  {
    method: 'post',
    path: '/api/runs/{runId}/cancel',
    summary: 'Cancel an owned run',
    tag: 'Cases',
    body: object({}),
    response: object({ runId: uuid, state: string, replayed: bool }),
  },
  {
    method: 'post',
    path: '/api/runs/{runId}/retry',
    summary: 'Create an explicit bounded retry of an owned run',
    tag: 'Cases',
    body: object({}),
    response: object({ runId: uuid, replayed: bool }),
    idempotent: true,
    created: true,
  },
];
export const openApi = {
  openapi: '3.1.0',
  info: {
    title: 'agent18 Customer API',
    version: '0.8.0',
    description:
      'Project-, tenant- and subject-scoped API. Local owner and workload APIs are intentionally separate. JSON requests; unsupported input fields are rejected. Never pass tenant or subject in request bodies.',
  },
  servers: [{ url: '/' }],
  security: [{ supportToken: [], projectKey: [] }],
  paths: Object.fromEntries(
    [...new Set(publicApiDefinitions.map((d) => d.path))].map((path) => [
      path,
      Object.fromEntries(
        publicApiDefinitions
          .filter((d) => d.path === path)
          .map((d) => [
            d.method,
            {
              operationId: d.method + d.path.replace(/[^a-zA-Z0-9]/g, '_'),
              summary: d.summary,
              tags: [d.tag],
              parameters: [
                ...[...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
                  name: m[1],
                  in: 'path',
                  required: true,
                  schema: uuid,
                })),
                ...(d.idempotent
                  ? [
                      {
                        name: 'Idempotency-Key',
                        in: 'header',
                        required: true,
                        schema: uuid,
                        description:
                          'Same UUID and same body replay; changed body conflicts. Keys are scoped to user and operation.',
                      },
                    ]
                  : []),
              ],
              ...(d.body
                ? { requestBody: { required: true, content: { 'application/json': { schema: d.body } } } }
                : {}),
              responses: {
                '200': {
                  description: d.created ? 'Existing idempotent result' : 'Success',
                  content: { 'application/json': { schema: d.response } },
                },
                ...(d.created
                  ? {
                      '201': {
                        description: 'Created',
                        content: { 'application/json': { schema: d.response } },
                      },
                    }
                  : {}),
                default: {
                  description: 'Rejected or unavailable; stable error code and diagnostic requestId',
                  content: { 'application/json': { schema: ref('Error') } },
                },
              },
            },
          ]),
      ),
    ]),
  ),
  components: {
    securitySchemes: {
      supportToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Short-lived EdDSA token issued by your authenticated SaaS backend; exp-iat <= 600 seconds.',
      },
      projectKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Project-Key',
        description: 'Public project identifier; must match signed project_key.',
      },
    },
    schemas: {
      Error: object({ error: object({ code: string, requestId: string }) }),
      Session: object({
        principal: object({
          kind: { const: 'customer' },
          tenantId: string,
          subject: string,
          projectId: uuid,
        }),
        capabilities: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
        tool: object({ id: string, effect: string, policy: string }),
      }),
      Case: schema(caseSchema),
      Context: schema(contextSchema),
      PageCapture: schema(pageCaptureSchema),
      Citation: schema(safeCitationSchema),
      Evidence: schema(evidenceViewSchema),
      Message: object({
        id: uuid,
        author: { enum: ['customer', 'support'] },
        body: string,
        createdAt: string,
      }),
      CaseDetail: object(
        {
          case: ref('Case'),
          runs: array(ref('Run')),
          capture: ref('PageCapture'),
          investigation: object({ state: string, summary: string, updatedAt: string }),
          evidence: array(ref('Evidence')),
          audit: array(
            object({
              id: uuid,
              action: string,
              decision: { enum: ['ALLOW', 'DENY', 'APPROVAL_REQUIRED'] },
              reason: string,
              createdAt: string,
            }),
          ),
        },
        ['case', 'runs', 'evidence', 'audit'],
      ),
      Run: object({
        id: uuid,
        state: { enum: ['pending', 'running', 'completed', 'blocked', 'cancelled', 'failed'] },
        outcome: { type: ['string', 'null'] },
        createdAt: string,
        completedAt: { type: ['string', 'null'] },
        attemptCount: { type: 'integer' },
        maxAttempts: { type: 'integer' },
        executionBudgetMs: { type: 'integer' },
        expiresAt: string,
        retryOf: { type: ['string', 'null'] },
        canCancel: bool,
        canRetry: bool,
        steps: array(
          object({
            id: uuid,
            attempt: { type: 'integer' },
            name: string,
            capability: string,
            toolId: { type: ['string', 'null'] },
            providerId: { type: ['string', 'null'] },
            inputRef: { type: ['string', 'null'] },
            outputRef: { type: ['string', 'null'] },
            policyDecision: { enum: ['ALLOW', 'DENY', 'APPROVAL_REQUIRED', null] },
            state: { enum: ['started', 'succeeded', 'failed', 'cancelled', 'interrupted'] },
            reason: string,
            durationMs: { type: ['integer', 'null'] },
            createdAt: string,
          }),
        ),
      }),
      Article: object({
        id: uuid,
        title: string,
        body: string,
        category: string,
        source: string,
        version: string,
        observedAt: string,
        references: {
          type: 'array',
          items: {},
          maxItems: 0,
          deprecated: true,
          description:
            'Compatibility field; always empty. Internal source evidence is not part of the customer API.',
        },
      }),
      BusinessQuery: object(
        {
          metric: schema(metricDefinitionSchema),
          id: string,
          title: string,
          description: string,
          fields: array(field),
          columns: array(column),
        },
        ['id', 'title', 'description', 'fields', 'columns'],
      ),
      Action: object({ id: string, title: string, description: string, fields: array(field) }),
      Proposal: object({
        id: uuid,
        actionId: string,
        arguments: args,
        preview: object({ summary: string, revision: string }),
        state: { enum: ['proposed', 'executing', 'succeeded', 'rejected', 'uncertain', 'expired'] },
        result: {
          anyOf: [
            { type: 'null' },
            object({ status: string, message: string, receiptId: string }, ['status', 'message']),
          ],
        },
        createdAt: string,
        expiresAt: string,
      }),
    },
  },
};
