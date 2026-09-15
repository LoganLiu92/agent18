import { useEffect, useState } from 'react';
import { ProductMark } from './setup.js';
import './experience.css';
export function Welcome() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const [state, setState] = useState<{ setupCompleted: boolean; displayName: string; version: string }>();
  useEffect(() => {
    void fetch('/public/installation')
      .then((r) => r.json())
      .then(setState)
      .catch(() => {});
  }, []);
  return (
    <div className="welcome-shell">
      <header className="welcome-header">
        <ProductMark />
        <nav>
          <a href="https://github.com/LoganLiu92/agent18" target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          <a href="/docs">开发者文档 →</a>
        </nav>
      </header>
      <main className="welcome-main">
        <section className="welcome-hero">
          <div>
            <span className="experience-kicker">YOUR KNOWLEDGE. YOUR MODEL. YOUR PRODUCT.</span>
            <h1>
              让成熟的系统，
              <br />
              拥有懂业务的助手。
            </h1>
            <p>
              已有的代码与文档，是最好的起点。把知识、业务和用户身份连接起来，让帮助自然地出现在你的网站里。
            </p>
            <div className="welcome-cta">
              <a href={local ? 'http://localhost:4321/setup' : '/docs'} className="experience-primary">
                {local ? (state?.setupCompleted ? '进入接入工作台' : '开始初始化配置') : '阅读接入指南'}{' '}
                <span>→</span>
              </a>
              <a
                href={local ? 'http://localhost:4319/example' : '/docs/guides/integration'}
                className="experience-secondary"
                target="_blank"
                rel="noreferrer"
              >
                {local ? '体验网站浮动助手 ↗' : '网站接入方式 ↗'}
              </a>
            </div>
            <small>
              {state?.setupCompleted
                ? '工作空间已初始化，可继续调整模型、知识和接入方式。'
                : '首次使用，从项目、模型与知识来源开始，逐步完成接入。'}
            </small>
          </div>
          <div className="welcome-preview">
            <div className="preview-browser">
              <i />
              <i />
              <i />
              <span>你的 SaaS 网站</span>
            </div>
            <div className="preview-business">
              <div className="preview-side">
                <span />
                <span />
                <span />
              </div>
              <div className="preview-orders">
                <b>订单中心</b>
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className="preview-conversation">
              <header>
                <span className="mini-brand">a18</span>
                <div>
                  <b>产品助手</b>
                  <small>随时帮你找到下一步</small>
                </div>
                <span>⋯</span>
              </header>
              <p>你好，有什么可以帮你？</p>
              <div className="preview-question">如何查看订单处理进度？</div>
              <div className="preview-answer">
                你可以在订单详情查看最新状态。<small>▤ 订单使用指南 · 有来源的回答</small>
              </div>
              <div className="preview-compose">
                描述问题或需要完成的操作 <span>↑</span>
              </div>
            </div>
            <div className="preview-launcher">✳</div>
            <span className="preview-caption">接入形态示意 · 实际回答取决于你的知识与模型</span>
          </div>
        </section>
        <section className="welcome-capabilities">
          {[
            ['01', '连接现有知识', '从代码与文档生成目录，引用可追溯到文件和版本。'],
            ['02', '按用户权限办事', '先预览，再确认，由你的业务 API 校验并执行。'],
            ['03', '出现在需要的地方', '浮动助手、嵌入区块与独立支持页，自由选择。'],
          ].map(([n, t, d]) => (
            <article key={n}>
              <span>{n}</span>
              <h3>{t}</h3>
              <p>{d}</p>
            </article>
          ))}
        </section>
        <section className="welcome-next">
          <div>
            <span className="experience-kicker">GET STARTED</span>
            <h2>
              {state?.setupCompleted ? `${state.displayName} 已准备好继续接入` : '从安装到接入，一步一步来'}
            </h2>
            <p>部署者在初始化向导中配置系统；网站用户通过自己的登录身份使用助手。</p>
          </div>
          <div className="welcome-checks">
            <span>✓ 项目与用户身份</span>
            <span>✓ 模型连接测试</span>
            <span>✓ 知识构建与发布</span>
            <span>✓ 入口与接入代码</span>
          </div>
        </section>
        {local && (
          <p className="welcome-local-note">
            初始化配置服务位于部署机器的本地端口 4321。若尚未启动，在终端执行 <code>pnpm setup:ui</code>
            ；全新安装可直接执行 <code>pnpm start</code>。
          </p>
        )}
      </main>
      <footer className="experience-footer">
        agent18 {state?.version ?? '0.6.0'} · Open source, built for your SaaS.
      </footer>
    </div>
  );
}
