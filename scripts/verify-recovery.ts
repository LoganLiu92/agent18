import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT, importJWK } from 'jose';
import pg from 'pg';
import { readConfig, localDirectory } from './config.js';
import { buildApp } from '../apps/server/src/app.js';
import { Agent18 } from '@agent18/web-sdk';

// Intentionally interrupts only this project's local Server/Worker. Never point this script at a shared environment.
const config = readConfig();
const migration = JSON.parse(await readFile(resolve(localDirectory, 'migration.json'), 'utf8'));
const db = new pg.Pool({ connectionString: migration.adminDatabaseUrl });
const exec = promisify(execFile);
const compose = (...args: string[]) =>
  exec('docker', [
    'compose',
    '--env-file',
    '.local/compose.env',
    '-f',
    'deploy/compose/compose.yaml',
    ...args,
  ]);
const identity = JSON.parse(await readFile(resolve(localDirectory, 'identity.json'), 'utf8'));
const token = await new SignJWT({
  kind: 'customer',
  tenant_id: 'tenant-a',
  project_key: 'invoice-demo',
  roles: [],
})
  .setSubject(`recovery-${crypto.randomUUID()}`)
  .setProtectedHeader({ alg: 'EdDSA', kid: identity.publicJwk.kid })
  .setIssuer('urn:agent18:demo-saas')
  .setAudience('agent18:support')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(await importJWK(identity.privateJwk, 'EdDSA'));
const sdk = new Agent18({
  baseUrl: 'http://127.0.0.1:4318',
  projectKey: 'invoice-demo',
  getToken: async () => token,
});
const body = {
  title: '发票提交失败 · 重启恢复验收',
  description: 'Synthetic recovery fixture. Persist before dispatch, then restart.',
};
const key = crypto.randomUUID();
try {
  await compose('stop', 'worker', 'server');
  const writer = await buildApp(config, { dispatch: false });
  let caseId: string;
  try {
    const result = await writer.app.inject({
      method: 'POST',
      url: '/api/cases',
      headers: { authorization: `Bearer ${token}`, 'x-project-key': 'invoice-demo', 'idempotency-key': key },
      payload: { ...body, context: {} },
    });
    assert.equal(result.statusCode, 201);
    caseId = result.json().case.id;
  } finally {
    await writer.app.close();
  }
  const dispatch = (
    await db.query(
      'SELECT d.* FROM control.dispatch d JOIN core.runs r ON r.id=d.run_id WHERE r.case_id=$1',
      [caseId],
    )
  ).rows[0];
  assert.equal(dispatch.delivered_at, null);
  console.log('PASS: Case + Run + undelivered outbox survived the API process closing.');
  await compose('up', '-d', '--no-deps', '--wait', 'server', 'worker');
  let detail = await sdk.getCase(caseId);
  const deadline = Date.now() + 20000;
  while (detail.runs[0]?.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    detail = await sdk.getCase(caseId);
  }
  assert.equal(detail.runs[0]?.state, 'completed');
  assert.ok(detail.evidence.length > 0);
  assert.equal((await sdk.reportCase(body, key)).case.id, caseId);
  console.log('PASS: restarted Server dispatched the outbox; restarted Worker completed the original Run.');
  const post = async (path: string, payload: unknown, lease?: string) => {
    const result = await fetch(`http://127.0.0.1:4318${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.workerToken}`,
        ...(lease ? { 'x-run-lease': lease } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 200);
    return result.json();
  };
  const claim = await post('/internal/jobs/claim', { dispatchId: dispatch.id, jobId: dispatch.id });
  await post(`/internal/runs/${claim.runId}/execute`, {}, claim.lease);
  const after = await sdk.getCase(caseId);
  assert.equal(after.runs.length, 1);
  assert.equal(after.evidence.length, detail.evidence.length);
  assert.equal(after.audit.length, detail.audit.length);
  console.log('PASS: duplicate execution of a completed Run created no extra evidence or audit entries.');
} finally {
  sdk.destroy();
  await db.end();
  await compose('up', '-d', '--no-deps', '--wait', 'server', 'worker');
}
