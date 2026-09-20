import { useEffect, useRef, useState } from 'react';
import './experience.css';
import { OperationsCenter } from './operations.js';
import { OperatorBootstrap } from './operator-bootstrap.js';
import type { buildProvenance } from '../../../packages/knowledge/src/provenance.js';

type Source = {
  id: string;
  name: string;
  kind: 'directory' | 'git';
  location: string;
  ref: string;
  audience: 'internal' | 'customer';
  include: string[];
  exclude: string[];
  tenantIds: string[];
};
type Project = {
  key: string;
  displayName?: string;
  organizationId: string;
  projectId: string;
  issuer: string;
  audience: string;
  jwks: { keys: Record<string, unknown>[] };
  allowedOrigins: string[];
  knowledge: string;
  businessBridge?: unknown;
};
type Build = {
  build_id: string;
  source_key: string;
  state: string;
  audience: string;
  active_build_id: string | null;
  enabled: boolean;
  report: { audience?: string; files?: number; articles?: number; modelCalls?: number };
};
type SetupState = {
  exampleSources: Source[];
  completed: boolean;
  displayName: string;
  coreUrl: string;
  projects: Project[];
  model: {
    baseUrl: string;
    name: string;
    configured: boolean;
    tokenLimitField: 'max_completion_tokens' | 'max_tokens';
    jsonMode: boolean;
  };
  knowledge: {
    projectKey: string;
    mode: 'extractive' | 'model';
    maxModelCalls: number;
    sources: Source[];
  } | null;
  builds: Build[];
};
type Job = {
  id: string;
  state: string;
  phase: string;
  error?: string;
  results: { buildId: string; source: string; articles: number }[];
};
const steps = [
  ['01', '连接你的系统', '项目、网站和登录身份'],
  ['02', '连接模型', '使用自己的模型与 API Key'],
  ['03', '接入知识来源', '已有代码、文档与知识'],
  ['04', '生成并发布', '检查内容与可见范围'],
  ['05', '放到你的网站', '选择入口，获取接入代码'],
];
const messages: Record<string, string> = {
  BUILD_POLICY_CHANGED: '知识受众已经调整，请重新构建并检查新版本后发布。',
  SETUP_ACCESS_REQUIRED: '访问码不正确，请使用部署终端显示的访问码。',
  SETUP_BUSY: '还有任务正在运行，请完成后再修改配置。',
  SETUP_REQUEST_FAILED: '配置未保存，请检查输入格式、数据库和文件权限。',
  MODEL_AUTH_FAILED: '模型服务拒绝了 API Key，请检查密钥。',
  MODEL_URL_INVALID: '请使用 HTTPS 模型地址，或本地模型的回环地址。',
  MODEL_CONFIGURATION_INCOMPLETE: '请填写接口地址、模型名称与 API Key。',
  MODEL_NOT_CONFIGURED: '请先连接模型，或改用原文索引。',
  SETTINGS_SAVED_RESTART_FAILED: '设置已保存，应用重启未完成。请检查部署服务后再次应用。',
  NO_INDEXABLE_FILES: '没有找到可索引的文件，请检查目录和文件范围。',
};
export function ProductMark({ href = '/' }: { href?: string }) {
  return (
    <a className="product-brand" href={href}>
      <span className="product-mark">
        a<span>18</span>
      </span>
      agent18
    </a>
  );
}
export function SetupWizard() {
  const [workspace, setWorkspace] = useState(false);
  const [code, setCode] = useState(''),
    [token, setToken] = useState(''),
    [state, setState] = useState<SetupState>(),
    [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [choice, setChoice] = useState('invoice-demo'),
    [name, setName] = useState('我的 SaaS'),
    [projectKey, setProjectKey] = useState('my-saas'),
    [origin, setOrigin] = useState(''),
    [issuer, setIssuer] = useState(''),
    [jwks, setJwks] = useState(''),
    [tenant, setTenant] = useState('tenant-001');
  const [baseUrl, setBaseUrl] = useState(''),
    [modelName, setModelName] = useState(''),
    [apiKey, setApiKey] = useState(''),
    [legacy, setLegacy] = useState(false),
    [jsonMode, setJsonMode] = useState(true),
    [tested, setTested] = useState(false);
  const [sources, setSources] = useState<Source[]>([]),
    [mode, setMode] = useState<'extractive' | 'model'>('extractive'),
    [job, setJob] = useState<Job>(),
    [preview, setPreview] = useState<
      {
        title: string;
        body: string;
        refs: { path: string; startLine: number; endLine: number }[];
        provenance?: ReturnType<typeof buildProvenance> | null;
      }[]
    >();
  const [previewPage, setPreviewPage] = useState(0);
  const [selectedBuild, setSelectedBuild] = useState(''),
    [applied, setApplied] = useState(false),
    [entry, setEntry] = useState<'floating' | 'inline' | 'page'>('floating'),
    [copied, setCopied] = useState(false),
    [setupBase, setSetupBase] = useState('http://localhost:4318');
  const ids = useRef({ organizationId: crypto.randomUUID(), projectId: crypto.randomUUID() });
  const controller = useRef(new AbortController());
  async function request<T>(path: string, body?: unknown, access = token): Promise<T> {
    const r = await fetch('/owner/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.current.signal,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(messages[data.error?.code] ?? data.error?.code ?? '暂时无法连接配置服务');
    return data;
  }
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
  const refresh = async () => {
    const next = await request<SetupState>('state');
    setState(next);
    return next;
  };
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    let active = true;
    const timer = setInterval(() => {
      void request<{ job: Job }>('build')
        .then((r) => {
          if (!active) return;
          setJob(r.job);
          if (r.job.state !== 'running') void refresh();
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.state, token]);
  async function unlock() {
    const next = await request<SetupState>('state', undefined, code.trim());
    setToken(code.trim());
    setCode('');
    setState(next);
    setWorkspace(next.completed);
    setSetupBase(next.coreUrl);
    setChoice(next.knowledge?.projectKey ?? next.projects[0]?.key ?? 'new');
    setName(next.displayName === 'agent18' ? '我的 SaaS' : next.displayName);
    setBaseUrl(next.model.baseUrl);
    setModelName(next.model.name);
    setLegacy(next.model.tokenLimitField === 'max_tokens');
    setJsonMode(next.model.jsonMode);
    setSources(
      next.knowledge?.sources ??
        (next.projects.some((p) => p.key === 'invoice-demo') ? next.exampleSources : []),
    );
    setMode(next.knowledge?.mode ?? 'extractive');
    if ((next as SetupState & { job?: Job }).job) setJob((next as SetupState & { job?: Job }).job);
  }
  const project = state?.projects.find((p) => p.key === choice);
  const activeKey = choice === 'new' ? projectKey : choice;
  const modelBody = {
    baseUrl,
    name: modelName,
    ...(apiKey ? { apiKey } : {}),
    tokenLimitField: legacy ? 'max_tokens' : 'max_completion_tokens',
    jsonMode,
  };
  const latestBuilds = (state?.builds ?? []).filter(
    (b, i, all) =>
      sources.some((s) => s.id === b.source_key) && all.findIndex((x) => x.source_key === b.source_key) === i,
  );
  const published = latestBuilds.filter(
    (b) => b.enabled && b.active_build_id === b.build_id && b.state === 'ready',
  ).length;
  const addSource = (kind: 'directory' | 'git') =>
    setSources((v) => [
      ...v,
      {
        id: `source-${crypto.randomUUID().slice(0, 8)}`,
        name: kind === 'git' ? '代码仓库' : '产品文档',
        kind,
        location: '',
        ref: 'main',
        audience: kind === 'git' ? 'internal' : 'customer',
        include: kind === 'git' ? ['**/*'] : ['**/*.md', '**/*.txt'],
        exclude: [],
        tenantIds: [],
      },
    ]);
  const updateSource = (index: number, patch: Partial<Source>) =>
    setSources((v) => v.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const snippet = `import { Agent18, ${entry === 'page' ? 'openSupportPage' : entry === 'floating' ? 'mountFloatingAssistant' : 'mountAssistant'} } from ${JSON.stringify(setupBase + '/sdk/agent18.js')};\n\nconst options = {\n  baseUrl: ${JSON.stringify(setupBase)},\n  projectKey: ${JSON.stringify(activeKey)},\n  getToken: async () => {\n    const response = await fetch('/api/support-token', { method: 'POST' });\n    if (!response.ok) throw new Error('请先登录');\n    return (await response.json()).token;\n  },\n};\n${entry === 'page' ? "document.querySelector('#help').onclick = () => openSupportPage(options);" : `const client = new Agent18(options);\n${entry === 'floating' ? "const assistant = mountFloatingAssistant(client, { title: '产品助手' });" : "const assistant = mountAssistant(document.querySelector('#support'), client);"}`}\n// 网站用户切换身份时，销毁旧实例并重新连接。`;
  if (!state)
    return (
      <div className="setup-gate">
        <div className="gate-brand">
          <ProductMark href="http://localhost:4318" />
          <span>安装与配置</span>
        </div>
        <div className="gate-layout">
          <section>
            <span className="experience-kicker">WELCOME TO AGENT18</span>
            <h1>
              让你的系统，
              <br />
              多一位懂业务的助手。
            </h1>
            <p>连接已有代码和文档，使用自己的模型，把答案和业务服务送到用户正在操作的页面。</p>
            <div className="gate-features">
              <span>01 · 知识随版本更新</span>
              <span>02 · 业务沿用用户权限</span>
              <span>03 · 一次配置，多种接入</span>
            </div>
          </section>
          <form
            className="gate-card"
            onSubmit={(e) => {
              e.preventDefault();
              void act(unlock);
            }}
          >
            <div className="gate-icon">↗</div>
            <h2>开始初始化</h2>
            <p>输入部署终端中显示的访问码，进入配置向导。</p>
            <label>
              部署访问码
              <input
                autoFocus
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoComplete="off"
                placeholder="粘贴 Owner access code"
              />
            </label>
            {error && (
              <div role="alert" className="experience-error">
                {error}
              </div>
            )}
            <button className="experience-primary" disabled={busy}>
              {busy ? '正在验证…' : '进入配置向导'} <span>→</span>
            </button>
            <small>
              访问码仅用于部署配置，不是客户的登录凭据。
              <br />
              找不到访问码？在部署终端运行 <code>pnpm setup:ui</code>。
            </small>
          </form>
        </div>
        <footer className="experience-footer">agent18 · Open source, built for your SaaS.</footer>
      </div>
    );
  if (workspace)
    return (
      <OperationsCenter
        token={token}
        projects={state.projects}
        coreUrl={state.coreUrl}
        onWizard={() => setWorkspace(false)}
      />
    );
  return (
    <div className="setup-shell">
      <aside className="setup-aside">
        <ProductMark href="http://localhost:4318" />
        <button className="setup-back" onClick={() => setWorkspace(true)}>
          ◈ 进入接入工作台
        </button>
        <div className="setup-aside-label">初始化你的工作空间</div>
        <nav>
          {steps.map(([number, title, desc], i) => (
            <button
              key={number}
              className={i === step ? 'selected' : i < step ? 'complete' : ''}
              onClick={() => {
                setStep(i);
                setError('');
              }}
            >
              <span className="step-number">{i < step ? '✓' : number}</span>
              <span>
                <b>{title}</b>
                <small>{desc}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="setup-aside-note">
          <span>你的数据，你的选择</span>
          <p>模型密钥保存在部署端。客户只能看到已发布、且有权访问的知识与操作。</p>
        </div>
        <a href="http://localhost:4318" className="setup-back">
          ← 返回首页
        </a>
      </aside>
      <main className="setup-main">
        <header className="setup-top">
          <span>
            设置向导 <span>/</span> {steps[step]![1]}
          </span>
          <span className="setup-owner">
            <i />
            部署者
          </span>
        </header>
        <div className="setup-content">
          {step === 0 && <OperatorBootstrap token={token} coreUrl={state.coreUrl} />}
          <div className="setup-heading">
            <span className="experience-kicker">STEP {steps[step]![0]} OF 05</span>
            <h1>
              {
                [
                  '先认识一下你的系统',
                  '连接你信任的模型',
                  '把已有知识带进来',
                  '让知识准备好再见用户',
                  '把助手放到用户身边',
                ][step]
              }
            </h1>
            <p>
              {
                [
                  '建立项目和网站身份绑定。你可以先体验演示系统，也可以接入自己的 SaaS。',
                  '用于整理资料、回答问题和理解业务需求。API Key 不会交给网站用户。',
                  '选择产品文档或代码仓库。每个来源都可以明确谁能看、哪些文件需要读取。',
                  '构建完成后检查文章与来源，再决定是否发布。内部知识不会出现在客户界面。',
                  '浮动入口、嵌入区块和独立页面共享同一套身份、知识与业务能力。',
                ][step]
              }
            </p>
          </div>
          {error && (
            <div className="experience-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="experience-success" role="status">
              {notice}
            </div>
          )}
          {step === 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  if (choice === 'new') {
                    let keys;
                    try {
                      keys = JSON.parse(jwks);
                    } catch {
                      throw new Error('公钥集需要是有效的 JSON 对象。');
                    }
                    await request('project', {
                      project: {
                        key: projectKey,
                        displayName: name,
                        ...ids.current,
                        issuer: issuer || origin,
                        audience: 'agent18:support',
                        jwks: keys,
                        knowledge: 'indexed',
                        allowedOrigins: [new URL(origin).origin],
                      },
                      organizationName: name,
                      projectName: name,
                      tenants: [{ id: tenant, name: tenant }],
                    });
                    setChoice(projectKey);
                    await refresh();
                  }
                  const selection = await request<{ knowledge: NonNullable<SetupState['knowledge']> }>(
                    'knowledge/select',
                    { projectKey: activeKey },
                  );
                  setSources(
                    selection.knowledge.sources.length
                      ? selection.knowledge.sources
                      : activeKey === 'invoice-demo'
                        ? state.exampleSources
                        : [],
                  );
                  setMode(selection.knowledge.mode);
                  await refresh();
                  setStep(1);
                });
              }}
            >
              <div className="choice-cards">
                {state.projects.map((p) => (
                  <button
                    type="button"
                    key={p.key}
                    className={choice === p.key ? 'choice-card selected' : 'choice-card'}
                    onClick={() => setChoice(p.key)}
                  >
                    <span className="choice-icon">◈</span>
                    <b>{p.key === 'invoice-demo' ? '体验演示系统' : (p.displayName ?? p.key)}</b>
                    <small>{p.key === 'invoice-demo' ? '已准备好身份与示例业务，可立即体验。' : p.key}</small>
                    <span className="choice-check">{choice === p.key ? '●' : '○'}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className={choice === 'new' ? 'choice-card selected' : 'choice-card'}
                  onClick={() => setChoice('new')}
                >
                  <span className="choice-icon">＋</span>
                  <b>接入我的 SaaS</b>
                  <small>使用你的网站、用户身份和业务接口。</small>
                  <span className="choice-check">{choice === 'new' ? '●' : '○'}</span>
                </button>
              </div>
              <section className="setup-card">
                <h3>{choice === 'new' ? '项目基本信息' : '工作空间名称'}</h3>
                <div className="setup-form-grid">
                  <label>
                    系统名称
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={120}
                      placeholder="例如：Acme 订单中心"
                    />
                  </label>
                  {choice === 'new' && (
                    <>
                      <label>
                        项目标识
                        <input
                          value={projectKey}
                          onChange={(e) => setProjectKey(e.target.value)}
                          required
                          pattern="[a-z][a-z0-9-]{1,63}"
                          placeholder="例如：acme-orders"
                        />
                      </label>
                      <label>
                        网站地址
                        <input
                          type="url"
                          value={origin}
                          onChange={(e) => setOrigin(e.target.value)}
                          required
                          placeholder="https://app.example.com"
                        />
                      </label>
                      <label>
                        首个接入租户
                        <input
                          value={tenant}
                          onChange={(e) => setTenant(e.target.value)}
                          required
                          maxLength={128}
                        />
                      </label>
                    </>
                  )}
                </div>
                {choice === 'new' && (
                  <details className="setup-advanced" open>
                    <summary>
                      绑定现有登录身份 <span>由你的 SaaS 后端提供</span>
                    </summary>
                    <p>后端为已登录用户签发短期 Support Token。这里只配置公钥，不需要提供登录私钥。</p>
                    <label>
                      Token 签发者（Issuer）
                      <input
                        value={issuer}
                        onChange={(e) => setIssuer(e.target.value)}
                        placeholder={origin || 'https://app.example.com'}
                      />
                    </label>
                    <label>
                      Ed25519 公钥集（JWKS）
                      <textarea
                        required
                        rows={5}
                        value={jwks}
                        onChange={(e) => setJwks(e.target.value)}
                        placeholder={'{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"support-1","x":"..."}]}'}
                      />
                    </label>
                    <small>Audience 固定为 agent18:support；Token 最长有效期 10 分钟。</small>
                  </details>
                )}
                {project && (
                  <div className="setup-inline-note">
                    <span>✓</span>
                    <p>
                      已配置项目 <b>{project.key}</b>，使用已登记的公钥验证客户身份。
                    </p>
                  </div>
                )}
              </section>
              <div className="setup-actions">
                <span>配置可随时继续完善</span>
                <button className="experience-primary" disabled={busy}>
                  保存并继续 →
                </button>
              </div>
            </form>
          )}
          {step === 1 && (
            <>
              <section className="setup-card">
                <div className="card-title">
                  <div>
                    <span className="service-icon">✳</span>
                    <h3>兼容模型接口</h3>
                  </div>
                  <span className="experience-badge">
                    {state.model.configured ? '已配置密钥' : '等待连接'}
                  </span>
                </div>
                <div className="setup-form-grid">
                  <label>
                    API Base URL
                    <input
                      type="url"
                      value={baseUrl}
                      onChange={(e) => {
                        setBaseUrl(e.target.value);
                        setTested(false);
                      }}
                      placeholder="https://your-provider.example/v1"
                    />
                  </label>
                  <label>
                    模型名称
                    <input
                      value={modelName}
                      onChange={(e) => {
                        setModelName(e.target.value);
                        setTested(false);
                      }}
                      placeholder="填写供应商提供的模型 ID"
                    />
                  </label>
                  <label className="full-width">
                    API Key
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setTested(false);
                      }}
                      autoComplete="off"
                      placeholder={
                        state.model.configured ? '已保存密钥；留空保持当前密钥' : '输入你自己的 API Key'
                      }
                    />
                    <small>密钥只写入部署端配置，后续不会回显。</small>
                  </label>
                </div>
                <details className="setup-advanced">
                  <summary>兼容性设置</summary>
                  <label className="check-label">
                    <input type="checkbox" checked={legacy} onChange={(e) => setLegacy(e.target.checked)} />
                    供应商要求使用 max_tokens
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={jsonMode}
                      onChange={(e) => setJsonMode(e.target.checked)}
                    />
                    启用 JSON 输出模式
                  </label>
                  <p className="setup-model-note">
                    本地模型需要同时供宿主机与 Core 访问；Docker 容器中的 localhost 指向容器自身。
                  </p>
                </details>
                <div className="model-test">
                  <button
                    className="experience-secondary"
                    disabled={busy || !baseUrl || !modelName}
                    onClick={() =>
                      void act(async () => {
                        await request('model/test', modelBody);
                        setTested(true);
                        setNotice('模型接口已连通。可以保存并继续。');
                      })
                    }
                  >
                    {busy ? '正在连接…' : '测试连接'}
                  </button>
                  <span>{tested ? '✓ 连接成功' : '从配置服务发送一次简短请求，确认接口可用。'}</span>
                </div>
              </section>
              <div className="setup-actions">
                <button className="experience-text" onClick={() => setStep(2)}>
                  {state.model.configured ? '保持当前配置，继续' : '先用原文检索 →'}
                </button>
                <button
                  className="experience-primary"
                  disabled={busy || !baseUrl || !modelName}
                  onClick={() =>
                    void act(async () => {
                      await request('model', modelBody);
                      setApiKey('');
                      await refresh();
                      setStep(2);
                    })
                  }
                >
                  保存模型并继续 →
                </button>
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="source-toolbar">
                <div>
                  <b>{sources.length} 个知识来源</b>
                  <small>代码默认内部可见，产品文档可面向客户发布。</small>
                </div>
                <div>
                  <button className="experience-secondary" onClick={() => addSource('directory')}>
                    ＋ 文档目录
                  </button>
                  <button className="experience-secondary" onClick={() => addSource('git')}>
                    ＋ Git 仓库
                  </button>
                </div>
              </div>
              {!sources.length && (
                <section className="setup-card source-empty">
                  <span>▤</span>
                  <h3>从已有资料开始</h3>
                  <p>添加产品文档目录或代码仓库，无需重写一套知识库。</p>
                  <button className="experience-primary" onClick={() => addSource('directory')}>
                    添加第一个来源
                  </button>
                </section>
              )}
              {sources.map((source, i) => (
                <section className="setup-card source-card" key={source.id}>
                  <div className="source-card-title">
                    <span className="service-icon">{source.kind === 'git' ? '⌘' : '▤'}</span>
                    <input
                      aria-label={`来源 ${i + 1} 名称`}
                      value={source.name}
                      onChange={(e) => updateSource(i, { name: e.target.value })}
                    />
                    <button
                      className="experience-text"
                      onClick={() => setSources((v) => v.filter((_, n) => n !== i))}
                    >
                      移除
                    </button>
                  </div>
                  <div className="setup-form-grid">
                    <label className="full-width">
                      {source.kind === 'git' ? 'Git 仓库地址' : '部署机器上的目录'}
                      <input
                        value={source.location}
                        onChange={(e) => updateSource(i, { location: e.target.value })}
                        placeholder={
                          source.kind === 'git'
                            ? 'git@github.com:your-org/your-saas.git'
                            : '/srv/your-saas/docs'
                        }
                      />
                    </label>
                    {source.kind === 'git' && (
                      <label>
                        分支或版本
                        <input
                          value={source.ref}
                          onChange={(e) => updateSource(i, { ref: e.target.value })}
                        />
                      </label>
                    )}
                    <label>
                      知识受众
                      <select
                        value={source.audience}
                        onChange={(e) => updateSource(i, { audience: e.target.value as Source['audience'] })}
                      >
                        <option value="internal">内部知识 · 仅部署者</option>
                        <option value="customer">客户知识 · 发布后可见</option>
                      </select>
                    </label>
                    <label>
                      文件范围
                      <input
                        value={source.include.join(', ')}
                        onChange={(e) =>
                          updateSource(i, {
                            include: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="**/*.md, **/*.txt"
                      />
                    </label>
                  </div>
                  <div className="source-footer">
                    {source.audience === 'internal'
                      ? '内部来源不会被返回到客户网站。'
                      : '发布前可检查生成内容；默认对该项目所有已接入租户可见。'}
                  </div>
                </section>
              ))}
              <div className="generation-choice">
                <div>
                  <h3>如何整理知识？</h3>
                  <p>原文模式无需模型，也能形成目录和可追溯引用。</p>
                </div>
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  <option value="extractive">原文索引 · 不调用模型</option>
                  <option value="model" disabled={!state.model.configured}>
                    模型整理 · 自动归纳内容
                  </option>
                </select>
              </div>
              <div className="setup-actions">
                <button className="experience-text" onClick={() => setStep(4)}>
                  稍后接入知识
                </button>
                <button
                  className="experience-primary"
                  disabled={
                    busy ||
                    !sources.length ||
                    sources.some((s) => !s.location || !s.name || !s.include.length)
                  }
                  onClick={() =>
                    void act(async () => {
                      await request('knowledge', {
                        projectKey: activeKey,
                        mode,
                        maxModelCalls: 100,
                        sources,
                      });
                      await refresh();
                      setStep(3);
                    })
                  }
                >
                  保存来源并继续 →
                </button>
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <div className="build-summary">
                <span className="build-orbit">✳</span>
                <div>
                  <h2>{job?.state === 'running' ? job.phase : '把资料整理成可用的知识'}</h2>
                  <p>
                    {job?.state === 'running'
                      ? '正在读取和索引资料。你可以保留此页查看结果。'
                      : `${sources.length} 个来源 · ${mode === 'model' ? '模型整理' : '原文索引'} · ${published} 个最新版本已发布`}
                  </p>
                </div>
                <button
                  className="experience-primary"
                  disabled={busy || job?.state === 'running' || !sources.length}
                  onClick={() =>
                    void act(async () => {
                      await request('knowledge', {
                        projectKey: activeKey,
                        mode,
                        maxModelCalls: 100,
                        sources,
                      });
                      await refresh();
                      setJob(await request<Job>('build', {}));
                    })
                  }
                >
                  {job?.state === 'running' ? '构建中…' : latestBuilds.length ? '重新构建' : '开始构建'}
                </button>
              </div>
              {job?.error && (
                <div role="alert" className="experience-error">
                  {messages[job.error] ?? job.error}
                </div>
              )}
              <section className="setup-card">
                <div className="card-title">
                  <h3>构建与发布</h3>
                  <small>每个来源独立发布</small>
                </div>
                {latestBuilds.length ? (
                  latestBuilds.map((b) => (
                    <div className="build-row" key={b.build_id}>
                      <span className={'build-status ' + b.state}>
                        {b.state === 'ready' ? '✓' : b.state === 'building' ? '…' : '!'}
                      </span>
                      <div>
                        <b>{sources.find((s) => s.id === b.source_key)?.name ?? b.source_key}</b>
                        <small>
                          {b.report?.files ?? 0} 个文件 · {b.report?.articles ?? 0} 个条目 ·{' '}
                          {(b.report?.audience ?? b.audience) === 'internal' ? '内部知识' : '客户知识'}
                        </small>
                      </div>
                      <span className="experience-badge">
                        {b.enabled && b.active_build_id === b.build_id
                          ? '已发布'
                          : b.state === 'ready'
                            ? '待检查'
                            : '未完成'}
                      </span>
                      {b.state === 'ready' && (
                        <button
                          className="experience-secondary"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              setPreview(await request(`build/${b.build_id}/articles`));
                              setPreviewPage(0);
                              setSelectedBuild(b.build_id);
                            })
                          }
                        >
                          检查内容
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="build-empty">构建完成后，在这里检查文章与来源，再发布给用户。</div>
                )}
              </section>
              {preview && (
                <section className="setup-card preview-card">
                  <div className="card-title">
                    <h3>内容预览 · {preview.length} 个条目</h3>
                    <button className="experience-text" onClick={() => setPreview(undefined)}>
                      收起
                    </button>
                  </div>
                  <div className="preview-articles">
                    {preview.slice(previewPage * 50, (previewPage + 1) * 50).map((a, i) => (
                      <details key={i} open={i === 0}>
                        <summary>{a.title}</summary>
                        <p>{a.body}</p>
                        {a.provenance ? (
                          <div className="knowledge-provenance">
                            <small>
                              来源：{a.provenance.source.key} ·{' '}
                              {a.provenance.source.kind === 'git' ? 'Git commit' : '目录快照'}：
                              {a.provenance.source.revision}
                            </small>
                            <small>
                              读取时间：{new Date(a.provenance.snapshot.observedAt).toLocaleString()}
                            </small>
                            <small>
                              生成任务：{a.provenance.generation.runId} ·{' '}
                              {a.provenance.generation.mode === 'model'
                                ? `模型 ${a.provenance.generation.model?.name ?? a.provenance.generation.model?.identity ?? '未知'}`
                                : '原文提取，未调用模型'}
                            </small>
                            <small>部署版本：未知。以上来源版本不代表当前线上版本。</small>
                          </div>
                        ) : (
                          <small>历史构建未记录完整生成信息，保留原始来源引用。</small>
                        )}
                        {a.refs.map((r, n) => (
                          <small key={n}>
                            {r.path} · L{r.startLine}–{r.endLine}
                          </small>
                        ))}
                      </details>
                    ))}
                  </div>
                  {preview.length > 50 && (
                    <div className="preview-pagination">
                      <button
                        className="experience-secondary"
                        disabled={!previewPage}
                        onClick={() => setPreviewPage((p) => p - 1)}
                      >
                        上一页
                      </button>
                      <span>
                        {previewPage * 50 + 1}–{Math.min((previewPage + 1) * 50, preview.length)} /{' '}
                        {preview.length}
                      </span>
                      <button
                        className="experience-secondary"
                        disabled={(previewPage + 1) * 50 >= preview.length}
                        onClick={() => setPreviewPage((p) => p + 1)}
                      >
                        下一页
                      </button>
                    </div>
                  )}
                  <div className="publish-footer">
                    <p>确认内容适合所选受众后，发布这一版本。</p>
                    <button
                      className="experience-primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await request('publish', { buildId: selectedBuild });
                          await refresh();
                          setPreview(undefined);
                          setNotice('该来源已发布。完成配置后，网站即可使用最新知识。');
                        })
                      }
                    >
                      确认发布此版本
                    </button>
                  </div>
                </section>
              )}
              <div className="setup-actions">
                <button className="experience-text" onClick={() => setStep(2)}>
                  ← 调整来源
                </button>
                <button className="experience-primary" onClick={() => setStep(4)}>
                  继续配置网站入口 →
                </button>
              </div>
            </>
          )}
          {step === 4 && (
            <>
              <div className="entry-choices">
                {(
                  [
                    ['floating', '◉', '浮动助手', '右下角常驻入口，不占用业务页面'],
                    ['inline', '▣', '嵌入区块', '放进帮助中心或业务页面指定位置'],
                    ['page', '↗', '独立支持页', '在新页面里集中提问、查资料和办事'],
                  ] as const
                ).map(([id, icon, title, desc]) => (
                  <button
                    key={id}
                    className={entry === id ? 'entry-choice selected' : 'entry-choice'}
                    onClick={() => setEntry(id)}
                  >
                    <span>{icon}</span>
                    <b>{title}</b>
                    <small>{desc}</small>
                  </button>
                ))}
              </div>
              <section className="setup-card integration-card">
                <div className="card-title">
                  <h3>你的接入代码</h3>
                  <button
                    className="experience-secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(snippet)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        })
                        .catch(() => setError('请直接选择并复制下方代码。'))
                    }
                  >
                    {copied ? '已复制 ✓' : '复制代码'}
                  </button>
                </div>
                <label className="core-url-field">
                  agent18 对外访问地址
                  <input
                    type="url"
                    value={setupBase}
                    onChange={(e) => setSetupBase(e.target.value.replace(/\/$/, ''))}
                    placeholder="https://support.example.com"
                  />
                  <small>使用完整 Origin（协议、域名和端口）；接入代码会同步更新。</small>
                </label>
                <pre>{snippet}</pre>
                <div className="integration-checklist">
                  <span>1. 使用实际部署域名</span>
                  <span>2. 后端实现 /api/support-token</span>
                  <span>3. 使用已登记的网站 Origin</span>
                </div>
              </section>
              <section className="setup-card execution-explainer">
                <span className="service-icon">↔</span>
                <div>
                  <h3>业务代操作，怎样发生？</h3>
                  <p>
                    助手通过你的业务 API 办事。前端展示预览并获取用户确认，agent18
                    服务端携带用户的短期身份调用 SaaS；SaaS 再检查对象权限、业务状态并执行。
                  </p>
                  <div className="execution-chain">
                    <span>用户提出需求</span>
                    <i>→</i>
                    <span>预览并确认</span>
                    <i>→</i>
                    <span>SaaS 校验与执行</span>
                    <i>→</i>
                    <span>返回业务回执</span>
                  </div>
                  <small>
                    此版本不自动点击网页。业务接口需要显式注册；不确定结果只查回执，不重复发送写操作。
                  </small>
                </div>
              </section>
              <div className="setup-actions">
                <a
                  className="experience-text"
                  href="http://localhost:4319/example"
                  target="_blank"
                  rel="noreferrer"
                >
                  预览接入效果 ↗
                </a>
                <button
                  className="experience-primary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await request<{ applied: boolean }>('apply', {
                        displayName: name,
                        coreUrl: setupBase,
                      });
                      setApplied(result.applied);
                      await refresh();
                      setNotice(
                        result.applied
                          ? '配置已生效，助手已准备好接入你的网站。'
                          : '配置已保存，请重启 Core 使设置生效。',
                      );
                    })
                  }
                >
                  {busy ? '正在应用配置…' : '保存并完成初始化 ✓'}
                </button>
              </div>
              {applied && (
                <div className="setup-complete">
                  <span>✓</span>
                  <div>
                    <h2>你的工作空间准备好了</h2>
                    <p>下一步，把助手接入真实网站，或先打开示例体验。</p>
                  </div>
                  <a
                    href="http://localhost:4319/example"
                    className="experience-primary"
                    target="_blank"
                    rel="noreferrer"
                  >
                    体验浮动助手 ↗
                  </a>
                </div>
              )}
            </>
          )}
        </div>
        <footer className="experience-footer">agent18 · 配置保存在你的部署环境中</footer>
      </main>
    </div>
  );
}
