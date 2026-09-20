import { useState } from 'react';
type Policy = {
  conversation_days: number | null;
  ticket_days: number | null;
  attachment_days: number | null;
  evidence_days: number | null;
  audit_days: number | null;
};
const names: Record<keyof Policy, string> = {
  conversation_days: '对话正文',
  ticket_days: '已解决工单',
  attachment_days: '工单附件',
  evidence_days: '运行证据',
  audit_days: '客户操作审计',
};
export function RetentionSettings({
  request,
  base,
}: {
  request: <T>(path: string, body?: unknown) => Promise<T>;
  base: string;
}) {
  const [policy, setPolicy] = useState<Policy>(),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <details className="admin-card ws-section">
      <summary
        onClick={() => {
          if (!policy)
            void request<{ policy: Policy }>(base + '/retention')
              .then((r) => {
                const { conversation_days, ticket_days, attachment_days, evidence_days, audit_days } =
                  r.policy;
                setPolicy({ conversation_days, ticket_days, attachment_days, evidence_days, audit_days });
              })
              .catch((e) => setMessage(e.message));
        }}
      >
        数据保留与删除
      </summary>
      <p>
        空值表示不自动过期。工单、附件和证据只清理已解决且没有运行中任务的记录。审计保留独立设置，最少 30
        天；管理员安全审计继续保留。
      </p>
      {policy && (
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void request(base + '/retention', policy)
              .then(() => setMessage('策略已保存。部署者可先运行 pnpm retention 预览，再用 --apply 执行。'))
              .catch((e) => setMessage(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {(Object.keys(names) as (keyof Policy)[]).map((k) => (
            <label key={k}>
              {names[k]}（天）
              <input
                type="number"
                min={k === 'audit_days' ? 30 : 1}
                max={3650}
                value={policy[k] ?? ''}
                placeholder="长期保留"
                onChange={(e) =>
                  setPolicy({ ...policy, [k]: e.target.value === '' ? null : +e.target.value })
                }
              />
            </label>
          ))}
          <button disabled={busy}>保存保留策略</button>
        </form>
      )}
      <p>
        维护命令每类最多处理 200
        条；需要持续清理时由部署方调度重复运行。删除账本随备份恢复重放，恢复切换前必须停止应用写入。
      </p>
      <p role="status">{message}</p>
    </details>
  );
}
