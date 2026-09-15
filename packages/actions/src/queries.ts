import { ToolRegistry } from '@agent18/application';
import { z } from 'zod';
import { AppError, type CustomerPrincipal } from '@agent18/domain';
import { audit, type Database } from '@agent18/persistence';
import type { OpaPolicy } from '@agent18/policy';
import { containsSecret } from '@agent18/knowledge';
import { bridgeSchema, actionSchema } from './schemas.js';
import { validateArguments } from './index.js';
import type { BusinessQuery, QueryResult } from '@agent18/contracts';

const safePath = z
  .string()
  .max(200)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/)
  .refine((v) => !v.split('.').some((p) => ['__proto__', 'constructor', 'prototype'].includes(p)));
const fields = actionSchema.shape.fields.element.extend({ in: z.enum(['path', 'query']) });
export const querySchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{1,79}$/),
    title: z.string().min(1).max(100),
    description: z.string().max(1000),
    path: z
      .string()
      .max(500)
      .regex(/^\/(?:[a-zA-Z0-9_/-]|\{[a-z][a-zA-Z0-9_]{0,49}\})*$/)
      .refine((v) => !v.includes('//')),
    fields: z.array(fields).max(20),
    rowsPath: safePath.or(z.literal('')).default(''),
    columns: z
      .array(z.object({ path: safePath, label: z.string().min(1).max(100) }).strict())
      .min(1)
      .max(30),
    roles: z.array(z.string().min(1).max(50)).min(1).max(20),
    enabled: z.boolean().default(false),
  })
  .strict()
  .superRefine((q, ctx) => {
    const variables = [...q.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    if (
      new Set(q.fields.map((f) => f.name)).size !== q.fields.length ||
      q.fields.some((f) => f.in === 'path' && (!f.required || !variables.includes(f.name))) ||
      variables.some((v) => !q.fields.some((f) => f.name === v && f.in === 'path'))
    )
      ctx.addIssue({ code: 'custom', message: 'Path parameters must match required fields' });
  });
export const queriesSchema = z
  .object({
    baseUrl: bridgeSchema.shape.url.refine((raw) => !new URL(raw).pathname.split('/').includes('..')),
    operations: z.array(querySchema).max(100),
  })
  .strict()
  .refine((v) => new Set(v.operations.map((q) => q.id)).size === v.operations.length, 'Duplicate operations');
export type QueryConfig = z.infer<typeof queriesSchema>;

// Import is offline and declarative. No servers, remote references or executable extensions are followed.
export function importOpenApi(raw: unknown) {
  const doc = z
    .object({ openapi: z.string().regex(/^3\.[01]\.\d+$/), paths: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(raw) as Record<string, any>;
  if (JSON.stringify(raw).length > 500000 || Object.keys(doc.paths).length > 500)
    throw new AppError('OPENAPI_TOO_LARGE', 400);
  const deref = (value: any, seen: string[] = []): any => {
    if (!value?.$ref) return value;
    const ref = value.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/components/') || seen.includes(ref) || seen.length >= 8)
      throw new Error('仅支持无循环的本地 components 引用');
    const result = ref
      .slice(2)
      .split('/')
      .reduce((o: any, key: string) => {
        const name = key.replace(/~1/g, '/').replace(/~0/g, '~');
        return o && typeof o === 'object' && Object.hasOwn(o, name) ? o[name] : undefined;
      }, doc);
    if (!result) throw new Error('引用不存在');
    const resolved = deref(result, [...seen, ref]);
    const { $ref: _ref, ...siblings } = value;
    return resolved && typeof resolved === 'object' ? { ...resolved, ...siblings } : resolved;
  };
  const operations: z.infer<typeof querySchema>[] = [],
    skipped: { path: string; reason: string }[] = [];
  for (const [path, itemValue] of Object.entries(doc.paths)) {
    try {
      const item = deref(itemValue),
        op = item?.get;
      if (!op) {
        skipped.push({ path, reason: '只有 GET 查询可以导入；写操作使用业务桥接协议' });
        continue;
      }
      if (item.servers || op.servers || op.requestBody)
        throw new Error('不支持操作级服务器覆盖或 GET 请求体');
      const parameters = new Map<string, any>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(p)))
        parameters.set(`${p.in}:${p.name}`, p);
      const inputFields = [...parameters.values()].map((p) => {
        const s = deref(p.schema);
        if (
          !['path', 'query'].includes(p.in) ||
          !['string', 'number', 'integer', 'boolean'].includes(s?.type) ||
          p.content ||
          p.allowReserved ||
          (p.style && p.style !== (p.in === 'path' ? 'simple' : 'form'))
        )
          throw new Error('参数只支持 path/query 基础类型和默认序列化');
        return {
          name: p.name,
          label: p.description?.slice(0, 100) || p.name,
          in: p.in,
          type: s.type === 'integer' ? 'number' : s.type,
          required: p.required === true,
          ...(s.enum && s.type === 'string' ? { enum: s.enum } : {}),
        };
      });
      const response = deref(op.responses?.['200']);
      let schema = deref(response?.content?.['application/json']?.schema),
        rowsPath = '';
      if (schema?.type === 'object') {
        const arrays = Object.entries(schema.properties ?? {}).filter(
          ([name, v]) =>
            deref(v)?.type === 'array' &&
            !deref(v)?.writeOnly &&
            !/password|secret|token|credential|private.?key/i.test(name),
        );
        if (arrays.length === 1) {
          rowsPath = arrays[0]![0];
          schema = deref(arrays[0]![1]);
        }
      }
      if (schema?.writeOnly) throw new Error('响应标记为 writeOnly，不能作为客户查询');
      if (schema?.type === 'array') schema = deref(schema.items);
      if (schema?.writeOnly) throw new Error('记录标记为 writeOnly，不能作为客户查询');
      const columns: { path: string; label: string }[] = [];
      const walk = (s: any, prefix: string, depth: number) => {
        s = deref(s);
        if (depth > 3 || s?.type !== 'object') return;
        for (const [name, value] of Object.entries(s.properties ?? {})) {
          const v = deref(value),
            field = prefix ? `${prefix}.${name}` : name;
          if (v?.writeOnly || /password|secret|token|credential|private.?key/i.test(name)) continue;
          if (['string', 'number', 'integer', 'boolean'].includes(v?.type))
            columns.push({ path: field, label: v.title?.slice(0, 100) || name });
          else if (v?.type === 'object') walk(v, field, depth + 1);
        }
      };
      walk(schema, '', 0);
      const candidate = querySchema.safeParse({
        id: op.operationId,
        title: op.summary || op.operationId,
        description: (op.description ?? '').slice(0, 1000),
        path,
        fields: inputFields,
        rowsPath,
        columns,
        roles: ['user'],
        enabled: false,
      });
      if (!candidate.success) throw new Error('需要合法 operationId、明确的 JSON 200 响应字段及参数定义');
      if (operations.some((q) => q.id === candidate.data.id)) throw new Error('operationId 重复');
      operations.push(candidate.data);
    } catch (e) {
      skipped.push({ path, reason: e instanceof Error ? e.message : '不支持的接口定义' });
    }
  }
  return { operations, skipped };
}
function valueAt(row: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, key) =>
        v && typeof v === 'object' && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined,
      row,
    );
}
export class QueryService {
  constructor(
    private db: Database,
    private policy: OpaPolicy,
    private config: (p: CustomerPrincipal) => QueryConfig | undefined,
  ) {}
  list(p: CustomerPrincipal): BusinessQuery[] {
    return (this.config(p)?.operations ?? [])
      .filter((q) => q.enabled && q.roles.some((r) => p.roles.includes(r)))
      .map(({ id, title, description, fields, columns }) => ({
        id,
        title,
        description,
        fields: fields.map(({ in: _in, ...f }) => f),
        columns,
      }));
  }
  async execute(
    p: CustomerPrincipal,
    queryId: string,
    input: unknown,
    authorization: string,
    requestId: string,
  ): Promise<QueryResult> {
    const config = this.config(p),
      query = config?.operations.find(
        (q) => q.id === queryId && q.enabled && q.roles.some((r) => p.roles.includes(r)),
      );
    if (!config || !query || p.expiresAt <= Date.now()) throw new AppError('QUERY_NOT_ALLOWED', 403);
    const args = validateArguments({ ...query, description: query.description || query.title }, input);
    let path = query.path;
    for (const f of query.fields.filter((f) => f.in === 'path')) {
      const value = String(args[f.name]);
      // Restrict decoded path segments too: encoded traversal/separators are unsafe across reverse proxies.
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new AppError('QUERY_ARGUMENTS_INVALID', 400);
      path = path.replaceAll(`{${f.name}}`, encodeURIComponent(value));
    }
    const url = new URL(config.baseUrl.replace(/\/$/, '') + path);
    for (const f of query.fields.filter((f) => f.in === 'query'))
      if (args[f.name] !== undefined) url.searchParams.set(f.name, String(args[f.name]));
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      tenantId: p.tenantId,
      subject: p.subject,
    };
    const { tool } = await new ToolRegistry(this.db).resolve('business.query');
    const decision = await this.policy.decide({
      principal: { kind: p.kind, scope },
      action: tool,
      resource: { type: 'business', scope, visibility: 'TENANT' },
      context: {
        scopeValid: p.expiresAt > Date.now(),
        capabilityValid: true,
        registered: true,
        environment: 'production',
        phase: 'support',
        userConfirmed: false,
      },
    });
    await audit(this.db, p, {
      requestId,
      action: 'business.query.' + queryId,
      decision: decision.decision,
      reason: decision.reason,
    });
    if (decision.decision !== 'ALLOW')
      throw new AppError(
        decision.reason,
        decision.decision === 'APPROVAL_REQUIRED' ? 409 : decision.reason === 'POLICY_DENIED' ? 403 : 503,
      );
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { authorization, accept: 'application/json', 'x-request-id': requestId },
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 403 || response.status === 404
            ? 'BUSINESS_NOT_ACCESSIBLE'
            : 'BUSINESS_UNAVAILABLE',
          response.status === 403 || response.status === 404 ? 404 : 502,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 256000) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const selected = query.rowsPath ? valueAt(raw, query.rowsPath) : raw;
      if (!selected || typeof selected !== 'object') throw new Error();
      const records = Array.isArray(selected) ? selected : [selected];
      const rows = records.slice(0, 50).map((row) =>
        Object.fromEntries(
          query.columns.map((c) => {
            const value = valueAt(row, c.path);
            return [
              c.path,
              typeof value === 'string'
                ? value.slice(0, 2000)
                : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
                  ? value
                  : null,
            ];
          }),
        ),
      );
      if (containsSecret(JSON.stringify(rows))) throw new Error();
      await audit(this.db, p, {
        requestId,
        action: 'business.query.result',
        decision: 'ALLOW',
        reason: 'PROJECTED_FIELDS_ONLY',
      });
      return {
        queryId,
        columns: query.columns,
        rows,
        truncated: records.length > 50,
        retrievedAt: new Date().toISOString(),
        requestId,
      };
    } catch (e) {
      await audit(this.db, p, {
        requestId,
        action: 'business.query.result',
        decision: 'DENY',
        reason: e instanceof AppError ? e.code : 'BUSINESS_RESPONSE_INVALID',
      });
      if (e instanceof AppError) throw e;
      throw new AppError('BUSINESS_RESPONSE_INVALID', 502);
    }
  }
}
