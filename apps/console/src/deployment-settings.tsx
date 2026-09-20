import { useEffect, useState } from 'react';
export function DeploymentFeedSettings({
  projectKey,
  request,
}: {
  projectKey: string;
  request: <T>(path: string, body?: unknown) => Promise<T>;
}) {
  type Feed = {
    pipeline: string;
    credentialEnv: string;
    bindings: { service: string; environment: string; sourceId: string }[];
  };
  const [feed, setFeed] = useState<Feed>({
      pipeline: 'release-main',
      credentialEnv: 'AGENT18_DEPLOY_TOKEN',
      bindings: [],
    }),
    [message, setMessage] = useState(''),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    request<{ project: { deploymentFeed?: Feed } }>('projects/' + projectKey)
      .then((r) => {
        if (active && r.project.deploymentFeed) setFeed(r.project.deploymentFeed);
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, projectKey]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setMessage('配置已保存，应用到运行服务后生效。');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ops-card">
      <h2>部署流水线证明</h2>
      <p>
        为流水线固定服务、环境和知识来源的映射。CI 在实际部署成功后提交完整 Commit、制品摘要和部署时间，Core
        验证 HMAC 签名；来源编号可在知识中心查看。
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => request('projects/' + projectKey + '/deployment-feed', feed));
        }}
      >
        <label>
          流水线名称
          <input
            required
            value={feed.pipeline}
            onChange={(e) => setFeed({ ...feed, pipeline: e.target.value })}
          />
        </label>
        <label>
          签名密钥引用
          <input
            required
            value={feed.credentialEnv}
            onChange={(e) => setFeed({ ...feed, credentialEnv: e.target.value })}
          />
        </label>
        {feed.bindings.map((b, i) => (
          <fieldset key={i}>
            <label>
              服务
              <input
                required
                value={b.service}
                onChange={(e) =>
                  setFeed({
                    ...feed,
                    bindings: feed.bindings.map((v, j) => (i === j ? { ...v, service: e.target.value } : v)),
                  })
                }
              />
            </label>
            <label>
              环境
              <select
                value={b.environment}
                onChange={(e) =>
                  setFeed({
                    ...feed,
                    bindings: feed.bindings.map((v, j) =>
                      i === j ? { ...v, environment: e.target.value } : v,
                    ),
                  })
                }
              >
                <option value="production">生产</option>
                <option value="staging">预发布</option>
                <option value="development">开发</option>
              </select>
            </label>
            <label>
              知识库 Git 来源 UUID
              <input
                required
                value={b.sourceId}
                onChange={(e) =>
                  setFeed({
                    ...feed,
                    bindings: feed.bindings.map((v, j) => (i === j ? { ...v, sourceId: e.target.value } : v)),
                  })
                }
              />
            </label>
            <button
              type="button"
              onClick={() => setFeed({ ...feed, bindings: feed.bindings.filter((_, j) => i !== j) })}
            >
              移除映射
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            setFeed({
              ...feed,
              bindings: [...feed.bindings, { service: '', environment: 'production', sourceId: '' }],
            })
          }
        >
          新增映射
        </button>
        <button disabled={busy || !feed.bindings.length}>保存映射</button>
      </form>
      <details>
        <summary>设置 / 轮换流水线密钥</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request('analytics/credentials', { name: feed.credentialEnv, value: secret });
              setSecret('');
            });
          }}
        >
          <input
            aria-label="流水线签名密钥"
            type="password"
            minLength={32}
            required
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <button disabled={busy}>保存密钥</button>
        </form>
      </details>
      <p role="status">{message}</p>
    </section>
  );
}
