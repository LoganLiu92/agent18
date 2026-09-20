import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
export function SupportNotifications({
  request,
  base,
  revision,
  open,
}: {
  request: Request;
  base: string;
  revision: number;
  open: (id: string) => void;
}) {
  type Notice = {
    id: string;
    title: string;
    ticket_version: number;
    ticket_status: string;
    updated_at: string;
  };
  const [items, setItems] = useState<Notice[]>([]),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    request<{ notifications: Notice[] }>(base + '/support/notifications')
      .then((r) => {
        if (active) setItems(r.notifications);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, base, revision, refresh]);
  return (
    <details className="admin-card ws-section">
      <summary>分配给我的更新（最多显示 100 条） · {items.length}</summary>
      <button onClick={() => setRefresh((v) => v + 1)}>刷新更新</button>
      {items.map((n) => (
        <article className="ws-reference" key={n.id}>
          <b>{n.title}</b>
          <small>{new Date(n.updated_at).toLocaleString()}</small>
          <div className="ws-actions">
            <button onClick={() => open(n.id)}>打开工单</button>
            <button
              onClick={() =>
                void request(base + '/support/notifications/' + n.id + '/read', { version: n.ticket_version })
                  .then(() => setRefresh((v) => v + 1))
                  .catch((e) => setError(e.message))
              }
            >
              标记这次更新已读
            </button>
          </div>
        </article>
      ))}
      {!items.length && <p>暂无可见的新更新。</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
export function SlaSettings({ request, base }: { request: Request; base: string }) {
  const [settings, setSettings] = useState<{
      enabled: boolean;
      calendar: {
        timezone: string;
        weekdays: number[];
        start: string;
        end: string;
        holidays: string[];
      } | null;
      responseTargets: { low: number; normal: number; high: number; urgent: number };
      targets: { low: number; normal: number; high: number; urgent: number };
    }>(),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <details
      className="admin-card ws-section"
      onToggle={(e) => {
        if (e.currentTarget.open && !settings)
          void request<{ settings: NonNullable<typeof settings> }>(base + '/support/settings')
            .then((r) => setSettings(r.settings))
            .catch((e) => setMessage(e.message));
      }}
    >
      <summary>基础 SLA 策略</summary>
      <p>
        可按连续 24
        小时或指定工作日历计时。日历在工单开始计时时固化，修改配置不会改变已有工单的累计口径。等待客户、等待内部、已解决和已关闭时暂停；重开继续累计，不清零。启用后对新工单和首次更新的旧工单开始计时，不追溯未计时的历史。停用只停止给新工单启用计时，已有工单继续使用记录的目标。
      </p>
      <p>
        首次公开回复采用同一工作日历，从启用时起计时，到员工首次公开回复停止；内部备注和等待状态不会停止首响时钟。已存在的历史首响不补算。解决时钟单独按等待状态暂停。
      </p>
      {settings && (
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void request(base + '/support/settings', {
              ...settings,
              calendar: settings.calendar
                ? {
                    ...settings.calendar,
                    holidays: settings.calendar.holidays.map((x) => x.trim()).filter(Boolean),
                  }
                : null,
            })
              .then(() => setMessage('策略已保存；工单保留各自计时状态。'))
              .catch((e) => setMessage(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label className="ws-check">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
            />
            启用首响与解决时限
          </label>
          <label>
            计时日历
            <select
              value={settings.calendar ? 'business' : 'continuous'}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  calendar:
                    e.target.value === 'continuous'
                      ? null
                      : {
                          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                          weekdays: [1, 2, 3, 4, 5],
                          start: '09:00',
                          end: '18:00',
                          holidays: [],
                        },
                })
              }
            >
              <option value="continuous">连续 24 小时</option>
              <option value="business">工作时间与节假日</option>
            </select>
          </label>
          {settings.calendar && (
            <>
              <label>
                时区
                <input
                  required
                  value={settings.calendar.timezone}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      calendar: { ...settings.calendar!, timezone: e.target.value },
                    })
                  }
                />
              </label>
              <div className="ws-actions">
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <label key={d}>
                    <input
                      type="checkbox"
                      checked={settings.calendar!.weekdays.includes(d)}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          calendar: {
                            ...settings.calendar!,
                            weekdays: e.target.checked
                              ? [...settings.calendar!.weekdays, d]
                              : settings.calendar!.weekdays.filter((x) => x !== d),
                          },
                        })
                      }
                    />
                    周{['一', '二', '三', '四', '五', '六', '日'][d - 1]}
                  </label>
                ))}
              </div>
              <label>
                开始
                <input
                  type="time"
                  required
                  value={settings.calendar.start}
                  onChange={(e) =>
                    setSettings({ ...settings, calendar: { ...settings.calendar!, start: e.target.value } })
                  }
                />
              </label>
              <label>
                结束（同一天）
                <input
                  type="time"
                  required
                  value={settings.calendar.end}
                  onChange={(e) =>
                    setSettings({ ...settings, calendar: { ...settings.calendar!, end: e.target.value } })
                  }
                />
              </label>
              <label>
                休息日期（YYYY-MM-DD，每行一个）
                <textarea
                  value={settings.calendar.holidays.join('\n')}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      calendar: { ...settings.calendar!, holidays: e.target.value.split('\n') },
                    })
                  }
                />
              </label>
            </>
          )}
          {(['low', 'normal', 'high', 'urgent'] as const).map((k) => (
            <label key={k}>
              {{ low: '低', normal: '普通', high: '高', urgent: '紧急' }[k]}优先级（分钟）
              <input
                type="number"
                required
                min={1}
                max={525600}
                value={settings.targets[k]}
                onChange={(e) =>
                  setSettings({ ...settings, targets: { ...settings.targets, [k]: +e.target.value } })
                }
              />
            </label>
          ))}
          {(['low', 'normal', 'high', 'urgent'] as const).map((k) => (
            <label key={'response-' + k}>
              首次回复 · {{ low: '低', normal: '普通', high: '高', urgent: '紧急' }[k]}优先级（分钟）
              <input
                type="number"
                required
                min={1}
                max={525600}
                value={settings.responseTargets[k]}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    responseTargets: { ...settings.responseTargets, [k]: +e.target.value },
                  })
                }
              />
            </label>
          ))}
          <button disabled={busy}>保存 SLA 策略</button>
        </form>
      )}
      <p role="status">{message}</p>
    </details>
  );
}
