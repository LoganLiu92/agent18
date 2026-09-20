import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Connection = {
  id: string;
  name: string;
  source_key: string;
  kind: string;
  mode: string;
  version: number;
  job_id: string;
  state: string;
  build_id: string | null;
  error_code: string | null;
};
type Build = {
  id: string;
  name: string;
  revision: string;
  state: string;
  files: number;
  article_count: number;
  truncated: boolean;
  nextOffset: number | null;
  skipped: { path: string; reason: string }[];
  articles: {
    id: string;
    title: string;
    body: string;
    category: string;
    refs: { path: string; startLine: number; endLine: number }[];
  }[];
};
type ConnectionConfig = {
  id: string;
  version: number;
  mode: string;
  source: {
    id: string;
    name: string;
    kind: string;
    location: string;
    ref: string;
    credentialEnv?: string;
    include: string[];
    exclude: string[];
    [key: string]: unknown;
  };
};
const status: Record<string, string> = {
  queued: '等待索引进程',
  running: '正在扫描与构建',
  succeeded: '扫描完成 · 待审阅',
  failed: '扫描失败',
  cancelled: '已取消',
};
const errors: Record<string, string> = {
  SOURCE_ROOT_NOT_ALLOWED: '目录不在索引进程允许的根目录内。',
  SOURCE_HOST_NOT_ALLOWED: 'Git 主机不在索引进程允许的名单中。',
  SOURCE_ACTOR_REVOKED: '任务发起人的管理权限已失效。',
  MODEL_NOT_CONFIGURED: '索引进程尚未配置模型。',
  WORKER_INTERRUPTED: '索引进程中断，请重新扫描。',
  SOURCE_SCAN_FAILED: '来源读取失败，请检查目录、权限或网络。',
  GIT_READ_FAILED: '无法读取 Git 仓库，请检查地址、版本和只读访问权限。',
};
export function SourceCenter({
  request,
  base,
  canConfigure,
  canEdit,
  onDraft,
  onScanChange,
}: {
  request: Request;
  base: string;
  canConfigure: boolean;
  canEdit: boolean;
  onDraft: (id: string) => Promise<void>;
  onScanChange: () => Promise<void>;
}) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [wizard, setWizard] = useState(false),
    [editing, setEditing] = useState<ConnectionConfig>(),
    [offset, setOffset] = useState(0),
    [nextOffset, setNextOffset] = useState<number | null>(null),
    [buildOffset, setBuildOffset] = useState(0),
    [build, setBuild] = useState<Build>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  async function refresh() {
    const value = await request<{ connections: Connection[]; nextOffset: number | null }>(
      base + '/connections?offset=' + offset,
    );
    setConnections(value.connections);
    setNextOffset(value.nextOffset);
  }
  useEffect(() => {
    let active = true,
      seen = '';
    const load = () =>
      void request<{ connections: Connection[]; nextOffset: number | null }>(
        base + '/connections?offset=' + offset,
      )
        .then((r) => {
          if (active) {
            setConnections(r.connections);
            setNextOffset(r.nextOffset);
            setLoaded(true);
            const signature = JSON.stringify(r.connections.map((c) => [c.job_id, c.state]));
            if (seen && signature !== seen)
              void onScanChange().catch((e) => {
                if (active) setError(e.message);
              });
            seen = signature;
          }
        })
        .catch((e) => {
          if (active) {
            setError(e.message);
            setLoaded(true);
          }
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base, offset]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ws-source-center">
      <div className="ws-status-row">
        <div>
          <h2>连接与扫描任务</h2>
          <p className="admin-muted">任务保存在服务端，刷新后继续跟踪。扫描结果先进入内部候选资料。</p>
        </div>
        {canConfigure && (
          <button
            disabled={busy}
            onClick={() => {
              setEditing(undefined);
              setWizard(!wizard);
            }}
          >
            {wizard ? '收起向导' : '＋ 连接知识来源'}
          </button>
        )}
      </div>
      {error && (
        <div className="admin-error" role="alert">
          {error}
        </div>
      )}
      {wizard && (
        <SourceWizard
          key={editing?.id ?? 'new'}
          initial={editing}
          busy={busy}
          onSave={(input) =>
            void act(async () => {
              await request(base + '/connections' + (editing ? '/' + editing.id : ''), input);
              setEditing(undefined);
              setWizard(false);
              await refresh();
            })
          }
        />
      )}
      {!loaded ? (
        <p>正在读取来源任务…</p>
      ) : !connections.length && !wizard ? (
        <div className="admin-card">
          <p>还没有通过后台连接的来源。管理员可以连接 Git 仓库或索引进程可读取的文档目录。</p>
          <p className="admin-muted">已有 CLI 来源继续显示在下方版本列表中。</p>
        </div>
      ) : (
        <div className="admin-grid">
          {connections.map((c) => (
            <section className="admin-card" key={c.id}>
              <div className="ws-status-row">
                <span className="ws-pill">{c.kind === 'git' ? 'Git 仓库' : '资料目录'}</span>
                <span className={'ws-pill ' + (c.state === 'succeeded' ? 'good' : '')}>
                  {status[c.state] ?? c.state}
                </span>
              </div>
              <h2>{c.name}</h2>
              <p className="admin-muted">
                {c.source_key} · {c.mode === 'model' ? '模型整理' : '原文分层'}
              </p>
              {c.error_code && (
                <p role="status">
                  {errors[c.error_code] ?? '本次构建未完成。'} <code>{c.error_code}</code>
                </p>
              )}
              {c.state === 'queued' && (
                <p className="admin-muted">等待部署者启动已配置读取范围的知识索引进程。</p>
              )}
              <div className="ws-actions">
                {canConfigure && !['queued', 'running'].includes(c.state) && (
                  <button
                    className="ws-secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const config = await request<ConnectionConfig>(base + '/connections/' + c.id);
                        setEditing(config);
                        setWizard(true);
                      })
                    }
                  >
                    编辑连接
                  </button>
                )}
                {c.build_id && (
                  <button
                    className="ws-secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setBuildOffset(0);
                        setBuild(await request<Build>(base + '/builds/' + c.build_id));
                      })
                    }
                  >
                    查看扫描结果
                  </button>
                )}
                {canConfigure &&
                  (['queued', 'running'].includes(c.state) ? (
                    <button
                      className="ws-secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await request(base + '/jobs/' + c.job_id + '/cancel', {});
                          await refresh();
                        })
                      }
                    >
                      取消任务
                    </button>
                  ) : (
                    <button
                      className="ws-secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await request(base + '/connections/' + c.id + '/scan', {});
                          await refresh();
                        })
                      }
                    >
                      重新扫描
                    </button>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <div className="ws-actions">
        <button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
          上一页来源
        </button>
        <button disabled={busy || nextOffset === null} onClick={() => setOffset(nextOffset!)}>
          下一页来源
        </button>
      </div>
      {build && (
        <section className="admin-card ws-section">
          <div className="ws-status-row">
            <div>
              <span className="ws-label">SCAN RESULTS · INTERNAL</span>
              <h2>{build.name}</h2>
            </div>
            <button className="ws-secondary" onClick={() => setBuild(undefined)}>
              收起结果
            </button>
          </div>
          <p>
            {build.files ?? 0} 个文件 · {build.article_count ?? 0} 篇候选文档 · 版本{' '}
            <code>{build.revision}</code>
          </p>
          <p className="admin-muted">
            扫描结果尚未发布。选择有用的候选文档转为草稿，核对业务含义与证据，再审核发布。
          </p>
          <div className="ws-scan-results">
            {build.articles.map((a) => (
              <details key={a.id}>
                <summary>{a.title}</summary>
                <div className="ws-prose">{a.body}</div>
                {a.refs.map((r, i) => (
                  <p className="ws-reference" key={i}>
                    {r.path} · L{r.startLine}–{r.endLine}
                  </p>
                ))}
                {canEdit && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await request<{ id: string }>(
                          base + '/articles/' + a.id + '/draft',
                          {},
                        );
                        await onDraft(result.id);
                      })
                    }
                  >
                    转为内部草稿 →
                  </button>
                )}
              </details>
            ))}
          </div>
          <div className="ws-actions">
            <button
              disabled={busy || buildOffset === 0}
              onClick={() =>
                void act(async () => {
                  const offset = Math.max(0, buildOffset - 100);
                  setBuild(await request<Build>(base + '/builds/' + build.id + '?offset=' + offset));
                  setBuildOffset(offset);
                })
              }
            >
              上一页候选
            </button>
            <button
              disabled={busy || build.nextOffset === null}
              onClick={() =>
                void act(async () => {
                  const offset = build.nextOffset!;
                  setBuild(await request<Build>(base + '/builds/' + build.id + '?offset=' + offset));
                  setBuildOffset(offset);
                })
              }
            >
              下一页候选
            </button>
          </div>
          <details>
            <summary>跳过的文件（{build.skipped?.length ?? 0}）</summary>
            {build.skipped?.slice(0, 200).map((s, i) => (
              <p className="ws-reference" key={i}>
                {s.path} · {s.reason}
              </p>
            ))}
          </details>
        </section>
      )}
    </section>
  );
}
function SourceWizard({
  busy,
  onSave,
  initial,
}: {
  busy: boolean;
  onSave: (value: unknown) => void;
  initial?: ConnectionConfig;
}) {
  const [step, setStep] = useState(0),
    [name, setName] = useState(initial?.source.name ?? ''),
    [id, setId] = useState(initial?.source.id ?? ''),
    [kind, setKind] = useState(initial?.source.kind ?? 'directory'),
    [location, setLocation] = useState(initial?.source.location ?? ''),
    [ref, setRef] = useState(initial?.source.ref ?? 'HEAD'),
    [credentialEnv, setCredentialEnv] = useState(initial?.source.credentialEnv ?? ''),
    [include, setInclude] = useState(initial?.source.include.join('\n') ?? '**/*.md\n**/*.ts\n**/*.tsx'),
    [exclude, setExclude] = useState(initial?.source.exclude.join('\n') ?? ''),
    [mode, setMode] = useState(initial?.mode ?? 'extractive');
  const patterns = (text: string) =>
    text
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  return (
    <form
      className="admin-card ws-guide"
      onSubmit={(e) => {
        e.preventDefault();
        if (step < 2) {
          setStep(step + 1);
          return;
        }
        onSave({
          ...(initial ? { version: initial.version } : {}),
          source: {
            ...initial?.source,
            id,
            name,
            kind,
            location,
            ref,
            credentialEnv: kind === 'git' && credentialEnv ? credentialEnv : undefined,
            include: patterns(include),
            exclude: patterns(exclude),
            audience: 'internal',
            tenantIds: [],
          },
          mode,
        });
      }}
    >
      <div className="ws-wizard-steps">
        {['连接来源', '范围与生成', '确认并扫描'].map((s, i) => (
          <span className={step === i ? 'active' : ''} key={s}>
            0{i + 1} {s}
          </span>
        ))}
      </div>
      {step === 0 && (
        <>
          <h2>{initial ? '编辑来源 · 保存后重新扫描' : '先连接一份可追溯的资料'}</h2>
          <div className="admin-form-grid">
            <label>
              来源名称
              <input
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：订单服务代码"
              />
            </label>
            <label>
              来源标识
              <input
                required
                pattern="[a-z][a-z0-9-]{1,63}"
                maxLength={64}
                disabled={!!initial}
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="orders-source"
              />
            </label>
          </div>
          <label>
            来源类型
            <select disabled={!!initial} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="directory">文档 / 本地代码目录</option>
              <option value="git">Git 仓库（HTTPS）</option>
            </select>
          </label>
          <label>
            {kind === 'git' ? '仓库地址' : '索引进程上的绝对目录'}
            <input
              required
              maxLength={1000}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={
                kind === 'git' ? 'https://github.com/your-org/product.git' : '/srv/knowledge/product'
              }
            />
          </label>
          {kind === 'git' && (
            <label>
              分支、标签或 Commit
              <input required value={ref} maxLength={200} onChange={(e) => setRef(e.target.value)} />
              <small>私有仓库凭据需先由部署管理员绑定到此仓库 URL。</small>
              <input
                aria-label="Git 凭据引用（可选）"
                placeholder="AGENT18_GIT_REPOSITORY"
                value={credentialEnv}
                onChange={(e) => setCredentialEnv(e.target.value)}
              />
            </label>
          )}
          <p className="admin-muted">
            不在此填写密钥。部署者在独立索引进程配置只读访问、允许目录和 Git 主机。地址不能包含用户名、密码或
            Token。
          </p>
        </>
      )}
      {step === 1 && (
        <>
          <h2>限定扫描范围与生成方式</h2>
          <div className="admin-form-grid">
            <label>
              包含文件（每行一个 glob）
              <textarea
                required
                rows={5}
                value={include}
                maxLength={3000}
                onChange={(e) => setInclude(e.target.value)}
              />
            </label>
            <label>
              排除文件（每行一个 glob）
              <textarea
                rows={5}
                value={exclude}
                maxLength={3000}
                onChange={(e) => setExclude(e.target.value)}
                placeholder="**/fixtures/**"
              />
            </label>
          </div>
          <label>
            生成方式
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="extractive">原文分层 · 不调用模型</option>
              <option value="model">模型整理 · 最多 100 次调用</option>
            </select>
          </label>
          <p className="admin-muted">
            默认最多扫描 2,000 个文件、20 MB
            文本；密钥、隐藏目录和构建依赖由扫描器过滤。结果始终先作为内部候选。
          </p>
          {mode === 'model' && (
            <p className="admin-notice">
              所选范围内的文本片段将发送给部署者配置的模型服务，并可能产生调用费用。请先确认资料允许出站。
            </p>
          )}
        </>
      )}
      {step === 2 && (
        <>
          <h2>确认后创建持久化扫描任务</h2>
          <dl className="ws-source-summary">
            <dt>来源</dt>
            <dd>
              {name} · {id}
            </dd>
            <dt>位置</dt>
            <dd>{location}</dd>
            <dt>版本</dt>
            <dd>{kind === 'git' ? ref : '扫描时固定文件内容'}</dd>
            <dt>包含</dt>
            <dd>{include}</dd>
            <dt>排除</dt>
            <dd>{exclude || '扫描器默认排除规则'}</dd>
            <dt>生成</dt>
            <dd>{mode === 'model' ? '模型整理（最多 100 次调用）' : '原文分层'}</dd>
            <dt>受众</dt>
            <dd>内部 · 须审核发布</dd>
          </dl>
          <p className="admin-muted">
            保存后由独立索引进程领取。未启动进程时任务保持排队；不会把排队显示为已连接成功。
          </p>
        </>
      )}
      <div className="ws-actions">
        {step > 0 && (
          <button type="button" disabled={busy} className="ws-secondary" onClick={() => setStep(step - 1)}>
            上一步
          </button>
        )}
        <button disabled={busy}>{busy ? '保存中…' : step === 2 ? '保存并排队扫描' : '下一步 →'}</button>
      </div>
    </form>
  );
}
