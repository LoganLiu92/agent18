import { createHash, randomUUID } from 'node:crypto';
import type { ReportCase, Scope, CaseDetail } from '@agent18/contracts';
import { AppError } from '@agent18/domain';
import { audit, caseView, scoped, scopeValues, requireTenant, type Database } from '@agent18/persistence';
import type { ToolGateway } from './gateway.js';
import { RunService } from './runs.js';

export class CaseService {
  readonly runs: RunService;
  constructor(
    private readonly db: Database,
    private readonly gateway: ToolGateway,
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
      const runId = randomUUID();
      await client.query(
        "INSERT INTO core.runs (id,case_id,organization_id,project_id,tenant_id,subject,capability_id,tool_id,tool_version,capability_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'knowledge.search',1,now()+interval '1 hour')",
        [runId, caseId, ...scopeValues(scope), randomUUID()],
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
        await client.query('SELECT citation FROM core.evidence WHERE case_id=$1 ORDER BY created_at', [
          caseId,
        ])
      ).rows;
      const records = (
        await client.query(
          'SELECT id,action,decision,reason,created_at FROM core.audit WHERE case_id=$1 ORDER BY created_at DESC LIMIT 50',
          [caseId],
        )
      ).rows;
      return {
        case: caseView(row),
        runs,
        evidence: evidence.map((e) => e.citation),
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
    result.evidence = await this.gateway.visible(scope, result.evidence);
    return result;
  }
  async execute(scope: Scope, runId: string, requestId: string) {
    return this.runs.execute(scope, runId, requestId);
  }
}
