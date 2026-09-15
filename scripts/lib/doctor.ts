import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { Pool } from '@agent18/persistence';
import { configSchema } from '../config.js';
import { OpaPolicy } from '@agent18/policy';
export type Check = {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
};
export type DoctorReport = {
  checkedAt: string;
  ready: boolean;
  checks: Check[];
  projects: { key: string; queries: number; actions: number; origins: number; knowledge: string }[];
};
export async function diagnose(directory: string): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, title: string, status: Check['status'], detail: string, fix?: string) =>
    checks.push({ id, title, status, detail, ...(fix ? { fix } : {}) });
  const config = configSchema.parse(JSON.parse(await readFile(resolve(directory, 'server.json'), 'utf8')));
  const db = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 3000,
  });
  try {
    const roles = (
      await db.query('SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    ).rows[0];
    add(
      'database',
      '运行数据库权限',
      roles && !roles.rolsuper && !roles.rolbypassrls && roles.rolname === 'agent18_app' ? 'pass' : 'fail',
      '应用连接必须使用 agent18_app，禁止超级用户或绕过 RLS。',
      'pnpm db:migrate；检查 server.json 的数据库账户',
    );
    const tables = (
      await db.query(
        "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core' AND c.relkind='r' AND relname IN ('cases','case_messages','action_proposals','audit')",
      )
    ).rows;
    add(
      'rls',
      '租户与用户隔离',
      tables.length === 4 && tables.every((t) => t.relrowsecurity && t.relforcerowsecurity) ? 'pass' : 'fail',
      `${tables.filter((t) => t.relrowsecurity && t.relforcerowsecurity).length}/4 个关键数据表强制启用 RLS。`,
      'pnpm db:migrate',
    );
  } catch {
    add(
      'database',
      '运行数据库连接',
      'fail',
      '无法连接或读取数据库角色。',
      '启动 PostgreSQL，检查本机连接配置与端口',
    );
  } finally {
    await db.end();
  }
  const migration = JSON.parse(await readFile(resolve(directory, 'migration.json'), 'utf8'));
  const admin = new Pool({
    connectionString: migration.adminDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 3000,
  });
  try {
    const applied = (await admin.query('SELECT name,checksum FROM public.agent18_migrations')).rows;
    const files = (await readdir('packages/persistence/migrations')).filter((f) => f.endsWith('.sql'));
    let valid = applied.length === files.length;
    for (const f of files) {
      const checksum = createHash('sha256')
        .update(await readFile(resolve('packages/persistence/migrations', f)))
        .digest('hex');
      if (!applied.some((m) => m.name === f && m.checksum === checksum)) valid = false;
    }
    add(
      'migrations',
      '数据库版本',
      valid ? 'pass' : 'fail',
      `${applied.length} 项已应用迁移；检查版本与校验和。`,
      '先备份，再运行 pnpm db:migrate；不要修改已应用的迁移',
    );
    const pending =
      (
        await admin.query(
          "SELECT count(*)::int AS total FROM control.dispatch WHERE settled_at IS NULL AND created_at < now()-interval '5 minutes'",
        )
      ).rows[0]?.total ?? 0;
    add(
      'queue',
      '后台任务积压',
      pending ? 'warn' : 'pass',
      pending ? `${pending} 个调度已超过 5 分钟；需要检查 worker。` : '没有超过 5 分钟的未完成调度。',
      'pnpm logs；pnpm test:recovery（仅演示环境）',
    );
  } catch {
    add(
      'migrations',
      '版本与调度检查',
      'fail',
      '无法核验迁移或队列。',
      'pnpm db:migrate；检查 migration.json',
    );
  } finally {
    await admin.end();
  }
  try {
    const r = await fetch(config.consoleOrigin + '/health/ready', {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    add(
      'core',
      '客户服务',
      r.ok ? 'pass' : 'fail',
      r.ok ? 'Core readiness 成功。' : 'Core 尚未就绪。',
      '检查服务日志、反向代理和 Core 地址',
    );
  } catch {
    add('core', '客户服务', 'fail', '配置的 Core 地址不可达。', '启动 server；在设置中核对公开地址');
  }
  const policy = await new OpaPolicy(config.opaUrl).decide({} as never);
  add(
    'policy',
    '策略引擎',
    policy.reason === 'POLICY_DENIED' ? 'pass' : 'fail',
    policy.reason === 'POLICY_DENIED' ? 'OPA 已加载默认拒绝策略。' : 'OPA 不可用或策略未加载。',
    '启动 OPA 并挂载仓库内策略',
  );
  const env = parseEnv(await readFile(resolve(directory, 'model.env'), 'utf8').catch(() => ''));
  add(
    'model',
    '大模型配置',
    env.AGENT18_MODEL_API_KEY ? 'pass' : 'warn',
    env.AGENT18_MODEL_API_KEY
      ? '已保存模型配置；连通性请使用模型测试按钮验证。'
      : '当前使用原文索引与检索；连接模型后可生成归纳回答。',
  );
  add(
    'installation',
    '初始化状态',
    config.setupCompleted ? 'pass' : 'warn',
    config.setupCompleted ? '初始化设置已完成。' : '初始化向导尚未完成。',
  );
  const demos = config.projects.filter((p) => p.issuer === 'urn:agent18:demo-saas');
  add(
    'identity',
    '真实 SaaS 身份',
    demos.length ? 'warn' : 'pass',
    demos.length
      ? '配置仍包含演示身份项目；公开部署前移除演示项目并停用演示签发服务。'
      : '所有项目均配置了独立签发者。',
  );
  return {
    checkedAt: new Date().toISOString(),
    ready: !checks.some((c) => c.status === 'fail'),
    checks,
    projects: config.projects.map((p) => ({
      key: p.key,
      queries: p.businessQueries?.operations.filter((q) => q.enabled).length ?? 0,
      actions: p.businessBridge?.actions.filter((a) => a.enabled).length ?? 0,
      origins: p.allowedOrigins.length,
      knowledge: p.knowledge,
    })),
  };
}
