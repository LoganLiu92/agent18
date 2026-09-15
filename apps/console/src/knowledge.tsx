import { useEffect, useState, type FormEvent } from 'react';
import { Agent18, type KnowledgeCatalogue, type KnowledgeArticle, type AnswerResult } from '@agent18/web-sdk';
const labels: Record<string, string> = {
  overview: '系统概览',
  architecture: '架构与模块',
  api: '接口与数据',
  workflows: '业务流程',
  configuration: '配置与部署',
  troubleshooting: '问题排查',
};
export function KnowledgeHub({ client, model }: { client: Agent18; model: boolean }) {
  const [catalogue, setCatalogue] = useState<KnowledgeCatalogue>({ articles: [], truncated: false });
  const [category, setCategory] = useState('all'),
    [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [article, setArticle] = useState<KnowledgeArticle>(),
    [answer, setAnswer] = useState<AnswerResult>();
  useEffect(() => {
    let active = true;
    void client
      .knowledgeCatalogue()
      .then((r) => {
        if (active) setCatalogue(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [client]);
  async function ask(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setArticle(undefined);
    try {
      setAnswer(await client.askKnowledge(query));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="knowledge-workspace">
      <section className="panel knowledge-tree">
        <h2>
          知识目录 <span className="badge neutral">{catalogue.articles.length}</span>
        </h2>
        <p className="muted-text">按当前身份展示已发布的知识。</p>
        <div className="category-tabs">
          {['all', ...Object.keys(labels)].map((c) => (
            <button className={category === c ? 'active' : ''} key={c} onClick={() => setCategory(c)}>
              {labels[c] ?? '全部'}
            </button>
          ))}
        </div>
        <div className="article-list">
          {catalogue.articles
            .filter((a) => category === 'all' || a.category === category)
            .map((a) => (
              <button
                key={a.id}
                className={article?.id === a.id ? 'active' : ''}
                onClick={() => {
                  setError('');
                  void client
                    .knowledgeArticle(a.id)
                    .then(setArticle)
                    .catch((e) => setError(e.message));
                }}
              >
                <small>{labels[a.category] ?? a.category}</small>
                {a.title}
              </button>
            ))}
        </div>
        {!catalogue.articles.length && (
          <p className="muted-text">暂无已发布目录。演示资料仍可通过搜索查看。</p>
        )}
        {catalogue.truncated && <p>目录显示前 500 条；可通过检索查找其余内容。</p>}
      </section>
      <section className="panel knowledge-reader">
        <span className="eyebrow">KNOWLEDGE / ASK & EXPLORE</span>
        <h2>从资料找到答案</h2>
        <p className="muted-text">
          {model ? '模型基于可见资料回答，并提供引用。' : '当前提供原文检索；配置模型后可生成带引用的回答。'}
        </p>
        <form className="search-form" onSubmit={ask}>
          <input
            aria-label="知识问题"
            required
            minLength={2}
            maxLength={300}
            placeholder="例如：agent18 如何接入现有网站？"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="button primary" disabled={busy}>
            {busy ? '查询中…' : model ? '提问' : '检索'}
          </button>
        </form>
        {error && <p role="alert">请求未完成：{error}</p>}
        {article ? (
          <article className="knowledge-document">
            <span className="badge blue">{labels[article.category]}</span>
            <h2>{article.title}</h2>
            <div className="prose-source">{article.body}</div>
            <h4>来源依据</h4>
            {article.references.map((r, i) => (
              <p className="source-reference" key={i}>
                {r.path} · L{r.startLine}–{r.endLine}
                <small>版本 {r.revision.slice(0, 12)}</small>
              </p>
            ))}
          </article>
        ) : answer ? (
          <div className="search-results">
            <span className="badge blue">{answer.mode === 'model' ? '模型回答' : '原文检索'}</span>
            {answer.answer && <div className="answer-text">{answer.answer}</div>}
            <p className="muted-text">{answer.notice}</p>
            {answer.citations.map((c) => (
              <article className="citation" key={c.id}>
                <small>版本 {c.version.slice(0, 12)}</small>
                <h3>{c.title}</h3>
                <p>{c.excerpt}</p>
                <code>{c.source}</code>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">
            <h3>知识随系统一起生长</h3>
            <p>代码与文档经过索引、整理和发布，成为可追溯的业务知识。</p>
          </div>
        )}
      </section>
    </div>
  );
}
