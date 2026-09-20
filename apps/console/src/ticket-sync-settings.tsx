import { useEffect, useState } from 'react';
import type { TicketSyncConfig } from '@agent18/contracts';
export function TicketSyncSettings({
  projectKey,
  request,
}: {
  projectKey: string;
  request: <T>(path: string, body?: unknown) => Promise<T>;
}) {
  const [config, setConfig] = useState<TicketSyncConfig>({
      enabled: false,
      url: 'https://your-ticket-bridge.example/events',
      credentialEnv: 'AGENT18_SYNC_TOKEN',
      tenantIds: [],
    }),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    request<{ project: { ticketSync?: TicketSyncConfig } }>('projects/' + projectKey)
      .then((r) => {
        if (active && r.project.ticketSync) setConfig(r.project.ticketSync);
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
      setMessage('已保存，应用到运行服务后生效。');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ops-card">
      <h2>外部工单与通知接口</h2>
      <p>
        对接支持签名、事件去重及版本比较的工单桥。启用后仍需在每张工单上开启同步；外发内容仅包含编号、状态、优先级和删除标记。
      </p>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() =>
            request('projects/' + projectKey + '/ticket-sync', {
              ...config,
              tenantIds: config.tenantIds.map((t) => t.trim()).filter(Boolean),
            }),
          );
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />
          启用此接口
        </label>
        <label>
          接收事件 URL
          <input
            type="url"
            required
            value={config.url}
            onChange={(e) => setConfig({ ...config, url: e.target.value })}
          />
        </label>
        <label>
          签名密钥引用
          <input
            required
            value={config.credentialEnv}
            onChange={(e) => setConfig({ ...config, credentialEnv: e.target.value })}
          />
        </label>
        <label>
          允许同步的租户（每行一个）
          <textarea
            required
            value={config.tenantIds.join('\n')}
            onChange={(e) => setConfig({ ...config, tenantIds: e.target.value.split('\n') })}
          />
        </label>
        <button disabled={busy}>保存接口</button>
      </form>
      <details>
        <summary>写入或轮换签名密钥</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request('analytics/credentials', { name: config.credentialEnv, value: secret });
              setSecret('');
            });
          }}
        >
          <input
            aria-label="同步签名密钥"
            type="password"
            required
            minLength={32}
            value={secret}
            autoComplete="off"
            onChange={(e) => setSecret(e.target.value)}
          />
          <button disabled={busy}>保存密钥</button>
        </form>
      </details>
      <p>回调地址：Core 的 /integrations/tickets/events。协议与参考接收器见接入手册。</p>
      <p role="status">{message}</p>
    </section>
  );
}
