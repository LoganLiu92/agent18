import { useEffect, useState } from 'react';

export function OperatorBootstrap({ token, coreUrl }: { token: string; coreUrl: string }) {
  const [initialized, setInitialized] = useState<boolean>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [username, setUsername] = useState(''),
    [displayName, setDisplayName] = useState(''),
    [password, setPassword] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/owner/operators', {
      headers: { authorization: 'Bearer ' + token },
      signal: controller.signal,
    })
      .then(async (r) => {
        const result = await r.json();
        if (!r.ok) throw new Error('无法读取后台账号状态，请先执行数据库迁移。');
        setInitialized(result.initialized);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [token]);
  return (
    <section className="setup-card" aria-label="独立后台账号">
      <h2>Agent18 后台账号</h2>
      <p>管理员和工作人员使用 Agent18 自己的账号。网站客户继续使用原网站登录。</p>
      {error && <p role="alert">{error}</p>}
      {initialized === undefined && !error && <p>正在读取账号状态…</p>}
      {initialized && (
        <>
          <p>
            管理员已创建。
            <a href={coreUrl.replace(/\/$/, '') + '/admin'} target="_blank" rel="noreferrer">
              打开后台登录 →
            </a>
          </p>
          <OperatorRecovery token={token} />
        </>
      )}
      {initialized === false && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void fetch('/owner/operators/bootstrap', {
              method: 'POST',
              headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
              body: JSON.stringify({ username, displayName, password }),
            })
              .then(async (r) => {
                const data = await r.json();
                if (!r.ok) throw new Error(data.error?.code ?? '创建失败');
                setPassword('');
                setInitialized(true);
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            管理员用户名
            <input
              required
              minLength={3}
              maxLength={80}
              pattern="[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            显示名称
            <input
              required
              maxLength={100}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label>
            登录密码（至少 15 个字符）
            <input
              type="password"
              required
              minLength={15}
              maxLength={128}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="experience-primary" disabled={busy}>
            {busy ? '正在创建…' : '创建首位管理员'}
          </button>
          <p>此入口仅用于首次创建。之后由管理员在后台管理工作人员与项目权限。</p>
        </form>
      )}
    </section>
  );
}

function OperatorRecovery({ token }: { token: string }) {
  const [username, setUsername] = useState(''),
    [confirmUsername, setConfirmUsername] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  return (
    <details>
      <summary>忘记管理员密码？从本机恢复</summary>
      <p>
        仅恢复已有管理员账号：重新启用账号、设置临时密码并退出其所有会话。恢复操作记入审计，首次登录必须再次修改密码。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          setMessage('');
          if (username.trim().toLowerCase() !== confirmUsername.trim().toLowerCase()) {
            setError('两次用户名不一致。');
            return;
          }
          setBusy(true);
          void fetch('/owner/operators/recover', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify({ username, confirmUsername, password }),
          })
            .then(async (r) => {
              const result = await r.json();
              if (!r.ok)
                throw new Error(
                  result.error?.code === 'OPERATOR_ADMIN_NOT_FOUND'
                    ? '未找到此管理员，不能通过恢复将普通工作人员升级为管理员。'
                    : '恢复失败，请检查输入与服务状态。',
                );
              setPassword('');
              setConfirmUsername('');
              setMessage('管理员已恢复，请打开后台，用临时密码登录并设置新密码。');
            })
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          要恢复的管理员用户名
          <input
            required
            minLength={3}
            maxLength={80}
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          再次输入管理员用户名
          <input required value={confirmUsername} onChange={(e) => setConfirmUsername(e.target.value)} />
        </label>
        <label>
          恢复用临时密码（至少 15 个字符）
          <input
            type="password"
            required
            minLength={15}
            maxLength={128}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button disabled={busy}>{busy ? '正在恢复…' : '恢复管理员并退出旧会话'}</button>
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
