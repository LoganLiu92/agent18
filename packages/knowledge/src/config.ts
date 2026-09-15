import { z } from 'zod';

export const categories = [
  'overview',
  'architecture',
  'api',
  'workflows',
  'configuration',
  'troubleshooting',
] as const;
export const sourceSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    name: z.string().min(1).max(120),
    kind: z.enum(['directory', 'git']),
    location: z.string().min(1).max(1000),
    ref: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/)
      .default('HEAD'),
    include: z.array(z.string().min(1).max(200)).min(1).default(['**/*']),
    exclude: z.array(z.string().min(1).max(200)).default([]),
    audience: z.enum(['internal', 'customer']).default('internal'),
    tenantIds: z.array(z.string().min(1).max(128)).max(200).default([]),
    maxFiles: z.number().int().min(1).max(10000).default(2000),
    maxTotalBytes: z.number().int().min(1000).max(100_000_000).default(20_000_000),
    maxFileBytes: z.number().int().min(1000).max(1_000_000).default(256_000),
  })
  .strict();
export const knowledgeConfigSchema = z
  .object({
    projectKey: z.string().min(1),
    mode: z.enum(['extractive', 'model']).default('extractive'),
    maxModelCalls: z.number().int().min(1).max(2000).default(100),
    sources: z.array(sourceSchema).min(1).max(30),
  })
  .strict()
  .refine((x) => new Set(x.sources.map((s) => s.id)).size === x.sources.length, 'Duplicate source ids');
export type SourceConfig = z.infer<typeof sourceSchema>;
export type KnowledgeConfig = z.infer<typeof knowledgeConfigSchema>;
export class KnowledgeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export type ModelConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
  tokenLimitField: 'max_completion_tokens' | 'max_tokens';
  jsonMode: boolean;
};
export function modelFromEnvironment(env: NodeJS.ProcessEnv = process.env): ModelConfig | undefined {
  const baseUrl = env.AGENT18_MODEL_BASE_URL,
    model = env.AGENT18_MODEL_NAME,
    apiKey = env.AGENT18_MODEL_API_KEY;
  if (!baseUrl && !model && !apiKey) return undefined;
  if (!baseUrl || !model || !apiKey) throw new KnowledgeError('MODEL_CONFIGURATION_INCOMPLETE');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new KnowledgeError('MODEL_URL_INVALID');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname))
    )
  )
    throw new KnowledgeError('MODEL_URL_INVALID');
  const maxTokens = Number(env.AGENT18_MODEL_MAX_TOKENS ?? 2048);
  const timeoutMs = Number(env.AGENT18_MODEL_TIMEOUT_MS ?? 30000);
  if (
    !Number.isInteger(maxTokens) ||
    maxTokens < 128 ||
    maxTokens > 8192 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60000
  )
    throw new KnowledgeError('MODEL_BUDGET_INVALID');
  const tokenLimitField = env.AGENT18_MODEL_TOKEN_LIMIT_FIELD ?? 'max_completion_tokens';
  if (!['max_tokens', 'max_completion_tokens'].includes(tokenLimitField))
    throw new KnowledgeError('MODEL_CONFIGURATION_INVALID');
  return {
    baseUrl: url.href.replace(/\/$/, ''),
    model,
    apiKey,
    timeoutMs,
    maxTokens,
    tokenLimitField: tokenLimitField as ModelConfig['tokenLimitField'],
    jsonMode: env.AGENT18_MODEL_JSON_MODE !== 'false',
  };
}
