import { useEffect, useState } from 'react';
export function GitCredentials({ request }: { request: <T>(path: string, body?: unknown) => Promise<T> }) {
  const [bindings, setBindings] = useState<Record<string, string>>({}),
    [name, setName] = useState('AGENT18_GIT_REPOSITORY'),
    [repository, setRepository] = useState(''),
    [username, setUsername] = useState('oauth2'),
    [token, setToken] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    request<{ bindings: Record<string, string> }>('knowledge/git-credentials')
      .then((r) => {
        if (active) setBindings(r.bindings);
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [request]);
  return (
    <section className="ops-card">
      <h2>私有代码库只读凭据</h2>
      <p>
        将只读令牌绑定到一个精确的 HTTPS 仓库地址。在知识来源向导中填写引用名称即可。令牌只进入知识
        Worker，不进入模型或 Git 地址。
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void request('knowledge/git-credentials', { name, repository, username, token })
            .then(async () => {
              setToken('');
              setBindings(
                (await request<{ bindings: Record<string, string> }>('knowledge/git-credentials')).bindings,
              );
              setMessage('凭据已保存。应用配置重启知识 Worker 后生效。');
            })
            .catch((e) => setMessage(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          引用名称
          <input
            required
            pattern="AGENT18_GIT_[A-Z0-9_]+"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          完整仓库地址
          <input
            type="url"
            required
            placeholder="https://git.example.com/team/product.git"
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
          />
        </label>
        <label>
          Git 用户名
          <input required value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          只读令牌
          <input
            type="password"
            autoComplete="off"
            required
            minLength={16}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <button disabled={busy}>保存 / 轮换凭据</button>
      </form>
      {Object.entries(bindings).map(([k, v]) => (
        <p key={k}>
          {k} → {v}{' '}
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void request('knowledge/git-credentials/revoke', { name: k })
                .then(async () => {
                  setBindings(
                    (await request<{ bindings: Record<string, string> }>('knowledge/git-credentials'))
                      .bindings,
                  );
                  setMessage(
                    '凭据引用已撤销。重启知识 Worker 后生效；如需立即阻断访问，请同时在代码托管平台撤销令牌。',
                  );
                })
                .catch((e) => setMessage(e.message))
                .finally(() => setBusy(false));
            }}
          >
            撤销引用
          </button>
        </p>
      ))}
      <p role="status">{message}</p>
    </section>
  );
}
