import { useEffect, useState } from 'react';
import type { AnalyticsConfig } from '@agent18/contracts';
import { analyticsConfigSchema } from '@agent18/contracts';
type Request = <T>(path: string, body?: unknown, key?: string) => Promise<T>;
export function AnalyticsSettings({ projectKey, request }: { projectKey: string; request: Request }) {
  const [config, setConfig] = useState<AnalyticsConfig>({
      enabled: false,
      baseUrl: 'https://your-saas.example/api/analytics',
      credentialEnv: 'AGENT18_ANALYTICS_TOKEN',
      tenantIds: [],
      metrics: [],
      playbooks: [],
    }),
    [docker, setDocker] = useState(''),
    [message, setMessage] = useState(''),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false),
    [invalid, setInvalid] = useState<Record<number, boolean>>({});
  useEffect(() => {
    let active = true;
    request<{ project: { analytics?: AnalyticsConfig } }>('projects/' + projectKey)
      .then((r) => {
        if (active && r.project.analytics) setConfig(r.project.analytics);
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
      setMessage('已保存。应用到运行服务后生效。');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  function add() {
    setConfig({
      ...config,
      metrics: [
        ...config.metrics,
        {
          title: '新的业务指标',
          path: '/summary',
          questions: [],
          definition: {
            id: 'business.metric' + (config.metrics.length + 1),
            version: '1',
            definition: '填写经过业务确认的指标公式、计入条件、排除条件和时间归属。',
            timezone: 'UTC',
            values: [{ column: 'count', unit: 'record' }],
            dimensions: [],
            period: { startField: 'start', endField: 'end' },
            maxDays: 90,
          },
        },
      ],
    });
  }
  return (
    <section className="ops-card">
      <h2>接入业务与网站分析</h2>
      <p>
        登记只读统计 API，由接入方验证服务身份与租户。指标修改后，使用旧配置的定期报告会停止，需重新审核创建。
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const parsed = analyticsConfigSchema.parse({
              ...config,
              tenantIds: config.tenantIds.map((t) => t.trim()).filter(Boolean),
              metrics: config.metrics.map((m) => ({
                ...m,
                questions: m.questions.map((q) => q.trim()).filter(Boolean),
              })),
            });
            await request('projects/' + projectKey + '/analytics', {
              config: parsed,
              ...(docker ? { dockerBaseUrl: docker } : {}),
            });
          });
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />
          启用已审核接口
        </label>
        <label>
          API 基础地址
          <input
            required
            type="url"
            value={config.baseUrl}
            onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
          />
        </label>
        <label>
          容器访问地址（可选）
          <input type="url" value={docker} onChange={(e) => setDocker(e.target.value)} />
        </label>
        <label>
          凭据环境变量名
          <input
            required
            value={config.credentialEnv}
            onChange={(e) => setConfig({ ...config, credentialEnv: e.target.value })}
          />
        </label>
        <label>
          允许服务访问的租户（每行一个）
          <textarea
            required
            value={config.tenantIds.join('\n')}
            onChange={(e) => setConfig({ ...config, tenantIds: e.target.value.split('\n') })}
          />
        </label>
        <button type="button" onClick={add}>
          新增指标
        </button>
        {config.metrics.map((m, i) => (
          <fieldset key={i}>
            <legend>指标 {i + 1}</legend>
            <label>
              名称
              <input
                value={m.title}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    metrics: config.metrics.map((v, j) => (i === j ? { ...v, title: e.target.value } : v)),
                  })
                }
              />
            </label>
            <label>
              GET 路径
              <input
                value={m.path}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    metrics: config.metrics.map((v, j) => (i === j ? { ...v, path: e.target.value } : v)),
                  })
                }
              />
            </label>
            <label>
              指标口径（JSON，包含版本、单位、币种和维度）
              <textarea
                rows={12}
                defaultValue={JSON.stringify(m.definition, null, 2)}
                onChange={(e) => {
                  try {
                    const definition = JSON.parse(e.target.value);
                    setConfig({
                      ...config,
                      metrics: config.metrics.map((v, j) => (i === j ? { ...v, definition } : v)),
                    });
                    setInvalid({ ...invalid, [i]: false });
                  } catch {
                    setInvalid({ ...invalid, [i]: true });
                  }
                }}
              />
            </label>
            <label>
              常见问题（每行一个）
              <textarea
                value={m.questions.join('\n')}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    metrics: config.metrics.map((v, j) =>
                      i === j ? { ...v, questions: e.target.value.split('\n') } : v,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setConfig({ ...config, metrics: config.metrics.filter((_, j) => i !== j) });
                setInvalid({});
              }}
            >
              移除指标
            </button>
          </fieldset>
        ))}
        <h3>可复用的只读 Playbook</h3>
        <p>
          每个 Playbook
          只引用一个已登记指标及允许维度，加载后仍需确认租户和查询。可将审定过的口径复用到手动与定期报告。
        </p>
        {config.playbooks.map((p, i) => (
          <fieldset key={p.id}>
            <legend>
              {p.id} · v{p.version}
            </legend>
            <label>
              名称
              <input
                value={p.title}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    playbooks: config.playbooks.map((v, j) =>
                      i === j ? { ...v, title: e.target.value } : v,
                    ),
                  })
                }
              />
            </label>
            <label>
              分析目的
              <textarea
                value={p.purpose}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    playbooks: config.playbooks.map((v, j) =>
                      i === j ? { ...v, purpose: e.target.value } : v,
                    ),
                  })
                }
              />
            </label>
            <label>
              最近天数
              <input
                type="number"
                min={1}
                max={90}
                value={p.days}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    playbooks: config.playbooks.map((v, j) =>
                      i === j ? { ...v, days: +e.target.value } : v,
                    ),
                  })
                }
              />
            </label>
            <small>
              指标 {p.metricId} · 维度 {p.dimensions.join('、') || '汇总'} · TENANT / READ
            </small>
            <button
              type="button"
              onClick={() => setConfig({ ...config, playbooks: config.playbooks.filter((_, j) => i !== j) })}
            >
              删除 Playbook
            </button>
          </fieldset>
        ))}
        {config.metrics.map((m) => (
          <button
            type="button"
            key={m.definition.id}
            disabled={config.playbooks.length >= 30}
            onClick={() =>
              setConfig({
                ...config,
                playbooks: [
                  ...config.playbooks,
                  {
                    id: 'review-' + crypto.randomUUID(),
                    version: '1',
                    title: m.title + '复盘',
                    purpose: '按照已审核的指标口径比较当前周期和上一周期，进一步核对变化来源。',
                    metricId: m.definition.id,
                    days: Math.min(7, m.definition.maxDays),
                    dimensions: m.definition.dimensions.slice(0, 1),
                    scope: 'TENANT',
                    effect: 'READ',
                  },
                ],
              })
            }
          >
            从 {m.title} 创建 Playbook
          </button>
        ))}
        <button disabled={busy || Object.values(invalid).some(Boolean)}>校验并保存</button>
      </form>
      <details>
        <summary>设置或轮换服务凭据</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request('analytics/credentials', { name: config.credentialEnv, value: secret });
              setSecret('');
            });
          }}
        >
          <label>
            仅写入服务端凭据文件
            <input
              type="password"
              required
              minLength={16}
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <button disabled={busy}>保存凭据</button>
        </form>
      </details>
      <p role="status">{message}</p>
    </section>
  );
}
