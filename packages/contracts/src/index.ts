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
export const contextSchema = z
  .object({
    pagePath: z
      .string()
      .max(256)
      .regex(/^\/[a-zA-Z0-9/_-]*$/)
      .optional(),
    entityType: z.enum(['invoice', 'order', 'other']).optional(),
    entityId: z.string().max(100).optional(),
    requestId: z.string().max(100).optional(),
  })
  .strict();
export const reportCaseSchema = z
  .object({
    title: z.string().trim().min(3).max(180),
    description: z.string().trim().min(3).max(4000),
    context: contextSchema.default({}),
  })
  .strict();
export type ReportCase = z.infer<typeof reportCaseSchema>;
export const searchSchema = z.object({ query: z.string().trim().min(2).max(300) }).strict();
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
  status: z.enum(['open', 'needs_human']),
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
  name: 'execution' | 'knowledge.search';
  state: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  reason: string;
  durationMs: number | null;
  createdAt: string;
};
export type AuditView = {
  id: string;
  action: string;
  decision: 'ALLOW' | 'DENY';
  reason: string;
  createdAt: string;
};
export type CaseDetail = { case: SupportCase; runs: RunView[]; evidence: SafeCitation[]; audit: AuditView[] };
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
