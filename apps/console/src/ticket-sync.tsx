import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
export function TicketSyncPanel({
  request,
  base,
  ticketId,
  version,
  onChanged,
}: {
  request: Request;
  base: string;
  ticketId: string;
  version: number;
  onChanged: () => Promise<void>;
}) {
  type State = {
    configured: boolean;
    link: {
      enabled: boolean;
      external_id: string | null;
      external_version: number;
      external_status: string | null;
      updated_at: string;
    } | null;
    jobs: { id: string; state: string; attempts: number; reason: string | null; case_version: number }[];
  };
  const [state, setState] = useState<State>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const path = base + '/tickets/' + ticketId + '/external';
  useEffect(() => {
    let active = true;
    request<State>(path)
      .then((s) => {
        if (active) setState(s);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path, version]);
  const act = async (action: string) => {
    setBusy(true);
    try {
      await request(path, { action, version });
      await onChanged();
      setState(await request<State>(path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="ws-section">
      <summary>外部工单同步</summary>
      <p>同步工单编号、状态、优先级和删除标记。外部进度单独显示；本系统的解决方案仍需员工审核填写。</p>
      {error && <p role="alert">{error}</p>}
      {!state?.configured && <p>尚未为该租户启用外部工单接口。</p>}
      {state?.link && (
        <p>
          外部编号 {state.link.external_id ?? '等待回执'} · 外部状态 {state.link.external_status ?? '未回传'}{' '}
          · 版本 {state.link.external_version}
        </p>
      )}
      <div className="ws-actions">
        <button
          disabled={busy || !state?.configured || !!state.link?.enabled}
          onClick={() => void act('connect')}
        >
          启用同步
        </button>
        <button disabled={busy || !state?.link?.enabled} onClick={() => void act('disconnect')}>
          停止同步
        </button>
        <button
          disabled={busy || !state?.configured || !state.jobs.some((j) => j.state === 'failed')}
          onClick={() => void act('retry')}
        >
          重试失败投递
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void request<State>(path)
              .then(setState)
              .catch((e) => setError(e.message))
          }
        >
          刷新回执
        </button>
      </div>
      {state?.jobs.map((j) => (
        <p key={j.id}>
          工单版本 {j.case_version} · {j.state} · 尝试 {j.attempts} · {j.reason}
        </p>
      ))}
    </details>
  );
}
