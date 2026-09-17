import { useEffect, useState } from 'react';
import type { OperationsConfig, ObservationCheck } from '@agent18/observability/config';
import type { ObservationReport } from '@agent18/application';
import type { PageCapture } from '@agent18/contracts';
type Request = <T>(path: string, body?: unknown, key?: string) => Promise<T>;
type Job = {
  id: string;
  case_id: string | null;
  kind: string;
  state: string;
  reason: string;
  created_at: string;
};
type Incident = { id: string; check_id: string; state: string; occurrences: number; last_job_id: string };
type State = {
  config: OperationsConfig;
  jobs: Job[];
  incidents: Incident[];
  credentials: { name: string; configured: boolean }[];
};
const stateName: Record<string, string> = {
  pending: '等待处理',
  running: '正在检查',
  completed: '已完成',
  failed: '检查失败',
  cancelled: '配置已变更',
  healthy: '正常',
  alert: '异常信号',
  unknown: '无法确定',
  open: '待处理',
  acknowledged: '已接手',
  resolved: '已恢复',
};
export function ObservationCenter({ projectKey, request }: { projectKey: string; request: Request }) {
  const [state, setState] = useState<State>(),
    [config, setConfig] = useState<OperationsConfig>(),
    [tab, setTab] = useState<'reports' | 'settings'>('reports');
  const [detail, setDetail] = useState<Job & { report?: ObservationReport }>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [credentialName, setCredentialName] = useState('AGENT18_OBS_TOKEN'),
    [credential, setCredential] = useState('');
  const [invalidChecks, setInvalidChecks] = useState<Record<string, boolean>>({});
  const base = `projects/${projectKey}/observations`;
  const refresh = async () => {
    const v = await request<State>(base);
    setState(v);
    setConfig((c) => c ?? v.config);
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void act(refresh);
    const timer = setInterval(() => void refresh().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [projectKey]);
  const open = async (id: string) =>
    setDetail(await request<Job & { report?: ObservationReport }>(base + '/' + id));
  const add = (kind: ObservationCheck['kind']) => {
    const common = {
      id: kind + '-' + Math.random().toString(36).slice(2, 8),
      title: kind === 'http' ? '服务可用性' : kind === 'loki' ? '业务错误日志' : '服务器指标',
      url:
        kind === 'http'
          ? 'https://your-saas.example/health'
          : kind === 'loki'
            ? 'http://loki:3100'
            : 'http://prometheus:9090',
    };
    const check: ObservationCheck =
      kind === 'http'
        ? { ...common, kind, expectedStatus: 200 }
        : kind === 'loki'
          ? {
              ...common,
              kind,
              labels: { app: 'your-saas' },
              tenantLabel: 'tenant_id',
              contains: 'error',
              windowMinutes: 10,
              minimumMatches: 1,
            }
          : { ...common, kind, query: 'up{job="your-saas"}', comparison: 'lt', threshold: 1 };
    setConfig((c) => ({ ...c!, checks: [...c!.checks, check] }));
  };
  return (
    <div className="observation-center">
      <div className="ops-heading">
        <div>
          <span className="experience-kicker">OBSERVE · INVESTIGATE · LEARN</span>
          <h1>从异常信号，到处理线索。</h1>
          <p>问题自动关联运行证据，巡检持续发现异常；恢复后留下可复用的经验。</p>
        </div>
        <button
          className="experience-primary"
          disabled={busy || !state?.config.enabled}
          onClick={() =>
            void act(async () => {
              await request(base + '/run', {}, crypto.randomUUID());
              await refresh();
              setNotice('巡检任务已登记。Worker 将自动处理，可刷新查看报告。');
            })
          }
        >
          立即巡检
        </button>
      </div>
      {error && (
        <p className="experience-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="experience-notice" role="status">
          {notice}
        </p>
      )}
      <div className="ops-metrics">
        <article>
          <span>数据源检查</span>
          <strong>{state?.config.checks.length ?? 0}</strong>
          <small>
            {state?.config.enabled ? '已启用 · 每 ' + state.config.intervalSeconds + ' 秒' : '等待配置并启用'}
          </small>
        </article>
        <article>
          <span>需要跟进</span>
          <strong>{state?.incidents.filter((i) => i.state !== 'resolved').length ?? 0}</strong>
          <small>重复异常合并，正常观测后标记恢复</small>
        </article>
        <article>
          <span>自动排查</span>
          <strong>{state?.config.autoInvestigate ? '随工单触发' : '未启用'}</strong>
          <small>客户上报与内部证据分开呈现</small>
        </article>
      </div>
      <div className="ops-actions">
        <button onClick={() => setTab('reports')}>巡检与排查记录</button>
        <button onClick={() => setTab('settings')}>连接数据源</button>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await refresh();
              if (detail) await open(detail.id);
            })
          }
        >
          刷新结果 ↻
        </button>
      </div>
      {tab === 'settings' && config && (
        <section className="ops-card">
          <h2>连接已有的监控系统</h2>
          <p>Loki 读取日志，Prometheus 读取服务器/业务指标，HTTP 检查固定健康地址。所有检查只读。</p>
          <div className="ops-grid">
            <label>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              />
              启用巡检与排查
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.autoInvestigate}
                onChange={(e) => setConfig({ ...config, autoInvestigate: e.target.checked })}
              />
              问题上报后自动排查
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.modelAnalysis}
                onChange={(e) => setConfig({ ...config, modelAnalysis: e.target.checked })}
              />
              允许模型分析脱敏证据
            </label>
            <label>
              巡检间隔（秒）
              <input
                type="number"
                min="60"
                max="86400"
                value={config.intervalSeconds}
                onChange={(e) => setConfig({ ...config, intervalSeconds: Number(e.target.value) })}
              />
            </label>
          </div>
          {config.checks.map((c, index) => (
            <CheckEditor
              key={c.id}
              check={c}
              onValidity={(valid) => setInvalidChecks((v) => ({ ...v, [c.id]: !valid }))}
              onChange={(value) =>
                setConfig({ ...config, checks: config.checks.map((v, i) => (i === index ? value : v)) })
              }
              onRemove={() => setConfig({ ...config, checks: config.checks.filter((_, i) => i !== index) })}
            />
          ))}
          <div className="ops-actions">
            {(['http', 'loki', 'prometheus'] as const).map((kind) => (
              <button key={kind} disabled={config.checks.length >= 8} onClick={() => add(kind)}>
                ＋ {kind === 'http' ? 'HTTP 可用性' : kind === 'loki' ? 'Loki 日志' : 'Prometheus 指标'}
              </button>
            ))}
          </div>
          <p>
            地址必须能从 Core 容器访问。Loki
            固定项目标签限定数据范围，工单排查还会追加真实租户标签；巡检使用已配置的项目范围。
          </p>
          <button
            className="experience-primary"
            disabled={busy || config.checks.some((c) => invalidChecks[c.id])}
            onClick={() =>
              void act(async () => {
                await request(base + '/config', config);
                await request('apply', {});
                await refresh();
                setNotice('检查配置已保存并应用到 Core。');
              })
            }
          >
            保存并应用检查配置
          </button>
          <hr />
          <h3>只读访问凭据</h3>
          <p>凭据保存在部署端环境文件，不进入浏览器 SDK 或客户 Token。此处只显示是否已配置。</p>
          <p>
            {state?.credentials.map((c) => c.name + ' · 已配置').join('；') ||
              '尚未保存凭据。无需鉴权的数据源可以留空凭据名称。'}
          </p>
          <label>
            环境变量名称
            <input value={credentialName} onChange={(e) => setCredentialName(e.target.value)} />
          </label>
          <label>
            Bearer 凭据
            <input
              type="password"
              autoComplete="new-password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !credential}
            onClick={() =>
              void act(async () => {
                await request('observations/credentials', { name: credentialName, value: credential });
                setCredential('');
                await request('apply', {});
                await refresh();
                setNotice('凭据已保存并应用。');
              })
            }
          >
            保存凭据
          </button>
        </section>
      )}
      {tab === 'reports' && (
        <>
          <section className="ops-card">
            <h2>异常跟进</h2>
            {state?.incidents.length ? (
              state.incidents.map((i) => (
                <article className="observation-row" key={i.id}>
                  <div>
                    <b>{state.config.checks.find((c) => c.id === i.check_id)?.title ?? i.check_id}</b>
                    <p>
                      {stateName[i.state]} · 累计 {i.occurrences} 次异常观测
                    </p>
                  </div>
                  <div>
                    <button onClick={() => void act(() => open(i.last_job_id))}>查看证据</button>
                    {i.state === 'open' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await request(`projects/${projectKey}/incidents/${i.id}/acknowledge`, {});
                            await refresh();
                          })
                        }
                      >
                        接手处理
                      </button>
                    )}
                  </div>
                </article>
              ))
            ) : (
              <div className="build-empty">还没有异常记录。请先连接数据源并运行一次巡检。</div>
            )}
          </section>
          <div className="ops-inbox">
            <section className="ops-card ops-case-list">
              <h2>最近运行</h2>
              {state?.jobs.map((j) => (
                <button
                  key={j.id}
                  className={detail?.id === j.id ? 'selected' : ''}
                  onClick={() => void act(() => open(j.id))}
                >
                  <span>{stateName[j.state]}</span>
                  <b>{j.kind === 'case' ? '客户问题自动排查' : '服务器与业务巡检'}</b>
                  <small>
                    {new Date(j.created_at).toLocaleString()}
                    {j.case_id ? ' · 工单 ' + j.case_id.slice(0, 8) : ''}
                  </small>
                </button>
              ))}
            </section>
            <section className="ops-card">
              {!detail ? (
                <div className="build-empty">选择一次运行，查看数据源结果与分析。</div>
              ) : (
                <>
                  <span className="experience-kicker">
                    {stateName[detail.state]} · {detail.id.slice(0, 8)}
                  </span>
                  <h2>排查报告</h2>
                  {detail.report ? (
                    <>
                      <p>{detail.report.summary}</p>
                      {detail.report.results.map((r) => (
                        <details key={r.checkId} className="observation-result">
                          <summary>
                            {r.title} · {stateName[r.state]}
                          </summary>
                          {r.error && <p>{r.error}</p>}
                          {r.evidence.map((e) => (
                            <article key={e.id}>
                              <small>
                                {e.source} · {new Date(e.observedAt).toLocaleString()} · {e.id.slice(0, 8)}
                              </small>
                              <pre>{e.summary}</pre>
                            </article>
                          ))}
                        </details>
                      ))}
                      <h3>
                        待核实的分析 · {detail.report.analysis.mode === 'model' ? '模型辅助' : '规则与证据'}
                      </h3>
                      {detail.report.analysis.hypotheses.map((h, i) => (
                        <p key={i}>
                          {h.text}
                          <small> 证据：{h.evidenceIds.map((id) => id.slice(0, 8)).join('、')}</small>
                        </p>
                      ))}
                      <h3>下一步</h3>
                      <ol>
                        {detail.report.analysis.nextSteps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const r = await request<{ path: string }>(
                              base + '/' + detail.id + '/knowledge-draft',
                              {},
                            );
                            setNotice(
                              '内部知识草稿已生成：' + r.path + '。在知识向导添加该目录并审核，尚未发布。',
                            );
                          })
                        }
                      >
                        整理为内部知识草稿
                      </button>
                    </>
                  ) : (
                    <p>{detail.reason || '任务已登记，等待 Worker 返回检查结果。'}</p>
                  )}
                  {detail.case_id && (
                    <CaptureView
                      key={detail.case_id}
                      projectKey={projectKey}
                      caseId={detail.case_id}
                      request={request}
                    />
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
function CheckEditor({
  check: c,
  onChange,
  onRemove,
  onValidity,
}: {
  check: ObservationCheck;
  onChange: (c: ObservationCheck) => void;
  onRemove: () => void;
  onValidity: (valid: boolean) => void;
}) {
  const [labels, setLabels] = useState(c.kind === 'loki' ? JSON.stringify(c.labels) : ''),
    [invalid, setInvalid] = useState(false);
  return (
    <fieldset className="observation-editor">
      <legend>
        {c.kind.toUpperCase()} · {c.id}
      </legend>
      <div className="ops-grid">
        <label>
          检查名称
          <input value={c.title} onChange={(e) => onChange({ ...c, title: e.target.value })} />
        </label>
        <label>
          固定服务地址
          <input value={c.url} onChange={(e) => onChange({ ...c, url: e.target.value })} />
        </label>
        <label>
          凭据环境变量（可选）
          <input
            value={c.credentialEnv ?? ''}
            placeholder="AGENT18_OBS_TOKEN"
            onChange={(e) => onChange({ ...c, credentialEnv: e.target.value || undefined })}
          />
        </label>
        {c.kind === 'http' && (
          <label>
            预期 HTTP 状态码
            <input
              type="number"
              value={c.expectedStatus}
              onChange={(e) => onChange({ ...c, expectedStatus: Number(e.target.value) })}
            />
          </label>
        )}
        {c.kind === 'loki' && (
          <>
            <label>
              项目固定标签（JSON）
              <input
                value={labels}
                onChange={(e) => {
                  setLabels(e.target.value);
                  try {
                    onChange({ ...c, labels: JSON.parse(e.target.value) });
                    setInvalid(false);
                    onValidity(true);
                  } catch {
                    setInvalid(true);
                    onValidity(false);
                  }
                }}
              />
              {invalid && <small>请输入合法 JSON 对象。</small>}
            </label>
            <label>
              租户标签名
              <input
                value={c.tenantLabel}
                onChange={(e) => onChange({ ...c, tenantLabel: e.target.value })}
              />
            </label>
            <label>
              Loki 租户 Header（可选）
              <input
                value={c.tenantHeader ?? ''}
                onChange={(e) => onChange({ ...c, tenantHeader: e.target.value || undefined })}
              />
            </label>
            <label>
              用户标签名（可选）
              <input
                value={c.subjectLabel ?? ''}
                onChange={(e) => onChange({ ...c, subjectLabel: e.target.value || undefined })}
              />
            </label>
            <label>
              错误文本包含
              <input value={c.contains} onChange={(e) => onChange({ ...c, contains: e.target.value })} />
            </label>
            <label>
              最近多少分钟
              <input
                type="number"
                min="1"
                max="60"
                value={c.windowMinutes}
                onChange={(e) => onChange({ ...c, windowMinutes: Number(e.target.value) })}
              />
            </label>
            <label>
              告警样本阈值
              <input
                type="number"
                min="1"
                max="30"
                value={c.minimumMatches}
                onChange={(e) => onChange({ ...c, minimumMatches: Number(e.target.value) })}
              />
            </label>
          </>
        )}
        {c.kind === 'prometheus' && (
          <>
            <label>
              固定 PromQL 表达式
              <input value={c.query} onChange={(e) => onChange({ ...c, query: e.target.value })} />
            </label>
            <label>
              异常条件
              <select
                value={c.comparison}
                onChange={(e) => onChange({ ...c, comparison: e.target.value as 'gt' | 'lt' })}
              >
                <option value="gt">大于阈值</option>
                <option value="lt">小于阈值</option>
              </select>
            </label>
            <label>
              阈值
              <input
                type="number"
                step="any"
                value={c.threshold}
                onChange={(e) => onChange({ ...c, threshold: Number(e.target.value) })}
              />
            </label>
          </>
        )}
      </div>
      <button onClick={onRemove}>移除此检查</button>
    </fieldset>
  );
}
export function CaptureView({
  projectKey,
  caseId,
  request,
}: {
  projectKey: string;
  caseId: string;
  request: Request;
}) {
  const [capture, setCapture] = useState<PageCapture | null>(),
    [context, setContext] = useState<import('@agent18/contracts').ClientContext | null>(),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setCapture(undefined);
    setContext(undefined);
    setError('');
    void request<{ capture: PageCapture | null; context: import('@agent18/contracts').ClientContext | null }>(
      `projects/${projectKey}/cases/${caseId}/capture`,
    ).then(
      (r) => {
        if (alive) {
          setCapture(r.capture);
          setContext(r.context);
        }
      },
      () => {
        if (alive) setError('暂时无法读取页面上下文，请刷新重试。');
      },
    );
    return () => {
      alive = false;
    };
  }, [projectKey, caseId]);
  if (error) return <p role="alert">{error}</p>;
  if (!capture && !Object.keys(context ?? {}).length) return null;
  return (
    <details className="observation-result">
      <summary>问题发生时的页面上下文</summary>
      {context && (
        <>
          <p>
            {context.route} {context.pagePath}{' '}
            {context.entity && `${context.entity.type} · ${context.entity.id}`}
          </p>
          <small>宿主提供的业务线索；用户身份与权限以服务端验证为准。</small>
          {context.events?.map((event, index) => (
            <article key={index} className="data-card">
              <b>
                {event.operation} · {event.type.endsWith('failed') ? '失败' : '成功'}
              </b>
              <p>
                {event.at} · {event.entity?.type} {event.entity?.id} · {event.errorCode}
              </p>
              <pre>
                {[
                  event.traceId && `traceId: ${event.traceId}`,
                  event.requestId && `requestId: ${event.requestId}`,
                ]
                  .filter(Boolean)
                  .join('\n')}
              </pre>
            </article>
          ))}
        </>
      )}
      {capture && (
        <>
          <p>
            {capture.page.title} · {capture.page.path}
          </p>
          <small>
            {capture.capturedAt} · {capture.page.width} × {capture.page.height}
          </small>
          {capture.screenshot && (
            <img className="capture-preview" src={capture.screenshot} alt="客户上报时的脱敏页面截图" />
          )}
          <pre>{capture.text}</pre>
          <h4>浏览器错误</h4>
          <pre>{capture.errors.join('\n') || '未捕获到错误'}</pre>
          <h4>最近操作与失败请求</h4>
          <pre>
            {capture.breadcrumbs.map((b) => `${b.at} ${b.type} ${b.detail}`).join('\n')}
            {'\n'}
            {capture.requests.map((r) => `${r.status} ${r.path} ${r.durationMs}ms`).join('\n')}
          </pre>
          <small>{capture.notice}</small>
        </>
      )}
    </details>
  );
}
