import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '@agent18/domain';
import type { Database } from '@agent18/persistence';
import type { Config } from '../../../../scripts/config.js';
import { permissionRoles, type OperatorPermission } from './permissions.js';

export const operatorRoles = [
  'viewer',
  'support',
  'engineer',
  'knowledge_editor',
  'knowledge_publisher',
] as const;
export type OperatorRole = (typeof operatorRoles)[number];
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.@-]{2,79}$/);
export const passwordSchema = z.string().min(15).max(128);
export const accountInput = z
  .object({
    username: usernameSchema,
    displayName: z.string().trim().min(1).max(100),
    password: passwordSchema,
  })
  .strict();
export type OperatorAccount = {
  id: string;
  username: string;
  displayName: string;
  administrator: boolean;
  enabled: boolean;
  mustChangePassword: boolean;
};
export type OperatorSession = { account: OperatorAccount; tokenHash: string; csrf: string };
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const params = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
let activeHashes = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (activeHashes >= 2) throw new AppError('OPERATOR_TRY_LATER', 429);
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(password, salt, 64, params, (error, key) => (error ? reject(error) : resolve(key))),
    );
  } finally {
    activeHashes--;
  }
}
export async function hashPassword(password: string) {
  passwordSchema.parse(password);
  const salt = randomBytes(24).toString('hex');
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function checkPassword(password: string, encoded?: string) {
  // Unknown usernames still perform the same password work; no account existence is returned.
  const valid = encoded?.match(/^scrypt-v1\$([a-f0-9]{48})\$([a-f0-9]{128})$/);
  const key = await derive(password, valid?.[1] ?? '0'.repeat(48));
  return timingSafeEqual(key, Buffer.from(valid?.[2] ?? '0'.repeat(128), 'hex')) && !!valid;
}
const view = (row: Record<string, any>): OperatorAccount => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  administrator: row.administrator,
  enabled: row.enabled,
  mustChangePassword: row.must_change_password,
});
async function transaction<T>(db: Database, fn: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function audit(
  client: PoolClient,
  actor: string | null,
  action: string,
  target: string | null,
  requestId: string,
) {
  await client.query(
    'INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), actor, action, target, requestId],
  );
}
export class OperatorService {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
  ) {}
  async initialized() {
    return !!(await this.db.query('SELECT 1 FROM control.operator_accounts LIMIT 1')).rowCount;
  }
  async bootstrap(raw: unknown, requestId: string) {
    const input = accountInput.parse(raw),
      password = await hashPassword(input.password);
    return transaction(this.db, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(181819)');
      if ((await client.query('SELECT 1 FROM control.operator_accounts LIMIT 1')).rowCount)
        throw new AppError('OPERATOR_ALREADY_INITIALIZED', 409);
      const id = randomUUID();
      await client.query(
        'INSERT INTO control.operator_accounts(id,username,display_name,password_hash,administrator) VALUES($1,$2,$3,$4,true)',
        [id, input.username, input.displayName, password],
      );
      await audit(client, id, 'operator.bootstrap', id, requestId);
      return { id, username: input.username };
    });
  }
  // Exposed only by the loopback Owner maintenance service, never by /operator.
  async recoverAdministrator(raw: unknown, requestId: string) {
    const input = z
      .object({
        username: usernameSchema,
        confirmUsername: usernameSchema,
        password: passwordSchema,
      })
      .strict()
      .parse(raw);
    if (input.username !== input.confirmUsername) throw new AppError('OPERATOR_RECOVERY_CONFIRMATION', 400);
    const password = await hashPassword(input.password);
    return transaction(this.db, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(181819)');
      const row = (
        await client.query(
          `UPDATE control.operator_accounts SET password_hash=$2,enabled=true,must_change_password=true,updated_at=now()
        WHERE username=$1 AND administrator RETURNING id,username`,
          [input.username, password],
        )
      ).rows[0];
      if (!row) throw new AppError('OPERATOR_ADMIN_NOT_FOUND', 404);
      await client.query('DELETE FROM control.operator_sessions WHERE operator_id=$1', [row.id]);
      await client.query('DELETE FROM control.operator_login_limits WHERE key=$1', [
        digest('name:' + input.username),
      ]);
      await audit(client, null, 'operator.local_recovery', row.id, requestId);
      return { username: row.username, loginRequired: true, mustChangePassword: true };
    });
  }
  async login(raw: unknown, ip: string, requestId: string) {
    const input = z
      .object({ username: usernameSchema, password: z.string().min(1).max(128) })
      .strict()
      .parse(raw);
    // Persist rate limits; account and address counters survive restarts and don't store raw addresses.
    await this.db.query(
      "DELETE FROM control.operator_login_limits WHERE started_at < now()-interval '15 minutes'",
    );
    for (const [key, limit] of [
      [digest('name:' + input.username), 10],
      [digest('ip:' + ip), 50],
    ] as const) {
      const row = (
        await this.db.query(
          `INSERT INTO control.operator_login_limits(key,count) VALUES($1,1)
        ON CONFLICT(key) DO UPDATE SET count=operator_login_limits.count+1 RETURNING count`,
          [key],
        )
      ).rows[0];
      if (row.count > limit) throw new AppError('OPERATOR_TRY_LATER', 429);
    }
    const row = (
      await this.db.query('SELECT * FROM control.operator_accounts WHERE username=$1', [input.username])
    ).rows[0];
    const valid = await checkPassword(input.password, row?.password_hash);
    if (!valid || !row?.enabled) throw new AppError('OPERATOR_LOGIN_FAILED', 401);
    const token = randomBytes(32).toString('hex');
    await transaction(this.db, async (client) => {
      const current = (
        await client.query('SELECT * FROM control.operator_accounts WHERE id=$1 FOR UPDATE', [row.id])
      ).rows[0];
      if (!current.enabled || current.password_hash !== row.password_hash)
        throw new AppError('OPERATOR_LOGIN_FAILED', 401);
      await client.query(
        "DELETE FROM control.operator_sessions WHERE expires_at<=now() OR last_seen_at<now()-interval '30 minutes'",
      );
      await client.query(
        "INSERT INTO control.operator_sessions(token_hash,operator_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
        [digest(token), row.id],
      );
      await audit(client, row.id, 'operator.login', row.id, requestId);
    });
    return token;
  }
  async session(token: string): Promise<OperatorSession> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError('OPERATOR_LOGIN_REQUIRED', 401);
    const tokenHash = digest(token);
    const row = (
      await this.db.query(
        `UPDATE control.operator_sessions s SET last_seen_at=now()
      FROM control.operator_accounts a WHERE s.token_hash=$1 AND a.id=s.operator_id AND a.enabled
      AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' RETURNING a.*`,
        [tokenHash],
      )
    ).rows[0];
    if (!row) throw new AppError('OPERATOR_LOGIN_REQUIRED', 401);
    return { account: view(row), tokenHash, csrf: digest('csrf:' + token) };
  }
  async logout(session: OperatorSession, requestId: string) {
    await transaction(this.db, async (client) => {
      await client.query('DELETE FROM control.operator_sessions WHERE token_hash=$1', [session.tokenHash]);
      await audit(client, session.account.id, 'operator.logout', session.account.id, requestId);
    });
  }
  async projects(session: OperatorSession) {
    if (session.account.mustChangePassword) return [];
    const rows = (
      await this.db.query('SELECT * FROM control.operator_memberships WHERE operator_id=$1', [
        session.account.id,
      ])
    ).rows;
    return this.config.projects.flatMap((p) => {
      const member = rows.find((r) => r.organization_id === p.organizationId && r.project_id === p.projectId);
      return session.account.administrator || member
        ? [
            {
              key: p.key,
              name: p.displayName ?? p.key,
              roles: session.account.administrator ? [...operatorRoles] : (member.roles as OperatorRole[]),
            },
          ]
        : [];
    });
  }
  async authorize(session: OperatorSession, projectKey: string, role: OperatorRole = 'viewer') {
    return this.withGrant(
      session,
      projectKey,
      role === 'viewer' ? [...operatorRoles] : [role],
      async (_client, project) => project,
    );
  }
  async withPermission<T>(
    session: OperatorSession,
    projectKey: string,
    permission: OperatorPermission,
    operation: (client: PoolClient, project: Config['projects'][number]) => Promise<T>,
  ) {
    return this.withGrant(session, projectKey, permissionRoles[permission], operation);
  }
  private async withGrant<T>(
    session: OperatorSession,
    projectKey: string,
    roles: readonly OperatorRole[],
    operation: (client: PoolClient, project: Config['projects'][number]) => Promise<T>,
  ) {
    const project = this.config.projects.find((p) => p.key === projectKey);
    if (!project) throw new AppError('OPERATOR_FORBIDDEN', 403);
    return transaction(this.db, async (client) => {
      // Keep permission mutations serialized with the protected database operation.
      // Callbacks must do short database work, never external I/O or model calls.
      await client.query('SELECT pg_advisory_xact_lock(181819)');
      const actor = (
        await client.query(
          `SELECT a.administrator,m.roles FROM control.operator_accounts a
        JOIN control.operator_sessions s ON s.operator_id=a.id
        LEFT JOIN control.operator_memberships m ON m.operator_id=a.id AND m.organization_id=$3 AND m.project_id=$4
        WHERE a.id=$1 AND s.token_hash=$2 AND a.enabled AND NOT a.must_change_password
        AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'`,
          [session.account.id, session.tokenHash, project.organizationId, project.projectId],
        )
      ).rows[0];
      if (!actor || (!actor.administrator && !roles.some((role) => actor.roles?.includes(role))))
        throw new AppError('OPERATOR_FORBIDDEN', 403);
      return operation(client, project);
    });
  }
  private admin(session: OperatorSession) {
    if (!session.account.administrator || session.account.mustChangePassword)
      throw new AppError('OPERATOR_FORBIDDEN', 403);
  }
  private async lockAdministrator(client: PoolClient, session: OperatorSession) {
    // Serialize permission/password mutations, then recheck the actor after potentially slow hashing.
    await client.query('SELECT pg_advisory_xact_lock(181819)');
    const row = (
      await client.query(
        `SELECT a.id FROM control.operator_accounts a
      JOIN control.operator_sessions s ON s.operator_id=a.id
      WHERE a.id=$1 AND a.enabled AND a.administrator AND NOT a.must_change_password
      AND s.token_hash=$2 AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'
      FOR UPDATE OF a`,
        [session.account.id, session.tokenHash],
      )
    ).rows[0];
    if (!row) throw new AppError('OPERATOR_FORBIDDEN', 403);
  }
  async accounts(session: OperatorSession, raw: unknown = {}) {
    this.admin(session);
    const input = z
      .object({
        search: z.string().trim().max(100).default(''),
        status: z.enum(['all', 'enabled', 'disabled']).default('all'),
        after: usernameSchema.optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict()
      .parse(raw);
    return transaction(this.db, async (client) => {
      await this.lockAdministrator(client, session);
      const users = (
        await client.query(
          `SELECT * FROM control.operator_accounts
        WHERE (strpos(lower(username),lower($1))>0 OR strpos(lower(display_name),lower($1))>0)
        AND ($2='all' OR enabled=($2='enabled')) AND ($3::text IS NULL OR username>$3)
        ORDER BY username LIMIT $4`,
          [input.search, input.status, input.after ?? null, input.limit + 1],
        )
      ).rows;
      const page = users.slice(0, input.limit);
      const memberships = (
        await client.query('SELECT * FROM control.operator_memberships WHERE operator_id=ANY($1::uuid[])', [
          page.map((r) => r.id),
        ])
      ).rows;
      return {
        accounts: page.map((r) => ({
          ...view(r),
          memberships: memberships
            .filter((m) => m.operator_id === r.id)
            .flatMap((m) => {
              const p = this.config.projects.find(
                (p) => p.projectId === m.project_id && p.organizationId === m.organization_id,
              );
              return p ? [{ projectKey: p.key, roles: m.roles }] : [];
            }),
        })),
        nextCursor: users.length > input.limit ? page.at(-1)!.username : null,
      };
    });
  }
  async auditLog(session: OperatorSession, raw: unknown = {}) {
    this.admin(session);
    const input = z
      .object({
        action: z
          .string()
          .regex(/^operator\.[a-z_.]+$/)
          .max(80)
          .optional(),
        targetId: z.string().uuid().optional(),
        before: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict()
      .parse(raw);
    return transaction(this.db, async (client) => {
      await this.lockAdministrator(client, session);
      const rows = (
        await client.query(
          `SELECT e.id,e.action,e.actor_id AS "actorId",e.target_id AS "targetId",
        e.request_id AS "requestId",e.created_at AS "createdAt",a.username AS "actorUsername",t.username AS "targetUsername"
        FROM control.operator_audit e LEFT JOIN control.operator_accounts a ON a.id=e.actor_id
        LEFT JOIN control.operator_accounts t ON t.id::text=e.target_id
        WHERE ($1::text IS NULL OR e.action=$1) AND ($2::text IS NULL OR e.target_id=$2)
        AND ($3::uuid IS NULL OR (e.created_at,e.id)<(SELECT created_at,id FROM control.operator_audit WHERE id=$3))
        ORDER BY e.created_at DESC,e.id DESC LIMIT $4`,
          [input.action ?? null, input.targetId ?? null, input.before ?? null, input.limit + 1],
        )
      ).rows;
      return {
        events: rows.slice(0, input.limit),
        nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      };
    });
  }
  async create(session: OperatorSession, raw: unknown, requestId: string) {
    this.admin(session);
    const input = accountInput.parse(raw),
      password = await hashPassword(input.password);
    return transaction(this.db, async (client) => {
      await this.lockAdministrator(client, session);
      const id = randomUUID();
      const row = (
        await client.query(
          `INSERT INTO control.operator_accounts(id,username,display_name,password_hash,must_change_password)
        VALUES($1,$2,$3,$4,true) ON CONFLICT(username) DO NOTHING RETURNING id`,
          [id, input.username, input.displayName, password],
        )
      ).rows[0];
      if (!row) throw new AppError('OPERATOR_USERNAME_UNAVAILABLE', 409);
      await audit(client, session.account.id, 'operator.create', id, requestId);
      return { id };
    });
  }
  async update(session: OperatorSession, id: string, raw: unknown, requestId: string) {
    this.admin(session);
    const input = z
      .object({
        enabled: z.boolean(),
        administrator: z.boolean(),
        memberships: z
          .array(
            z
              .object({ projectKey: z.string(), roles: z.array(z.enum(operatorRoles)).min(1).max(5) })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .parse(raw);
    if (new Set(input.memberships.map((m) => m.projectKey)).size !== input.memberships.length)
      throw new AppError('INVALID_REQUEST', 400);
    const members = input.memberships.map((m) => {
      const project = this.config.projects.find((p) => p.key === m.projectKey);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 404);
      return { ...project, roles: m.roles };
    });
    await transaction(this.db, async (client) => {
      await this.lockAdministrator(client, session);
      const current = (
        await client.query('SELECT * FROM control.operator_accounts WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!current) throw new AppError('NOT_FOUND', 404);
      if (current.enabled && current.administrator && (!input.enabled || !input.administrator)) {
        if (
          Number(
            (
              await client.query(
                'SELECT count(*) FROM control.operator_accounts WHERE enabled AND administrator',
              )
            ).rows[0].count,
          ) <= 1
        )
          throw new AppError('OPERATOR_LAST_ADMIN', 409);
      }
      await client.query(
        'UPDATE control.operator_accounts SET enabled=$2,administrator=$3,updated_at=now() WHERE id=$1',
        [id, input.enabled, input.administrator],
      );
      await client.query('DELETE FROM control.operator_tenant_grants WHERE operator_id=$1', [id]);
      await client.query('DELETE FROM control.operator_memberships WHERE operator_id=$1', [id]);
      for (const m of members)
        await client.query(
          'INSERT INTO control.operator_memberships(operator_id,organization_id,project_id,roles) VALUES($1,$2,$3,$4)',
          [id, m.organizationId, m.projectId, m.roles],
        );
      // A permissions change invalidates existing sessions immediately.
      await client.query('DELETE FROM control.operator_sessions WHERE operator_id=$1', [id]);
      await audit(client, session.account.id, 'operator.permissions', id, requestId);
    });
    return { updated: true };
  }
  async password(session: OperatorSession, raw: unknown, requestId: string) {
    const input = z
      .object({ currentPassword: z.string().min(1).max(128), password: passwordSchema })
      .strict()
      .parse(raw);
    const row = (
      await this.db.query('SELECT password_hash FROM control.operator_accounts WHERE id=$1', [
        session.account.id,
      ])
    ).rows[0];
    if (!(await checkPassword(input.currentPassword, row?.password_hash)))
      throw new AppError('OPERATOR_PASSWORD_INVALID', 403);
    const next = await hashPassword(input.password);
    await transaction(this.db, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(181819)');
      if (
        !(
          await client.query(
            `SELECT 1 FROM control.operator_sessions WHERE token_hash=$1 AND operator_id=$2
        AND expires_at>now() AND last_seen_at>now()-interval '30 minutes'`,
            [session.tokenHash, session.account.id],
          )
        ).rowCount
      )
        throw new AppError('OPERATOR_LOGIN_REQUIRED', 401);
      const changed = await client.query(
        'UPDATE control.operator_accounts SET password_hash=$2,must_change_password=false,updated_at=now() WHERE id=$1 AND password_hash=$3 AND enabled',
        [session.account.id, next, row.password_hash],
      );
      if (!changed.rowCount) throw new AppError('OPERATOR_LOGIN_REQUIRED', 401);
      await client.query('DELETE FROM control.operator_sessions WHERE operator_id=$1', [session.account.id]);
      await audit(client, session.account.id, 'operator.password', session.account.id, requestId);
    });
    return { loginRequired: true };
  }
  async reset(session: OperatorSession, id: string, raw: unknown, requestId: string) {
    this.admin(session);
    const input = z.object({ password: passwordSchema }).strict().parse(raw);
    const password = await hashPassword(input.password);
    await transaction(this.db, async (client) => {
      await this.lockAdministrator(client, session);
      const result = await client.query(
        'UPDATE control.operator_accounts SET password_hash=$2,must_change_password=true,updated_at=now() WHERE id=$1',
        [id, password],
      );
      if (!result.rowCount) throw new AppError('NOT_FOUND', 404);
      await client.query('DELETE FROM control.operator_sessions WHERE operator_id=$1', [id]);
      await audit(client, session.account.id, 'operator.password.reset', id, requestId);
    });
    return { updated: true };
  }
}
