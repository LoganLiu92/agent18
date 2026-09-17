import { z } from 'zod';

export const id = z.string().uuid();
export const scopeSchema = z
  .object({
    organizationId: id,
    projectId: id,
    tenantId: z.string().min(1).max(128),
    subject: z.string().min(1).max(128),
  })
  .strict();
export type Scope = z.infer<typeof scopeSchema>;
export const pageCaptureSchema = z
  .object({
    capturedAt: z.string().datetime(),
    page: z
      .object({
        title: z.string().max(200),
        path: z.string().max(256),
        language: z.string().max(32),
        width: z.number().int().min(0).max(10000),
        height: z.number().int().min(0).max(10000),
        online: z.boolean(),
      })
      .strict(),
    text: z.string().max(8000),
    errors: z.array(z.string().max(500)).max(10),
    breadcrumbs: z
      .array(
        z
          .object({
            at: z.string().datetime(),
            type: z.enum(['click', 'navigation']),
            detail: z.string().max(200),
          })
          .strict(),
      )
      .max(20),
    requests: z
      .array(
        z
          .object({
            path: z.string().max(256),
            status: z.number().int().min(0).max(599),
            durationMs: z.number().int().min(0).max(3600000),
          })
          .strict(),
      )
      .max(10),
    screenshot: z
      .string()
      .max(700000)
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/)
      .optional(),
    notice: z.string().max(300),
  })
  .strict();
export type PageCapture = z.infer<typeof pageCaptureSchema>;
export const businessEventSchema = z
  .object({
    type: z.enum(['business.operation.failed', 'business.operation.succeeded']),
    operation: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/),
    at: z.string().datetime(),
    entity: z
      .object({
        type: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/),
        id: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
    errorCode: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,80}$/)
      .optional(),
    traceId: z
      .string()
      .regex(/^[a-fA-F0-9]{16,32}$/)
      .optional(),
    requestId: z
      .string()
      .regex(/^[a-zA-Z0-9_.:-]{1,100}$/)
      .optional(),
  })
  .strict();
export type BusinessEvent = z.infer<typeof businessEventSchema>;
export const contextSchema = z
  .object({
    route: z
      .string()
      .regex(/^[a-zA-Z0-9_./-]{1,120}$/)
      .optional(),
    events: z.array(businessEventSchema).max(5).optional(),
    pagePath: z
      .string()
      .max(256)
      .regex(/^\/[a-zA-Z0-9/_-]*$/)
      .optional(),
    // Legacy fields remain accepted during the 0.6 preview transition.
    entityType: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/)
      .optional(),
    entity: z
      .object({
        namespace: z
          .string()
          .regex(/^[a-zA-Z0-9_.-]{1,80}$/)
          .optional(),
        type: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/),
        id: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
    sessionId: z
      .string()
      .regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
      .optional(),
    traceId: z
      .string()
      .regex(/^[a-fA-F0-9]{16,32}$/)
      .optional(),
    environment: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
      .optional(),
    appVersion: z
      .string()
      .regex(/^[a-zA-Z0-9_.+-]{1,80}$/)
      .optional(),
    frontendVersion: z
      .string()
      .regex(/^[a-zA-Z0-9_.+-]{1,80}$/)
      .optional(),
    correlationIds: z
      .record(z.string().regex(/^[a-zA-Z0-9_.-]{1,40}$/), z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/))
      .refine((v) => Object.keys(v).length <= 10)
      .optional(),
    entityId: z.string().max(100).optional(),
    requestId: z.string().max(100).optional(),
  })
  .strict();
export const reportCaseSchema = z
  .object({
    title: z.string().trim().min(3).max(180),
    description: z.string().trim().min(3).max(4000),
    context: contextSchema.default({}),
    capture: pageCaptureSchema.optional(),
  })
  .strict();
export type ClientContext = z.infer<typeof contextSchema>;
export type ReportCase = z.infer<typeof reportCaseSchema>;
export const searchSchema = z.object({ query: z.string().trim().min(2).max(300) }).strict();
const assistantArguments = z
  .record(z.string().max(50), z.union([z.string().max(500), z.number().finite(), z.boolean()]))
  .refine((v) => Object.keys(v).length <= 20);
export const assistantTurnSchema = z
  .object({
    message: z.string().trim().min(1).max(1000),
    history: z.array(z.string().max(500)).max(6).default([]),
    context: contextSchema.optional(),
    pending: z
      .object({
        kind: z.enum(['query', 'action']),
        id: z.string().max(80),
        arguments: assistantArguments,
        field: z.string().max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AssistantTurn = z.infer<typeof assistantTurnSchema>;
export type AssistantRoute =
  | { kind: 'knowledge'; query: string }
  | { kind: 'query' | 'action'; id: string; arguments: Record<string, string | number | boolean> }
  | { kind: 'help' | 'cases' | 'support' | 'cancel' };
export const citationSchema = z
  .object({
    id: z.string().max(200),
    title: z.string().max(200),
    excerpt: z.string().max(2000),
    source: z.string().max(300),
    version: z.string().max(100),
    observedAt: z.string().datetime(),
    visibility: z.enum(['PUBLIC', 'TENANT', 'INTERNAL', 'ENGINEERING']),
    scope: scopeSchema.omit({ subject: true }),
  })
  .strict();
export type Citation = z.infer<typeof citationSchema>;
export const safeCitationSchema = citationSchema.omit({ scope: true, visibility: true });
export type SafeCitation = z.infer<typeof safeCitationSchema>;
export const caseSchema = z.object({
  id,
  title: z.string(),
  description: z.string(),
  status: z.enum(['open', 'needs_human', 'resolved']),
  context: contextSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SupportCase = z.infer<typeof caseSchema>;
export type RunView = {
  id: string;
  state: 'pending' | 'running' | 'completed' | 'blocked' | 'cancelled' | 'failed';
  outcome: string | null;
  createdAt: string;
  completedAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  executionBudgetMs: number;
  expiresAt: string;
  retryOf: string | null;
  canCancel: boolean;
  canRetry: boolean;
  steps: RunStepView[];
};
export type RunStepView = {
  id: string;
  attempt: number;
  name: string; // 0.5 compatibility alias for capability
  capability: string;
  toolId: string | null;
  providerId: string | null;
  inputRef: string | null;
  outputRef: string | null;
  policyDecision: 'ALLOW' | 'DENY' | 'APPROVAL_REQUIRED' | null;
  state: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  reason: string;
  durationMs: number | null;
  createdAt: string;
};
export type AuditView = {
  id: string;
  action: string;
  decision: 'ALLOW' | 'DENY' | 'APPROVAL_REQUIRED';
  reason: string;
  createdAt: string;
};
export type CaseDetail = {
  case: SupportCase;
  runs: RunView[];
  evidence: EvidenceView[];
  audit: AuditView[];
  capture?: PageCapture;
  investigation?: { state: string; summary: string; updatedAt: string };
};
export type SearchResult = { mode: 'retrieval_only'; citations: SafeCitation[]; notice: string };

export type KnowledgeArticle = {
  id: string;
  title: string;
  body: string;
  category: string;
  source: string;
  version: string;
  observedAt: string;
  references: { path: string; startLine: number; endLine: number; revision: string }[];
};
export type KnowledgeCatalogue = {
  articles: Pick<KnowledgeArticle, 'id' | 'title' | 'category' | 'version'>[];
  truncated: boolean;
};
export type AnswerResult = {
  mode: 'model' | 'retrieval_only';
  answer: string | null;
  citations: SafeCitation[];
  notice: string;
};

export type ActionDefinition = {
  id: string;
  title: string;
  description: string;
  fields: {
    name: string;
    label: string;
    type: 'string' | 'number' | 'boolean';
    required: boolean;
    enum?: string[];
  }[];
};
export type ActionProposal = {
  id: string;
  actionId: string;
  arguments: Record<string, string | number | boolean>;
  preview: { summary: string; revision: string };
  state: 'proposed' | 'executing' | 'succeeded' | 'rejected' | 'uncertain' | 'expired';
  result: { status: string; message: string; receiptId?: string } | null;
  createdAt: string;
  expiresAt: string;
};

export type BusinessQuery = {
  id: string;
  title: string;
  description: string;
  fields: ActionDefinition['fields'];
  columns: { path: string; label: string }[];
};
export type QueryResult = {
  queryId: string;
  columns: BusinessQuery['columns'];
  rows: Record<string, string | number | boolean | null>[];
  truncated: boolean;
  retrievedAt: string;
  requestId: string;
};

export type CaseMessage = { id: string; author: 'customer' | 'support'; body: string; createdAt: string };

export const evidenceSchema = z
  .object({
    id: id,
    kind: z.enum([
      'knowledge',
      'business',
      'log',
      'trace',
      'metric',
      'error',
      'deployment',
      'commit',
      'code',
    ]),
    source: z.string().min(1).max(300),
    observedAt: z.string().datetime(),
    resource: z
      .object({
        namespace: z.string().max(80).optional(),
        type: z.string().min(1).max(80),
        id: z.string().min(1).max(300),
      })
      .strict(),
    summary: z.string().min(1).max(2000),
    artifactRef: z
      .string()
      .regex(/^artifact:\/\/[a-f0-9-]{36}$/)
      .nullable(),
    visibility: z.enum(['PUBLIC', 'TENANT', 'INTERNAL', 'ENGINEERING']),
    sensitivity: z.enum(['PUBLIC', 'CONFIDENTIAL', 'RESTRICTED']),
    scope: scopeSchema,
    provenance: z
      .object({
        providerId: z.string().min(1).max(100),
        toolId: z.string().min(1).max(100),
        toolVersion: z.number().int().positive(),
        sourceVersion: z.string().max(100),
        requestId: z.string().max(128),
      })
      .strict(),
    citation: safeCitationSchema.optional(),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;
// Artifact payloads need their own authorization path; the customer projection never releases refs.
export const evidenceViewSchema = evidenceSchema.omit({ scope: true, artifactRef: true });
export type EvidenceView = z.infer<typeof evidenceViewSchema>;
