import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Schedule = {
  id: string;
  title: string;
  definition: { frequency: string; time: string; timezone: string; tenant: string; days: number };
  version: number;
  enabled: boolean;
  next_due: string;
  last_reason: string | null;
};
type Job = {
  id: string;
  state: string;
  reason: string | null;
  report_id: string | null;
  created_at: string;
  attempts: number;
};
export function ReportSchedules({
  request,
  path,
  tenant,
  days,
  metricId,
  dimensions = [],
  onReport,
}: {
  request: Request;
  path: string;
  tenant: string;
  days: number;
  metricId?: string;
  dimensions?: string[];
  onReport: (id: string) => Promise<void>;
}) {
  const [schedules, setSchedules] = useState<Schedule[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [title, setTitle] = useState('定期分析报告'),
    [frequency, setFrequency] = useState('weekly'),
    [weekday, setWeekday] = useState(1),
    [time, setTime] = useState('09:00'),
    [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const [s, j] = await Promise.all([
      request<{ schedules: Schedule[] }>(path + '/schedules'),
      request<{ jobs: Job[] }>(path + '/jobs'),
    ]);
    setSchedules(s.schedules);
    setJobs(j.jobs);
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    Promise.all([
      request<{ schedules: Schedule[] }>(path + '/schedules'),
      request<{ jobs: Job[] }>(path + '/jobs'),
    ])
      .then(([s, j]) => {
        if (active) {
          setSchedules(s.schedules);
          setJobs(j.jobs);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path]);
  return (
    <section className="admin-card">
      <h2>定期报告</h2>
      <p>
        按所选指标、最近 {days} 天和租户 {tenant || '当前获准范围'}{' '}
        保存快照。每次执行重新检查权限；任务最多自动重试三次。修改计划可归档后重新创建。
      </p>
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="ws-ticket-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() =>
            request(path + '/schedules', {
              title,
              definition: {
                kind: metricId ? 'analytics_report' : 'support_report',
                metricId,
                dimensions,
                days,
                tenant,
                frequency,
                weekday,
                time,
                timezone,
              },
            }),
          );
        }}
      >
        <label>
          标题
          <input
            required
            minLength={2}
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          频率
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
          </select>
        </label>
        {frequency === 'weekly' && (
          <label>
            星期
            <select value={weekday} onChange={(e) => setWeekday(+e.target.value)}>
              {['日', '一', '二', '三', '四', '五', '六'].map((x, i) => (
                <option value={i} key={i}>
                  周{x}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          当地时间
          <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label>
          IANA 时区
          <input required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
        <button disabled={busy || Boolean(metricId && !tenant)}>创建计划</button>
      </form>
      <p>
        夏令时不存在的时刻跳过当日，重复时刻只执行一次；停机期间合并为一次补跑。结果显示在任务记录和个人报告中。
      </p>
      {schedules.map((s) => (
        <article className="ws-reference" key={s.id}>
          <b>
            {s.title} · {s.enabled ? '运行中' : '已暂停'}
          </b>
          <small>
            {s.definition.timezone} {s.definition.time} · 下次 {new Date(s.next_due).toLocaleString()} ·{' '}
            {s.last_reason}
          </small>
          <div className="ws-actions">
            <button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  request(path + '/schedules/' + s.id, { version: s.version, enabled: !s.enabled }),
                )
              }
            >
              {s.enabled ? '暂停' : '恢复'}
            </button>
            <button
              disabled={busy || !s.enabled}
              onClick={() =>
                void act(() =>
                  request(path + '/schedules/' + s.id + '/run', { requestKey: crypto.randomUUID() }),
                )
              }
            >
              立即运行 / 重新运行
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act(() => request(path + '/schedules/' + s.id + '/archive', { version: s.version }))
              }
            >
              归档计划
            </button>
          </div>
        </article>
      ))}
      <h3>最近任务</h3>
      <button disabled={busy} onClick={() => void act(refresh)}>
        刷新任务
      </button>
      {jobs.map((j) => (
        <article className="ws-reference" key={j.id}>
          <b>
            {{
              pending: '待运行',
              running: '执行中',
              completed: '已完成',
              failed: '失败',
              cancelled: '已取消',
            }[j.state] ?? j.state}
          </b>
          <small>
            {new Date(j.created_at).toLocaleString()} · 尝试 {j.attempts} 次 · {j.reason}
          </small>
          {j.report_id && (
            <button disabled={busy} onClick={() => void act(() => onReport(j.report_id!))}>
              查看报告
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
