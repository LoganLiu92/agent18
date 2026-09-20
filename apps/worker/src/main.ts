import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PgBoss } from 'pg-boss';
import { localDirectory } from '../../../scripts/config.js';

const config = z
  .object({ queueDatabaseUrl: z.string(), serverUrl: z.string().url(), workerToken: z.string().min(32) })
  .parse(
    JSON.parse(
      await readFile(process.env.AGENT18_WORKER_CONFIG ?? resolve(localDirectory, 'worker.json'), 'utf8'),
    ),
  );
const boss = new PgBoss({ connectionString: config.queueDatabaseUrl, schema: 'pgboss', migrate: false });
boss.on('error', () => console.error('agent18 worker queue error'));
const post = async (path: string, body: unknown, lease?: string) => {
  const response = await fetch(`${config.serverUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.workerToken}`,
      ...(lease ? { 'x-run-lease': lease } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(path.endsWith('/tick') ? 60000 : 20_000),
  });
  if (!response.ok) throw new Error(`Core request status ${response.status}`);
  return response.json();
};
await boss.start();
await boss.work<{ dispatchId: string }>(
  'support-investigation',
  { pollingIntervalSeconds: 1, batchSize: 1 },
  async (jobs) => {
    for (const job of jobs) {
      const { dispatchId } = z.object({ dispatchId: z.string().uuid() }).strict().parse(job.data);
      const result = z
        .object({ runId: z.string().uuid(), lease: z.string() })
        .parse(await post('/internal/jobs/claim', { dispatchId, jobId: job.id }));
      await post(`/internal/runs/${result.runId}/execute`, {}, result.lease);
      console.log(JSON.stringify({ event: 'run_processed', runId: result.runId }));
    }
  },
);
console.log('agent18 worker ready; queue IDs only, no business database access');
let observing = false;
const observe = async () => {
  if (observing) return;
  observing = true;
  try {
    const results = await Promise.allSettled(
      ['/internal/observations/tick', '/internal/reports/tick', '/internal/ticket-sync/tick'].map((path) =>
        post(path, {}),
      ),
    );
    if (results.some((result) => result.status === 'rejected'))
      console.error('agent18 scheduled tick failed; durable jobs retained');
  } catch {
    console.error('agent18 observation tick failed; durable jobs retained');
  } finally {
    observing = false;
  }
};
const observationTimer = setInterval(() => void observe(), 10000);
void observe();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    clearInterval(observationTimer);
    void boss.stop({ graceful: true }).then(() => process.exit(0));
  });
