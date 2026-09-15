import { createHash, randomUUID } from 'node:crypto';
import {
  evidenceViewSchema,
  evidenceSchema,
  type ReportCase,
  type Scope,
  type CaseDetail,
} from '@agent18/contracts';
import { AppError } from '@agent18/domain';
import { audit, caseView, scoped, scopeValues, requireTenant, type Database } from '@agent18/persistence';
import type { ToolGateway } from './gateway.js';
import { RunService } from './runs.js';
import { enqueueObservation } from './observations.js';
import type { OperationsConfig } from '@agent18/observability/config';
// Server-owned workflow selection; customer context never chooses tools or broadens capabilities.
export type CaseWorkflow = { toolId: string; input: (input: ReportCase) => unknown };
const supportWorkflow: CaseWorkflow = {
  toolId: 'knowledge.search',
  input: (report) => ({ query: report.title, limit: 5 }),
};

export class CaseService {
  readonly runs: RunService;
  constructor(
    private readonly db: Database,
    private readonly gateway: ToolGateway,
    private readonly workflow: CaseWorkflow = supportWorkflow,
    private readonly operationsFor?: (scope: Scope) => OperationsConfig | undefined,
  ) {
    this.runs = new RunService(db, gateway);
  }
  async report(scope: Scope, input: ReportCase, key: string, requestId: string) {
    // Parsed, canonical fields only. A reused key with changed content is a conflict, never an overwrite.
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return scoped(this.db, scope, async (client) => {
      await requireTenant(client);
      const caseId = randomUUID();
      const inserted = await client.query(
        'INSERT INTO core.cases (id,organization_id,project_id,tenant_id,subject,title,description,context,idempotency_key,request_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (organization_id,project_id,tenant_id,subject,idempotency_key) DO NOTHING RETURNING *',
        [caseId, ...scopeValues(scope), input.title, input.description, input.context, key, hash],
      );
      if (!inserted.rowCount) {
        const previous = (await client.query('SELECT * FROM core.cases WHERE idempotency_key=$1', [key]))
          .rows[0];
        if (!previous || previous.request_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return { case: caseView(previous), replayed: true };
      }
      const { tool, binding, fingerprint } = await this.gateway.registry.resolve(this.workflow.toolId);
      if (input.capture)
        await client.query(
          'INSERT INTO core.case_captures(case_id,organization_id,project_id,tenant_id,subject,payload) VALUES($1,$2,$3,$4,$5,$6)',
          [caseId, ...scopeValues(scope), input.capture],
        );
      const operations = this.operationsFor?.(scope);
      if (operations) await enqueueObservation(client, scope, operations, 'case', 'case:' + caseId, caseId);
      if (!binding || tool.effect !== 'READ' || tool.stage !== 'READ')
        throw new AppError('RUN_REQUIRES_READ_TOOL', 403);
      const parameters = binding.inputSchema.safeParse(this.workflow.input(input));
      if (!parameters.success) throw new AppError('TOOL_INPUT_INVALID', 400);
      const runId = randomUUID();
      await client.query(
        "INSERT INTO core.runs (id,case_id,organization_id,project_id,tenant_id,subject,capability_id,tool_id,tool_version,capability_expires_at,provider_id,capability,input,registry_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour',$10,$11,$12,$13)",
        [
          runId,
          caseId,
          ...scopeValues(scope),
          randomUUID(),
          tool.id,
          tool.version,
          tool.provider,
          tool.capability,
          parameters.data,
          fingerprint,
        ],
      );
      await client.query(
        'INSERT INTO control.dispatch (id,run_id,organization_id,project_id,tenant_id,subject) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), runId, ...scopeValues(scope)],
      );
      await client.query(
        "INSERT INTO core.audit (id,organization_id,project_id,tenant_id,subject,case_id,request_id,action,decision,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,'case.report','ALLOW','CASE_AND_OUTBOX_COMMITTED')",
        [randomUUID(), ...scopeValues(scope), caseId, requestId],
      );
      return { case: caseView(inserted.rows[0]), replayed: false };
    });
  }
  async list(scope: Scope) {
    return scoped(this.db, scope, async (client) =>
      (await client.query('SELECT * FROM core.cases ORDER BY created_at DESC LIMIT 100')).rows.map(caseView),
    );
  }
  async detail(scope: Scope, caseId: string): Promise<CaseDetail> {
    const result = await scoped(this.db, scope, async (client) => {
      const row = (await client.query('SELECT * FROM core.cases WHERE id=$1', [caseId])).rows[0];
      if (!row) return null;
      const runs = await this.runs.views(client, caseId);
      const evidence = (
        await client.query('SELECT payload FROM core.evidence WHERE case_id=$1 ORDER BY created_at', [caseId])
      ).rows;
      const records = (
        await client.query(
          'SELECT id,action,decision,reason,created_at FROM core.audit WHERE case_id=$1 ORDER BY created_at DESC LIMIT 50',
          [caseId],
        )
      ).rows;
      const capture = (
        await client.query('SELECT payload FROM core.case_captures WHERE case_id=$1', [caseId])
      ).rows[0]?.payload;
      const investigation = (
        await client.query(
          "SELECT j.state,j.updated_at,r.payload->>'summary' AS summary FROM control.observation_jobs j LEFT JOIN core.observation_reports r ON r.job_id=j.id WHERE j.case_id=$1 AND j.organization_id=$2 AND j.project_id=$3 AND j.tenant_id=$4 AND j.subject=$5 ORDER BY j.created_at DESC LIMIT 1",
          [caseId, ...scopeValues(scope)],
        )
      ).rows[0];
      return {
        case: caseView(row),
        ...(capture ? { capture } : {}),
        ...(investigation
          ? {
              investigation: {
                state: investigation.state,
                summary: investigation.summary ?? '排查任务已登记，处理进展将在这里更新。',
                updatedAt: investigation.updated_at.toISOString(),
              },
            }
          : {}),
        runs,
        evidence: evidence.map((e) => evidenceSchema.parse(e.payload)),
        audit: records.map((r) => ({
          id: r.id,
          action: r.action,
          decision: r.decision,
          reason: r.reason,
          createdAt: r.created_at.toISOString(),
        })),
      };
    });
    if (!result) {
      await audit(this.db, scope, {
        requestId: randomUUID(),
        action: 'case.read',
        decision: 'DENY',
        reason: 'RESOURCE_NOT_FOUND_IN_SCOPE',
      });
      throw new AppError('NOT_FOUND', 404);
    }
    const visible = await this.gateway.visibleEvidence(scope, result.evidence);
    return {
      ...result,
      evidence: visible.map((e) => {
        const { scope: _scope, artifactRef: _artifact, ...view } = e;
        return evidenceViewSchema.parse(view);
      }),
    };
  }
  async execute(scope: Scope, runId: string, requestId: string) {
    return this.runs.execute(scope, runId, requestId);
  }
}
