import { useEffect, useState } from 'react';
import type { Agent18, BusinessQuery, QueryResult } from '@agent18/web-sdk';
export function BusinessQueries({ client }: { client: Agent18 }) {
  const [queries, setQueries] = useState<BusinessQuery[]>([]),
    [selected, setSelected] = useState(''),
    [args, setArgs] = useState<Record<string, string | number | boolean>>({}),
    [result, setResult] = useState<QueryResult>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .listBusinessQueries()
      .then((r) => {
        if (active) setQueries(r.queries);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [client]);
  const query = queries.find((q) => q.id === selected);
  return (
    <div className="query-workspace">
      <section className="setup-card">
        <span className="experience-kicker">YOUR BUSINESS, IN VIEW</span>
        <h2>查到当前业务的真实状态。</h2>
        <p>数据来自你的业务系统，只展示当前用户有权访问的记录。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!query) return;
            setBusy(true);
            setError('');
            setResult(undefined);
            void client
              .queryBusiness(query.id, args)
              .then(setResult)
              .catch((e) =>
                setError(
                  e.message === 'BUSINESS_NOT_ACCESSIBLE'
                    ? '记录不存在，或你没有查看该记录的权限。'
                    : e.message,
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label>
            想查什么
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setArgs({});
                setResult(undefined);
              }}
              required
            >
              <option value="">{queries.length ? '选择查询内容' : '当前身份暂无开放的查询'}</option>
              {queries.map((q) => (
                <option value={q.id} key={q.id}>
                  {q.title}
                </option>
              ))}
            </select>
          </label>
          {query && <p>{query.description}</p>}
          {query?.fields.map((f) => (
            <label key={f.name}>
              {f.label}
              {f.enum || f.type === 'boolean' ? (
                <select
                  required={f.required}
                  value={String(args[f.name] ?? '')}
                  onChange={(e) => {
                    const value = e.target.value;
                    setArgs((v) =>
                      value === ''
                        ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== f.name))
                        : { ...v, [f.name]: f.type === 'boolean' ? value === 'true' : value },
                    );
                  }}
                >
                  <option value="">请选择</option>
                  {(f.enum ?? ['true', 'false']).map((v) => (
                    <option key={v} value={v}>
                      {f.type === 'boolean' ? (v === 'true' ? '是' : '否') : v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  required={f.required}
                  maxLength={500}
                  type={f.type === 'number' ? 'number' : 'text'}
                  step="any"
                  value={String(args[f.name] ?? '')}
                  onChange={(e) => {
                    const value = e.target.value;
                    setArgs((v) =>
                      value === ''
                        ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== f.name))
                        : { ...v, [f.name]: f.type === 'number' ? Number(value) : value },
                    );
                  }}
                />
              )}
            </label>
          ))}
          <button className="experience-primary" disabled={busy || !query}>
            {busy ? '正在查询业务系统…' : '查询业务 →'}
          </button>
        </form>
        {error && (
          <p role="alert" className="experience-alert">
            {error}
          </p>
        )}
      </section>
      <section className="setup-card query-results">
        {result ? (
          <>
            <div className="ops-card-head">
              <h2>查询结果</h2>
              <span>{new Date(result.retrievedAt).toLocaleTimeString()}</span>
            </div>
            {result.rows.length ? (
              <div className="query-table-scroll">
                <table>
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c.path}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i}>
                        {result.columns.map((c) => (
                          <td key={c.path}>
                            {r[c.path] === null
                              ? '—'
                              : typeof r[c.path] === 'boolean'
                                ? r[c.path]
                                  ? '开启'
                                  : '关闭'
                                : String(r[c.path])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="build-empty">没有符合条件的记录。</div>
            )}
            <p className="muted-text">
              {result.truncated ? '仅显示前 50 条，请缩小查询范围。' : '来自业务系统实时响应。'}{' '}
              本次查询编号：{result.requestId}
            </p>
          </>
        ) : (
          <div className="query-placeholder">
            <span>⌕</span>
            <h3>信息就在需要的时候。</h3>
            <p>
              选择左侧查询，获取订单、设置等业务信息。
              <br />
              每次查询都使用你当前的登录身份。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
