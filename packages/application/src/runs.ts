import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { RunView, Scope } from '@agent18/contracts';
import { AppError, type CustomerPrincipal } from '@agent18/domain';
import {
  audit,
  auditInTransaction,
  scoped,
  scopeValues,
  requireTenant,
  type Database,
} from '@agent18/persistence';
import type { ToolGateway } from './gateway.js';

export const terminalStates = new Set(['completed', 'blocked', 'cancelled', 'failed']);
export const MAX_RUNS_PER_CASE = 3;

export class RunService {
  private readonly active = new Map<string, AbortController>();
  constructor(
    private readonly db: Database,
    private readonly gateway: ToolGateway,
  ) {}

  private async step(
    client: PoolClient,
    scope: Scope,
    run: QueryResultRow,
    state: string,
    reason: string,
    name = 'execution',
    durationMs: number | null = null,
    policyDecision: 'ALLOW' | 'DENY' | 'APPROVAL_REQUIRED' | null = null,
  ) {
    await client.query(
      'INSERT INTO core.run_steps (id,run_id,case_id,organization_id,project_id,tenant_id,subject,attempt,name,state,reason,duration_ms,capability,tool_id,provider_id,input_ref,output_ref,policy_decision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      [
        randomUUID(),
        run.id,
        run.case_id,
        ...scopeValues(scope),
        run.attempt_count,
        name,
        state,
        reason,
        durationMs,
        name === 'execution' ? 'runtime.execute' : run.capability,
        name === 'execution' ? null : run.tool_id,
        name === 'execution' ? null : run.provider_id,
        name === 'execution' ? null : `run-input:${run.id}`,
        name !== 'execution' && state === 'succeeded' ? `run-evidence:${run.id}` : null,
        policyDecision,
      ],
    );
  }
  private async finish(
    client: PoolClient,
    scope: Scope,
    run: QueryResultRow,
    state: string,
    reason: string,
    requestId: string,
    durationMs: number | null = null,
  ) {
    await client.query('UPDATE core.runs SET state=$2,outcome=$3,completed_at=now() WHERE id=$1', [
      run.id,
      state,
      reason,
    ]);
    await client.query(
      "UPDATE core.cases SET status='needs_human',updated_at=now() WHERE id=$1 AND status<>'resolved'",
      [run.case_id],
    );
    await this.step(
      client,
      scope,
      run,
      state === 'completed' ? 'succeeded' : state === 'cancelled' ? 'cancelled' : 'failed',
      reason,
      'execution',
      durationMs,
    );
    await auditInTransaction(client, scope, {
      caseId: run.case_id,
      requestId,
      action: 'run.finish',
      decision: state === 'completed' || state === 'cancelled' ? 'ALLOW' : 'DENY',
      reason,
    });
  }
  async views(client: PoolClient, caseId: string): Promise<RunView[]> {
    const runs = (
      await client.query('SELECT * FROM core.runs WHERE case_id=$1 ORDER BY created_at,id', [caseId])
    ).rows;
    // PostgreSQL now() is shared by a transaction; preserve workflow order for tied timestamps.
    const steps = (
      await client.query('SELECT * FROM core.run_steps WHERE case_id=$1 ORDER BY sequence', [caseId])
    ).rows;
    const hasActive = runs.some((run) => !terminalStates.has(run.state));
    return runs.map((run) => ({
      id: run.id,
      state: run.state,
      outcome: run.outcome,
      createdAt: run.created_at.toISOString(),
      completedAt: run.completed_at?.toISOString() ?? null,
      attemptCount: run.attempt_count,
      maxAttempts: run.max_attempts,
      executionBudgetMs: run.execution_budget_ms,
      expiresAt: run.capability_expires_at.toISOString(),
      retryOf: run.retry_of,
      canCancel: !terminalStates.has(run.state),
      canRetry:
        ['failed', 'cancelled'].includes(run.state) &&
        !hasActive &&
        runs.length < MAX_RUNS_PER_CASE &&
        !runs.some((child) => child.retry_of === run.id),
      steps: steps
        .filter((step) => step.run_id === run.id)
        .map((step) => ({
          id: step.id,
          attempt: step.attempt,
          name: step.name,
          capability: step.capability,
          toolId: step.tool_id,
          providerId: step.provider_id,
          inputRef: step.input_ref,
          outputRef: step.output_ref,
          policyDecision: step.policy_decision,
          state: step.state,
          reason: step.reason,
          durationMs: step.duration_ms,
          createdAt: step.created_at.toISOString(),
        })),
    }));
  }
  async cancel(scope: Scope, runId: string, requestId: string) {
    const result = await this.controlled(scope, runId, 'run.cancel', requestId, async (client) => {
      const run = (await client.query('SELECT * FROM core.runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
      if (!run) throw new AppError('NOT_FOUND', 404);
      if (run.state === 'cancelled') return { runId, state: 'cancelled', replayed: true };
      if (terminalStates.has(run.state)) throw new AppError('RUN_ALREADY_TERMINAL', 409);
      await client.query(
        'UPDATE core.runs SET scope_revision=scope_revision+1,capability_expires_at=now() WHERE id=$1',
        [runId],
      );
      await this.finish(client, scope, run, 'cancelled', 'CANCELLED_BY_CUSTOMER', requestId);
      return { runId, state: 'cancelled', replayed: false };
    });
    this.active.get(runId)?.abort(new AppError('RUN_CANCELLED', 409));
    return result;
  }
  async retry(scope: Scope, runId: string, key: string, requestId: string) {
    return this.controlled(scope, runId, 'run.retry', requestId, async (client) => {
      const parent = (await client.query('SELECT * FROM core.runs WHERE id=$1', [runId])).rows[0];
      if (!parent) throw new AppError('NOT_FOUND', 404);
      if (!['failed', 'cancelled'].includes(parent.state)) throw new AppError('RUN_NOT_RETRYABLE', 409);
      // Serialize all retry branches for the same Case. The partial unique index is a second guard.
      await client.query('SELECT id FROM core.cases WHERE id=$1 FOR UPDATE', [parent.case_id]);
      const prior = (
        await client.query('SELECT * FROM core.runs WHERE retry_key=$1 OR retry_of=$2', [key, runId])
      ).rows;
      if (prior.some((run) => run.retry_key === key && run.retry_of !== runId))
        throw new AppError('IDEMPOTENCY_CONFLICT', 409);
      const child = prior.find((run) => run.retry_of === runId);
      if (child) return { runId: child.id, replayed: true };
      const current = (await client.query('SELECT * FROM core.runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
      if (!['failed', 'cancelled'].includes(current.state)) throw new AppError('RUN_NOT_RETRYABLE', 409);
      const all = (await client.query('SELECT state FROM core.runs WHERE case_id=$1', [parent.case_id])).rows;
      if (all.some((run) => !terminalStates.has(run.state))) throw new AppError('CASE_HAS_ACTIVE_RUN', 409);
      if (all.length >= MAX_RUNS_PER_CASE) throw new AppError('CASE_RUN_BUDGET_EXHAUSTED', 409);
      const next = randomUUID();
      await client.query(
        "INSERT INTO core.runs (id,case_id,organization_id,project_id,tenant_id,subject,capability_id,tool_id,tool_version,capability_expires_at,retry_of,retry_key,provider_id,capability,input,registry_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$10,$11,now()+interval '1 hour',$8,$9,$12,$13,$14,$15)",
        [
          next,
          parent.case_id,
          ...scopeValues(scope),
          randomUUID(),
          runId,
          key,
          parent.tool_id,
          parent.tool_version,
          parent.provider_id,
          parent.capability,
          parent.input,
          parent.registry_hash,
        ],
      );
      await client.query(
        'INSERT INTO control.dispatch (id,run_id,organization_id,project_id,tenant_id,subject) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), next, ...scopeValues(scope)],
      );
      await client.query(
        "UPDATE core.cases SET status='open',updated_at=now() WHERE id=$1 AND status<>'resolved'",
        [parent.case_id],
      );
      await auditInTransaction(client, scope, {
        caseId: parent.case_id,
        requestId,
        action: 'run.retry',
        decision: 'ALLOW',
        reason: 'RETRY_RUN_CREATED',
      });
      return { runId: next, replayed: false };
    });
  }
  private async controlled<T>(
    scope: Scope,
    _runId: string,
    action: string,
    requestId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await scoped(this.db, scope, async (client) => {
        await requireTenant(client);
        return operation(client);
      });
    } catch (error) {
      await audit(this.db, scope, {
        requestId,
        action,
        decision: 'DENY',
        reason: error instanceof AppError ? error.code : 'CONTROL_TRANSACTION_FAILED',
      });
      if (error instanceof AppError) throw error;
      throw new AppError('CONTROL_TRANSACTION_FAILED', 503);
    }
  }
  private async exclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const lock = await this.db.connect();
    let held = false;
    try {
      held = (await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,18)) AS held', [runId]))
        .rows[0].held;
      if (!held) throw new AppError('RUN_BUSY', 409);
      return await operation();
    } finally {
      try {
        if (held) await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,18))', [runId]);
      } finally {
        lock.release();
      }
    }
  }
  async execute(scope: Scope, runId: string, requestId: string) {
    return this.exclusive(runId, async () => {
      const controller = new AbortController();
      this.active.set(runId, controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const run = await scoped(this.db, scope, async (client) => {
          await requireTenant(client);
          const row = (
            await client.query(
              'SELECT r.*,c.title FROM core.runs r JOIN core.cases c ON c.id=r.case_id WHERE r.id=$1 FOR UPDATE OF r',
              [runId],
            )
          ).rows[0];
          if (!row) throw new AppError('NOT_FOUND', 404);
          if (terminalStates.has(row.state)) return row;
          if (row.capability_expires_at.getTime() <= Date.now()) {
            await this.finish(client, scope, row, 'blocked', 'CAPABILITY_EXPIRED', requestId);
            return { ...row, state: 'blocked' };
          }
          if (row.attempt_count >= row.max_attempts) {
            await this.finish(client, scope, row, 'failed', 'ATTEMPT_BUDGET_EXHAUSTED', requestId);
            return { ...row, state: 'failed' };
          }
          if (row.state === 'running')
            await this.step(client, scope, row, 'interrupted', 'PREVIOUS_EXECUTION_INTERRUPTED');
          const next = (
            await client.query(
              "UPDATE core.runs SET state='running',attempt_count=attempt_count+1,last_started_at=now(),outcome=NULL WHERE id=$1 RETURNING *",
              [runId],
            )
          ).rows[0];
          await this.step(client, scope, next, 'started', 'ATTEMPT_STARTED');
          await this.step(client, scope, next, 'started', 'TOOL_INVOCATION_STARTED', next.capability);
          return { ...next, title: row.title };
        });
        if (terminalStates.has(run.state)) return { state: run.state };
        const started = Date.now();
        timer = setTimeout(
          () => controller.abort(new AppError('STEP_TIMEOUT', 503)),
          run.execution_budget_ms,
        );
        const principal: CustomerPrincipal = {
          ...scope,
          kind: 'customer',
          roles: [],
          expiresAt: run.capability_expires_at.getTime(),
        };
        try {
          const result = await this.gateway.invoke(
            principal,
            run.tool_id,
            run.input,
            requestId,
            {
              id: run.capability_id,
              toolId: run.tool_id,
              toolVersion: run.tool_version,
              registryHash: run.registry_hash,
              expiresAt: principal.expiresAt,
              scope,
              caseId: run.case_id,
              revision: run.scope_revision,
            },
            controller.signal,
          );
          return await scoped(this.db, scope, async (client) => {
            const current = (await client.query('SELECT * FROM core.runs WHERE id=$1 FOR UPDATE', [runId]))
              .rows[0];
            // Cancellation and completion race at this row lock. Never publish late results after a committed cancel.
            if (terminalStates.has(current.state)) return { state: current.state };
            if (
              current.scope_revision !== run.scope_revision ||
              current.capability_expires_at.getTime() <= Date.now()
            ) {
              await this.finish(client, scope, current, 'blocked', 'CAPABILITY_EXPIRED', requestId);
              return { state: 'blocked' };
            }
            if (controller.signal.aborted) throw controller.signal.reason;
            await this.step(
              client,
              scope,
              current,
              'succeeded',
              result.length ? 'EVIDENCE_VALIDATED' : 'NO_MATCHING_SOURCE',
              current.capability,
              Date.now() - started,
              'ALLOW',
            );
            for (const evidence of result)
              await client.query(
                'INSERT INTO core.evidence (id,run_id,case_id,organization_id,project_id,tenant_id,subject,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                [evidence.id, runId, run.case_id, ...scopeValues(scope), evidence],
              );
            await this.finish(
              client,
              scope,
              current,
              'completed',
              result.length ? 'EVIDENCE_COLLECTED_NEEDS_HUMAN' : 'NO_SOURCE_NEEDS_HUMAN',
              requestId,
              Date.now() - started,
            );
            return { state: 'completed' };
          });
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'INTERNAL_EXECUTION_ERROR';
          const transient = !(error instanceof AppError) || error.status >= 503;
          const outcome = await scoped(this.db, scope, async (client) => {
            const current = (await client.query('SELECT * FROM core.runs WHERE id=$1 FOR UPDATE', [runId]))
              .rows[0];
            if (terminalStates.has(current.state)) return { state: current.state };
            await this.step(
              client,
              scope,
              current,
              'failed',
              code,
              current.capability,
              Date.now() - started,
              error instanceof AppError ? (error.policyDecision ?? null) : null,
            );
            if (transient && current.attempt_count < current.max_attempts) {
              await client.query("UPDATE core.runs SET state='pending',outcome=$2 WHERE id=$1", [
                runId,
                code,
              ]);
              await this.step(client, scope, current, 'failed', code, 'execution', Date.now() - started);
              await auditInTransaction(client, scope, {
                caseId: current.case_id,
                requestId,
                action: 'run.retry_scheduled',
                decision: 'ALLOW',
                reason: code,
              });
              return { state: 'pending' };
            }
            const state = transient ? 'failed' : 'blocked';
            await this.finish(
              client,
              scope,
              current,
              state,
              transient ? 'ATTEMPT_BUDGET_EXHAUSTED' : code,
              requestId,
              Date.now() - started,
            );
            return { state };
          });
          if (outcome.state === 'pending') throw new AppError(code, 503);
          return outcome;
        }
      } finally {
        if (timer) clearTimeout(timer);
        this.active.delete(runId);
      }
    });
  }
  async reconcile(scope: Scope, runId: string, queueFailure: string | null): Promise<boolean> {
    try {
      return await this.exclusive(runId, () =>
        scoped(this.db, scope, async (client) => {
          const run = (await client.query('SELECT * FROM core.runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
          if (!run || terminalStates.has(run.state)) return true;
          const expired = run.capability_expires_at.getTime() <= Date.now();
          if (!queueFailure && !expired) return false;
          await this.finish(
            client,
            scope,
            run,
            expired ? 'blocked' : 'failed',
            expired ? 'CAPABILITY_EXPIRED' : queueFailure!,
            randomUUID(),
          );
          return true;
        }),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'RUN_BUSY') return false;
      throw error;
    }
  }
}
