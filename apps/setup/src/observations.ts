import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Pool } from '@agent18/persistence';
import { enqueueObservation } from '@agent18/application';
import { operationsConfigSchema } from '@agent18/observability/config';
import { KnowledgeError } from '@agent18/knowledge';
import { id } from '@agent18/contracts';
import { configSchema } from '../../../scripts/config.js';
import { atomicJson } from '../../../scripts/lib/atomic.js';

export function registerObservations(
  app: FastifyInstance,
  directory: string,
  mutate: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  const json = async (file: string) => JSON.parse(await readFile(resolve(directory, file), 'utf8'));
  const project = async (raw: unknown) => {
    const key = z.object({ projectKey: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) }).parse(raw).projectKey;
    const p = configSchema.parse(await json('server.json')).projects.find((p) => p.key === key);
    if (!p) throw new KnowledgeError('PROJECT_NOT_FOUND');
    return p;
  };
  const withDb = async <T>(fn: (db: InstanceType<typeof Pool>) => Promise<T>) => {
    const db = new Pool({
      connectionString: (await json('migration.json')).adminDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    try {
      return await fn(db);
    } finally {
      await db.end();
    }
  };
  app.get('/owner/projects/:projectKey/observations', async (request) => {
    const p = await project(request.params),
      env = parseEnv(await readFile(resolve(directory, 'observability.env'), 'utf8').catch(() => ''));
    return withDb(async (db) => ({
      config: p.operations ?? operationsConfigSchema.parse({}),
      credentials: Object.keys(env)
        .filter((k) => /^AGENT18_OBS_/.test(k))
        .map((name) => ({ name, configured: !!env[name] })),
      jobs: (
        await db.query(
          'SELECT id,case_id,kind,state,attempts,reason,created_at,updated_at FROM control.observation_jobs WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50',
          [p.organizationId, p.projectId],
        )
      ).rows,
      incidents: (
        await db.query(
          'SELECT * FROM control.observation_incidents WHERE organization_id=$1 AND project_id=$2 ORDER BY updated_at DESC LIMIT 100',
          [p.organizationId, p.projectId],
        )
      ).rows,
    }));
  });
  app.post('/owner/projects/:projectKey/observations/config', async (request) =>
    mutate(async () => {
      const p = await project(request.params),
        input = operationsConfigSchema.parse(request.body);
      for (const file of ['server.json', 'server.docker.json']) {
        const c = configSchema.parse(await json(file));
        c.projects.find((v) => v.key === p.key)!.operations = input;
        await atomicJson(resolve(directory, file), c);
      }
      await withDb((db) =>
        db.query('INSERT INTO control.security_events(id,request_id,reason) VALUES($1,$2,$3)', [
          randomUUID(),
          request.id,
          'OBSERVABILITY_CONFIG_SAVED',
        ]),
      );
      return { saved: true, restartRequired: true };
    }),
  );
  app.post('/owner/observations/credentials', async (request) =>
    mutate(async () => {
      const input = z
        .object({
          name: z.string().regex(/^AGENT18_OBS_[A-Z0-9_]{1,64}$/),
          value: z
            .string()
            .min(1)
            .max(4000)
            .regex(/^[A-Za-z0-9._~+\/=-]+$/),
        })
        .strict()
        .parse(request.body);
      const env = parseEnv(await readFile(resolve(directory, 'observability.env'), 'utf8').catch(() => ''));
      if (Object.keys(env).length >= 20 && !(input.name in env)) throw new KnowledgeError('CREDENTIAL_LIMIT');
      env[input.name] = input.value;
      await writeFile(
        resolve(directory, 'observability.env'),
        Object.entries(env)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join('\n') + '\n',
        { mode: 0o600 },
      );
      return { saved: true, restartRequired: true };
    }),
  );
  app.post('/owner/projects/:projectKey/observations/run', async (request) => {
    const p = await project(request.params);
    z.object({}).strict().parse(request.body);
    if (!p.operations?.enabled || !p.operations.checks.length)
      throw new KnowledgeError('OBSERVABILITY_NOT_CONFIGURED');
    const key = id.parse(request.headers['idempotency-key']);
    return withDb(async (db) => {
      const client = await db.connect();
      try {
        return {
          jobId: await enqueueObservation(
            client,
            { ...p, tenantId: '__operations__', subject: '__owner__' },
            p.operations!,
            'inspection',
            'manual:' + key,
          ),
        };
      } finally {
        client.release();
      }
    });
  });
  app.get('/owner/projects/:projectKey/observations/:jobId', async (request) => {
    const p = await project(request.params),
      jobId = z.object({ jobId: id }).parse(request.params).jobId;
    return withDb(async (db) => {
      const row = (
        await db.query(
          'SELECT j.*,r.payload AS report FROM control.observation_jobs j LEFT JOIN core.observation_reports r ON r.job_id=j.id WHERE j.id=$1 AND j.organization_id=$2 AND j.project_id=$3',
          [jobId, p.organizationId, p.projectId],
        )
      ).rows[0];
      if (!row) throw new KnowledgeError('OBSERVATION_NOT_FOUND');
      return row;
    });
  });
  app.post('/owner/projects/:projectKey/incidents/:incidentId/acknowledge', async (request) => {
    const p = await project(request.params),
      incidentId = z.object({ incidentId: id }).parse(request.params).incidentId;
    z.object({}).strict().parse(request.body);
    return withDb(async (db) => {
      const row = await db.query(
        "UPDATE control.observation_incidents SET state='acknowledged',updated_at=now() WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND state='open' RETURNING id",
        [incidentId, p.organizationId, p.projectId],
      );
      return { acknowledged: !!row.rowCount };
    });
  });
  app.get('/owner/projects/:projectKey/cases/:caseId/capture', async (request) => {
    const p = await project(request.params),
      caseId = z.object({ caseId: id }).parse(request.params).caseId;
    return withDb(async (db) => ({
      context:
        (
          await db.query(
            'SELECT context FROM core.cases WHERE id=$1 AND organization_id=$2 AND project_id=$3',
            [caseId, p.organizationId, p.projectId],
          )
        ).rows[0]?.context ?? null,
      capture:
        (
          await db.query(
            'SELECT payload FROM core.case_captures WHERE case_id=$1 AND organization_id=$2 AND project_id=$3',
            [caseId, p.organizationId, p.projectId],
          )
        ).rows[0]?.payload ?? null,
    }));
  });
  app.post('/owner/projects/:projectKey/observations/:jobId/knowledge-draft', async (request) => {
    const p = await project(request.params),
      jobId = z.object({ jobId: id }).parse(request.params).jobId;
    z.object({}).strict().parse(request.body);
    const report = await withDb(
      async (db) =>
        (
          await db.query(
            'SELECT r.payload FROM core.observation_reports r WHERE job_id=$1 AND organization_id=$2 AND project_id=$3',
            [jobId, p.organizationId, p.projectId],
          )
        ).rows[0]?.payload,
    );
    if (!report) throw new KnowledgeError('OBSERVATION_NOT_FOUND');
    const folder = resolve(directory, 'incident-knowledge', p.key);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const target = resolve(folder, jobId + '.md');
    const body = `# 排查经验草稿 ${jobId}\n\n受众：internal。此文尚未审核，不应直接发布给客户。\n\n${report.summary}\n\n## 待核实的分析\n\n${report.analysis.hypotheses.map((h: { text: string; evidenceIds: string[] }) => '- ' + h.text + '（证据 ' + h.evidenceIds.join(', ') + ')').join('\n')}\n\n## 建议步骤\n\n${report.analysis.nextSteps.map((s: string) => '- ' + s).join('\n')}\n\n生成时间：${report.completedAt}\n`;
    await writeFile(target, body, { mode: 0o600 });
    return { saved: true, path: target, audience: 'internal', published: false };
  });
}
