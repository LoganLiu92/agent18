import type { Agent18 } from './index.js';
import type { ActionProposal, ActionDefinition, BusinessQuery } from '@agent18/contracts';
export type AssistantOptions = {
  title?: string;
  /** Optional CSP nonce for the isolated widget stylesheet. */
  nonce?: string;
  onOpenPage?: () => void;
  /** Refresh host-owned UI after a verified successful business receipt. */
  onActionComplete?: (proposal: ActionProposal) => void;
};
const styles = `
:host{all:initial;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#203d38;color-scheme:light;display:block}*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;color:inherit}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #177e69;outline-offset:3px}[hidden]{display:none!important}.assistant{background:#fff;border:1px solid #dfe8e2;border-radius:20px;overflow:hidden;display:flex;flex-direction:column;height:650px;max-height:100%;box-shadow:0 14px 50px #19372d0d}header{display:flex;align-items:center;gap:11px;padding:18px 20px;color:#fff;background:#173e34;flex-shrink:0}header strong{display:block;font-size:15px}header small{color:#b7d6c9;font-size:10px;display:block;margin-top:3px}.mark{height:36px;width:36px;display:grid;place-items:center;border:1px solid #527669;border-radius:12px;font-weight:700;letter-spacing:-1px;background:#2f5548}.head-actions{margin-left:auto;display:flex;gap:5px}.icon{background:transparent;border:0;padding:5px;color:inherit;font-size:21px;line-height:1}.chat-feed{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:24px 17px;background:#f7f9f6;scrollbar-width:thin}.chat-message{display:flex;gap:8px;align-items:flex-start;margin:0 0 23px}.message-mark{flex:0 0 25px;height:25px;border-radius:8px;color:#36735b;background:#e4eee5;display:grid;place-items:center;font-size:15px;margin-top:3px}.bubble{min-width:0;max-width:calc(100% - 33px);overflow-wrap:anywhere}.bubble>p{white-space:pre-wrap;margin:0 0 10px;font-size:13px;line-height:1.85}.from-user{justify-content:flex-end;margin:6px 0 23px}.from-user .bubble{background:#e2eee4;border:1px solid #d7e6db;border-radius:14px 14px 3px 14px;padding:9px 13px}.from-user .bubble>p{margin:0}.chat-choices{display:flex;flex-wrap:wrap;gap:7px;margin:11px 0 0}.chip{background:white;border:1px solid #dce6dd;border-radius:9px;padding:7px 10px;font-size:11px;text-align:left;line-height:1.6}.chip:hover{background:#eef5ed;border-color:#afc5b3}.bubble>.chip,.bubble>.primary{margin:9px 7px 0 0}.primary{background:#22694e;color:#fff;border:1px solid #22694e;border-radius:9px;padding:9px 13px;font-size:12px;font-weight:550}.data-card{border:1px solid #e0e8df;background:#fff;border-radius:10px;padding:11px 12px;margin:10px 0}.data-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:4px 0}.data-row span{color:#7b8c81}.data-row b{text-align:right;font-weight:550;overflow-wrap:anywhere}.data-card p{white-space:pre-wrap;margin:6px 0;font-size:12px}.bubble small{display:block;font-size:10px;line-height:1.7;color:#85958a;margin-top:8px}.bubble details{margin:10px 0;border:1px solid #e0e8df;background:white;border-radius:9px;padding:10px 12px;font-size:11px}.bubble summary{cursor:pointer;line-height:1.7;color:#55755e}.bubble details p{white-space:pre-wrap;font-size:12px;line-height:1.8}.status{font-size:11px;background:#e4efe4;color:#447350;border-radius:5px;padding:3px 7px;display:inline-block}.typing{font-size:11px;color:#789181;padding:0 0 12px 33px;letter-spacing:1px}.composer{display:flex;align-items:flex-end;gap:10px;border-top:1px solid #e6ebe4;background:#fff;margin:0;padding:14px 17px 5px;flex-shrink:0}.composer textarea{border:0;box-shadow:none;outline:none!important;resize:none;width:100%;min-width:0;line-height:1.8;max-height:120px;padding:4px 0;color:#203d38;font-size:13px;background:transparent}.composer textarea::placeholder{color:#94a296}.send{background:#22694e;color:white;border:0;border-radius:11px;width:37px;height:37px;flex-shrink:0;font-size:23px;line-height:1;display:grid;place-items:center;margin-bottom:4px}.bubble form{display:grid;gap:10px;margin:12px 0}.bubble label{display:grid;gap:6px;font-size:11px;color:#687c6e}.bubble input,.bubble textarea{width:100%;min-width:0;border:1px solid #dce5dd;border-radius:8px;background:white;padding:9px 10px;font-size:12px;resize:vertical;color:#203d38}footer{padding:5px 12px 11px;text-align:center;font-size:9px;color:#9aa69e;background:#fff;letter-spacing:.3px;flex-shrink:0}.launcher{width:56px;height:56px;border-radius:19px;background:#22694e;color:#fff;border:1px solid #ffffff30;box-shadow:0 5px 25px #164e3540;display:flex;align-items:center;justify-content:center;font-size:27px}.floating{width:min(400px,calc(100% - 32px));pointer-events:none;position:fixed;bottom:24px;right:24px;z-index:2147483000;display:flex;align-items:flex-end;flex-direction:column;gap:14px}.floating>*{pointer-events:auto}.floating.left{right:auto;left:24px;align-items:flex-start}.panel{width:100%;height:min(650px,calc(100dvh - 108px));box-shadow:0 22px 80px #172d3429;border-radius:20px;outline:0}.panel .assistant{height:100%}@media(max-width:480px){.floating{bottom:16px;right:16px}.floating.left{left:16px}.panel{height:min(650px,calc(100dvh - 104px))}header{padding:16px}.chat-feed{padding:19px 13px}.composer{padding:12px 14px 4px}}
`;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
};
function frame(target: HTMLElement, options: AssistantOptions) {
  const host = element('div');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = element('style', styles);
  if (options.nonce) style.nonce = options.nonce;
  shadow.append(style);
  target.append(host);
  return { host, shadow };
}
function mountContents(
  target: ShadowRoot | HTMLElement,
  client: Agent18,
  options: AssistantOptions,
  onClose?: () => void,
) {
  const root = element('section', '', 'assistant');
  root.setAttribute('aria-label', options.title ?? '产品助手');
  const header = element('header'),
    heading = element('div'),
    headActions = element('div', '', 'head-actions');
  heading.append(
    element('strong', options.title ?? '产品助手'),
    element('small', '陪你找答案，也帮你把事情办好'),
  );
  header.append(element('span', 'a18', 'mark'), heading, headActions);
  const icon = (label: string, text: string, fn: () => void) => {
    const button = element('button', text, 'icon');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.onclick = fn;
    headActions.append(button);
  };
  if (options.onOpenPage) icon('打开独立支持页', '↗', options.onOpenPage);
  if (onClose) icon('关闭助手', '×', onClose);
  const feed = element('div', '', 'chat-feed');
  feed.setAttribute('role', 'log');
  feed.setAttribute('aria-label', '对话记录');
  feed.setAttribute('aria-live', 'polite');
  const composer = element('form', '', 'composer'),
    input = element('textarea'),
    send = element('button', '↑', 'send');
  input.rows = 2;
  input.maxLength = 1000;
  input.required = true;
  input.placeholder = '问一个问题，或告诉我你想做什么…';
  input.setAttribute('aria-label', '发送给助手');
  send.type = 'submit';
  send.setAttribute('aria-label', '发送消息');
  composer.append(input, send);
  root.append(header, feed, composer, element('footer', 'agent18 · 业务变更始终由你确认'));
  target.append(root);
  let alive = true,
    busy = false,
    definitions: ActionDefinition[] = [],
    queries: BusinessQuery[] = [];
  let pending: import('@agent18/contracts').AssistantTurn['pending'];
  let replyCase: string | undefined;
  let dismissPreview: (() => void) | undefined;
  const history: string[] = [],
    delivered = new Set<string>();
  const controls = new WeakMap<HTMLButtonElement, () => boolean>();
  const scroll = () => {
    feed.scrollTop = feed.scrollHeight;
  };
  function message(text: string, role: 'assistant' | 'user' = 'assistant') {
    const row = element('article', '', 'chat-message from-' + role),
      bubble = element('div', '', 'bubble');
    row.setAttribute('aria-label', role === 'user' ? '你' : '助手');
    if (role === 'assistant') row.append(element('span', '✳', 'message-mark'));
    if (text) bubble.append(element('p', text));
    row.append(bubble);
    feed.append(row);
    scroll();
    return bubble;
  }
  const control = (
    target: HTMLElement,
    text: string,
    fn: () => Promise<void> | void,
    valid = () => true,
    primary = false,
  ) => {
    const button = element('button', text, primary ? 'primary' : 'chip');
    button.type = 'button';
    controls.set(button, valid);
    button.disabled = busy || !valid();
    button.onclick = () => {
      if (valid()) void run(fn);
    };
    target.append(button);
    return button;
  };
  function enable() {
    for (const button of root.querySelectorAll<HTMLButtonElement>('button:not(.icon)'))
      button.disabled = busy || !(controls.get(button)?.() ?? true);
    for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))
      field.disabled = busy;
  }
  async function run(fn: () => Promise<void> | void) {
    if (!alive || busy) return;
    busy = true;
    enable();
    const loading = element('div', '正在处理…', 'typing');
    loading.setAttribute('role', 'status');
    feed.append(loading);
    scroll();
    try {
      await fn();
    } catch (e) {
      if (alive) {
        const code = e instanceof Error ? e.message : '';
        const errors: Record<string, string> = {
          BUSINESS_NOT_ACCESSIBLE: '这条记录不存在，或你没有查看权限。可以换一个编号再试。',
          ACTION_NEEDS_DETAILS: '还需要一些业务信息，我可以引导你补充。',
          MODEL_NOT_CONFIGURED: '当前可以检索资料和办理已接入的业务，请选择下一步。',
          RATE_LIMITED: '请求比较频繁，稍等片刻再发送就好。',
          UNAUTHENTICATED: '登录已失效，请回到业务系统重新登录后打开助手。',
          ACTION_EXPIRED: '预览已过期，请重新描述需求生成新预览。',
          ACTION_CONFIGURATION_CHANGED: '业务配置已更新，请重新生成预览。',
          BUSINESS_UNAVAILABLE: '业务系统暂时没有响应，可以稍后再试。',
          MODEL_TIMEOUT: '生成回答超时了，可以稍后重试，或将问题交给支持团队。',
        };
        const card = message(errors[code] ?? '这一步暂时没有完成。你可以补充说明后重试，或联系支持团队。');
        if (pending) control(card, '继续补充', () => resume(pending!));
        control(card, '联系支持', () => support());
      }
    } finally {
      loading.remove();
      busy = false;
      if (alive) {
        enable();
        scroll();
        input.focus();
      }
    }
  }
  function user(text: string) {
    message(text, 'user');
  }
  const ready = Promise.allSettled([client.listActions(), client.listBusinessQueries()]).then(([a, q]) => {
    if (!alive) return;
    if (a.status === 'fulfilled') definitions = a.value.actions;
    if (q.status === 'fulfilled') queries = q.value.queries;
  });
  function suggestions(card: HTMLElement, items: [string, () => void | Promise<void>][]) {
    const choices = element('div', '', 'chat-choices');
    for (const [label, action] of items) control(choices, label, action);
    card.append(choices);
  }
  async function help() {
    await ready;
    pending = undefined;
    replyCase = undefined;
    input.placeholder = '问一个问题，或告诉我你想做什么…';
    const card = message('可以直接告诉我你想了解什么，或从这些事情开始：');
    suggestions(
      card,
      queries.slice(0, 3).map((q) => [q.title, () => choose('query', q.id)]),
    );
    suggestions(
      card,
      definitions.slice(0, 2).map((a) => [a.title, () => choose('action', a.id)]),
    );
    if (queries.length > 3 || definitions.length > 2) {
      const more = element('details');
      more.append(element('summary', '更多可用服务'));
      suggestions(
        more,
        queries.slice(3).map((q) => [q.title, () => choose('query', q.id)]),
      );
      suggestions(
        more,
        definitions.slice(2).map((a) => [a.title, () => choose('action', a.id)]),
      );
      card.append(more);
    }
    suggestions(card, [
      [
        '我的问题与回复',
        () => {
          user('查看我的问题与回复');
          return showCases();
        },
      ],
      ['联系支持', () => support()],
    ]);
  }
  async function choose(kind: 'query' | 'action', id: string) {
    const d = (kind === 'query' ? queries : definitions).find((d) => d.id === id);
    if (!d) return;
    user(d.title);
    replyCase = undefined;
    history.push(d.title);
    history.splice(0, Math.max(0, history.length - 6));
    await resume({ kind, id, arguments: {} });
  }
  async function resume(next: NonNullable<typeof pending>) {
    await ready;
    const d = (next.kind === 'query' ? queries : definitions).find((d) => d.id === next.id);
    if (!d) {
      await help();
      return;
    }
    pending = next;
    const field = d.fields.find((f) => f.required && next.arguments[f.name] === undefined);
    if (field) {
      pending = { ...next, field: field.name };
      const current = pending;
      const card = message(`好，我们来${d.title}。请告诉我${field.label}。`);
      if (field.type === 'boolean' || field.enum) {
        const choices = element('div', '', 'chat-choices');
        for (const value of field.enum ?? ['true', 'false']) {
          const label = field.type === 'boolean' ? (value === 'true' ? '开启' : '关闭') : value;
          control(
            choices,
            label,
            async () => {
              user(label);
              await resume({
                ...next,
                arguments: {
                  ...next.arguments,
                  [field.name]: field.type === 'boolean' ? value === 'true' : value,
                },
              });
            },
            () => pending === current,
          );
        }
        card.append(choices);
      }
      control(
        card,
        '先不办这件事',
        () => {
          pending = undefined;
          message('好的。还想了解或办理什么？');
        },
        () => pending === current,
      );
      return;
    }
    if (next.kind === 'action') {
      const proposal = await client.prepareAction(d.id, next.arguments);
      if (!alive) return;
      pending = undefined;
      preview(proposal);
      return;
    }
    const result = await client.queryBusiness(d.id, next.arguments);
    if (!alive) return;
    pending = undefined;
    const card = message(
      result.rows.length ? `查到了，这是${d.title}的结果。` : '没有找到符合条件、且你有权限查看的记录。',
    );
    for (const record of result.rows) {
      const item = element('div', '', 'data-card');
      for (const column of result.columns) {
        const value = record[column.path],
          row = element('div', '', 'data-row');
        row.append(
          element('span', column.label),
          element(
            'b',
            value === null ? '—' : typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value),
          ),
        );
        item.append(row);
      }
      card.append(item);
    }
    card.append(
      element(
        'small',
        '业务实时响应 · ' +
          new Date(result.retrievedAt).toLocaleTimeString() +
          (result.truncated ? ' · 最多显示 50 条' : ''),
      ),
    );
    suggestions(card, [
      [
        '再查一次',
        () => {
          user('再查一次');
          return resume(next);
        },
      ],
      ['还可以做什么', help],
    ]);
  }
  function preview(proposal: ActionProposal) {
    dismissPreview?.();
    const card = message('我已准备好变更，请核对后确认。'),
      d = definitions.find((a) => a.id === proposal.actionId);
    let current = proposal,
      announced = false;
    const dismiss = () => {
      if (current.state !== 'proposed') return;
      current = { ...current, state: 'expired' };
      card.replaceChildren(element('p', '这项预览已收起，没有提交执行。'));
      if (dismissPreview === dismiss) dismissPreview = undefined;
    };
    dismissPreview = dismiss;
    const render = () => {
      card.replaceChildren(element('p', current.preview.summary));
      const args = element('div', '', 'data-card');
      for (const [name, value] of Object.entries(current.arguments)) {
        const row = element('div', '', 'data-row');
        row.append(
          element('span', d?.fields.find((f) => f.name === name)?.label ?? name),
          element('b', typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value)),
        );
        args.append(row);
      }
      card.append(args);
      const states = {
        proposed: '等待你确认',
        executing: '正在等待业务回执',
        uncertain: '结果待核对',
        succeeded: '操作成功',
        rejected: '业务系统拒绝了本次操作',
        expired: '预览已过期',
      };
      card.append(element('span', states[current.state], 'status'));
      if (current.result?.message) card.append(element('p', current.result.message));
      if (current.state === 'proposed') {
        card.append(element('small', '确认后，将以你的当前身份提交上面的变更。'));
        control(
          card,
          '确认执行',
          async () => {
            user('确认执行这项变更');
            current = await client.confirmAction(current.id);
            if (alive) render();
          },
          () => current.state === 'proposed',
          true,
        );
        control(card, '暂不执行', dismiss, () => current.state === 'proposed');
      } else if (['executing', 'uncertain'].includes(current.state)) {
        control(card, '核对执行结果', async () => {
          current = await client.reconcileAction(current.id);
          if (alive) render();
        });
        card.append(element('small', '只查询回执，不会重复提交变更。'));
      } else if (current.state === 'succeeded') {
        if (!delivered.has(current.id)) {
          delivered.add(current.id);
          try {
            options.onActionComplete?.(current);
          } catch {
            card.append(element('small', '业务已完成，请手动刷新原页面。'));
          }
        }
        if (!announced) {
          announced = true;
          const receipt = message(current.result?.message ?? '这项操作已完成。');
          suggestions(receipt, [
            ['查看最新业务状态', help],
            [
              '还有一个问题',
              () => {
                message('请继续说，我在。');
              },
            ],
          ]);
        }
      }
      enable();
      scroll();
    };
    render();
  }
  async function knowledge(query: string) {
    const result = await client.askKnowledge(query);
    if (!alive) return;
    const card = message(result.answer ?? result.notice ?? '暂时没有找到足够资料，可以补充说明。');
    for (const citation of result.citations) {
      const details = element('details');
      details.append(
        element('summary', citation.title),
        element('p', citation.excerpt),
        element('small', citation.source),
      );
      card.append(details);
    }
    suggestions(card, [
      [
        '继续解释',
        () => {
          input.value = '请继续解释这个问题';
          input.focus();
        },
      ],
      ['问题还没解决', () => support()],
    ]);
  }
  async function showCases() {
    pending = undefined;
    const result = await client.listCases();
    if (!alive) return;
    const card = message(
      result.cases.length
        ? '这是你最近提交的问题，选择一个就能继续跟进。'
        : '你还没有提交过问题。需要的话，我可以帮你整理给支持团队。',
    );
    const older = element('details');
    older.append(element('summary', `更早的问题（${Math.max(0, result.cases.length - 5)}）`));
    result.cases.forEach((c, index) =>
      control(index < 5 ? card : older, (c.status === 'resolved' ? '✓ ' : '◎ ') + c.title, () =>
        showCase(c.id),
      ),
    );
    if (result.cases.length > 5) card.append(older);
    control(card, '提交新问题', () => support());
  }
  async function showCase(id: string) {
    const [detail, thread] = await Promise.all([client.getCase(id), client.caseMessages(id)]);
    if (!alive) return;
    const card = message(detail.case.title);
    card.append(
      element('span', detail.case.status === 'resolved' ? '已解决' : '跟进中', 'status'),
      element('p', detail.case.description),
    );
    for (const m of thread.messages) {
      const row = element('div', '', 'data-card');
      row.append(element('small', m.author === 'support' ? '支持团队' : '你'), element('p', m.body));
      card.append(row);
    }
    for (const e of detail.evidence) {
      const ref = element('details');
      ref.append(element('summary', e.title), element('p', e.excerpt));
      card.append(ref);
    }
    suggestions(card, [
      [
        '回复这个问题',
        () => {
          replyCase = id;
          pending = undefined;
          input.placeholder = '补充说明，或回复支持团队…';
          message('接下来这条消息会作为补充说明发送到这个问题。');
        },
      ],
      ['刷新进展', () => showCase(id)],
      [
        detail.case.status === 'resolved' ? '重新打开问题' : '问题已解决',
        async () => {
          await client.setCaseStatus(id, detail.case.status === 'resolved' ? 'needs_human' : 'resolved');
          await showCase(id);
        },
      ],
    ]);
    control(card, '返回助手对话', () => {
      replyCase = undefined;
      input.placeholder = '问一个问题，或告诉我你想做什么…';
      message('好的，我们继续。');
    });
  }
  function support() {
    pending = undefined;
    replyCase = undefined;
    const card = message('我可以把问题交给支持团队。先核对一下要提交的内容：'),
      form = element('form'),
      title = element('input'),
      description = element('textarea');
    title.required = true;
    title.minLength = 3;
    title.maxLength = 180;
    title.value = (history.at(-1) ?? '').slice(0, 180);
    title.placeholder = '用一句话描述问题';
    description.required = true;
    description.minLength = 3;
    description.maxLength = 4000;
    description.value = history.join('\n');
    description.rows = 3;
    const titleLabel = element('label', '问题标题'),
      bodyLabel = element('label', '问题说明');
    titleLabel.append(title);
    bodyLabel.append(description);
    const submit = element('button', '确认提交给支持团队', 'primary');
    submit.type = 'submit';
    form.append(titleLabel, bodyLabel, submit);
    card.append(form);
    let submitted = false,
      key = crypto.randomUUID();
    controls.set(submit, () => !submitted);
    form.oninput = () => {
      key = crypto.randomUUID();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (submitted) return;
      void run(async () => {
        const result = await client.reportCase({ title: title.value, description: description.value }, key);
        if (!alive) return;
        submitted = true;
        form.remove();
        card.append(element('p', '问题已记录，之后可以在对话里查看进展和回复。'));
        control(card, '查看问题进展', () => showCase(result.case.id));
      });
    };
  }
  async function turn(text: string) {
    user(text);
    await ready;
    if (replyCase) {
      if (/^(取消|返回助手|算了)[。！!\s]*$/.test(text)) {
        replyCase = undefined;
        input.placeholder = '问一个问题，或告诉我你想做什么…';
        message('好的，已返回助手对话，没有发送补充说明。');
        return;
      }
      const id = replyCase;
      await client.addCaseMessage(id, text, crypto.randomUUID());
      replyCase = undefined;
      input.placeholder = '问一个问题，或告诉我你想做什么…';
      await showCase(id);
      return;
    }
    if (/^(确认|确认执行|好的|执行吧)[。！!\s]*$/.test(text) && !pending) {
      message('如需办理，请点击对应预览卡片中的“确认执行”，这样能明确确认的是哪一项变更。');
      return;
    }
    const route = await client.routeConversation({
      message: text,
      history: history.slice(-6),
      ...(pending ? { pending } : {}),
    });
    if (!alive) return;
    history.push(text.slice(0, 500));
    history.splice(0, Math.max(0, history.length - 6));
    if (route.kind === 'query' || route.kind === 'action') {
      await resume({ ...route });
      return;
    }
    pending = undefined;
    if (route.kind === 'knowledge') await knowledge(route.query);
    else if (route.kind === 'help') await help();
    else if (route.kind === 'cases') await showCases();
    else if (route.kind === 'support') support();
    else {
      dismissPreview?.();
      message('好的，这件事先放下。你可以继续提问；尚未确认的预览不会自动执行。');
    }
  }
  composer.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    void run(() => turn(text));
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  };
  const hello = message('你好，我是你的产品助手。\n想了解什么，或者需要我帮你做点什么？');
  suggestions(hello, [
    ['查一下我的业务', help],
    ['如何开始使用？', () => turn('如何开始使用？')],
    [
      '我的问题进展',
      () => {
        user('我的问题进展');
        return showCases();
      },
    ],
  ]);
  return {
    focus() {
      input.focus();
    },
    destroy() {
      alive = false;
      history.length = 0;
      pending = undefined;
      replyCase = undefined;
      root.remove();
    },
  };
}

/** Style-isolated assistant in an element owned by the host application. */
export function mountAssistant(target: HTMLElement, client: Agent18, options: AssistantOptions = {}) {
  const { host, shadow } = frame(target, options);
  const content = mountContents(shadow, client, options);
  return {
    destroy() {
      content.destroy();
      host.remove();
    },
  };
}
/** Floating entry mounted without collecting or operating the host page DOM. */
export function mountFloatingAssistant(
  client: Agent18,
  options: AssistantOptions & { position?: 'left' | 'right' } = {},
) {
  const { host, shadow } = frame(document.body, options);
  const floating = element('div', '', `floating ${options.position === 'left' ? 'left' : ''}`),
    panel = element('div', '', 'panel'),
    launcher = element('button', '✳', 'launcher');
  panel.id = 'agent18-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', options.title ?? '产品助手');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', '打开产品助手');
  launcher.setAttribute('aria-controls', panel.id);
  launcher.setAttribute('aria-expanded', 'false');
  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    launcher.textContent = open ? '×' : '✳';
    launcher.setAttribute('aria-label', open ? '关闭产品助手' : '打开产品助手');
    launcher.setAttribute('aria-expanded', String(open));
    if (open) content.focus();
    else launcher.focus();
  };
  const content = mountContents(panel, client, options, () => setOpen(false));
  launcher.onclick = () => setOpen(!!panel.hidden);
  floating.onkeydown = (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      e.preventDefault();
      setOpen(false);
    }
  };
  floating.append(panel, launcher);
  shadow.append(floating);
  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      content.destroy();
      host.remove();
    },
  };
}
