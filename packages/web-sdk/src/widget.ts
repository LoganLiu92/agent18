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
:host{all:initial;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#203d38;color-scheme:light;display:block}*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer;color:inherit}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #177e69;outline-offset:3px}[hidden]{display:none!important}.assistant{background:#fff;border:1px solid #e2e9e5;border-radius:20px;overflow:hidden;display:flex;flex-direction:column;min-height:530px;height:100%;box-shadow:0 14px 50px #19372d0d}header{display:flex;align-items:center;gap:11px;padding:20px 22px;background:#173e34;color:#fff}header strong{display:block;font-size:16px;letter-spacing:.2px}header small{color:#b7d6c9;font-size:11px;display:block;margin-top:2px}.mark{height:37px;width:37px;display:grid;place-items:center;border:1px solid #527669;border-radius:12px;font-weight:700;letter-spacing:-1px;background:#2f5548}.head-actions{margin-left:auto;display:flex;gap:6px}.icon{background:transparent;border:0;padding:6px;color:inherit;font-size:21px;line-height:1}.tabs{display:flex;gap:5px;padding:10px 17px;border-bottom:1px solid #edf0ed;background:#fff}.tab{flex:1;background:none;border:0;border-radius:9px;padding:9px 5px;color:#7a8782;font-weight:550;font-size:13px}.tab[aria-selected=true]{background:#eaf4ef;color:#1c6a50}.body{padding:22px;overflow:auto;flex:1;min-height:0;background:linear-gradient(#fbfcfa,#fff 220px)}.intro{margin:0 0 20px}.eyebrow{color:#819188;font-size:10px;letter-spacing:1.5px}.intro h2{font-size:21px;line-height:1.4;margin:6px 0 8px;font-weight:650;letter-spacing:-.5px}.intro p{font-size:12px;color:#7f8e86;margin:0}.chips{display:flex;gap:7px;flex-wrap:wrap;margin:18px 0}.chip{background:#fff;border:1px solid #dee8e1;padding:6px 10px;border-radius:7px;font-size:12px;color:#64776d}form{display:grid;gap:13px}label{display:grid;gap:6px;font-size:12px;font-weight:550;color:#52685d}input,select,textarea{width:100%;min-width:0;border:1px solid #dce5dd;border-radius:9px;background:white;color:#203d38;padding:10px 11px;resize:vertical}input::placeholder,textarea::placeholder{color:#9aa89f}textarea{min-height:74px}button.primary{background:#22694e;color:#fff;border:1px solid #22694e;border-radius:9px;padding:10px 15px;font-weight:550}.secondary{background:#fff;border:1px solid #dce5dd;border-radius:9px;padding:9px 13px}.hint{font-size:11px;color:#8b978e;line-height:1.7;margin:12px 0 0}.response{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.8;border:1px solid #e3eae2;border-radius:12px;padding:16px;background:#fff;margin:18px 0 0}.response:empty{display:none}.response h3{font-size:14px;margin:0 0 9px}.response p{margin:6px 0 12px}.response button{margin:12px 6px 0 0}.response small{display:block;color:#89968d;font-size:10px}.response details{border-top:1px solid #edf0ed;margin-top:14px;padding-top:10px;font-size:12px}.response summary{cursor:pointer;color:#50755d}.status{font-size:11px;border-radius:5px;padding:4px 8px;background:#edf5ef;display:inline-block}.error{color:#a94130}.arguments{background:#f6f8f5;padding:12px;border-radius:7px;margin:12px 0}.arguments div{display:flex;justify-content:space-between;gap:16px;font-size:12px;padding:3px 0}.arguments b{font-weight:550;text-align:right}footer{padding:11px;text-align:center;font-size:10px;color:#9aa69e;border-top:1px solid #f0f3ef;background:#fff;letter-spacing:.4px}.plan-form{margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid #e4ebe4}.launcher{width:56px;height:56px;border-radius:19px;background:#22694e;color:#fff;border:1px solid #ffffff30;box-shadow:0 5px 25px #164e3540;display:flex;align-items:center;justify-content:center;font-size:27px}.floating{width:min(400px,calc(100% - 32px));pointer-events:none;position:fixed;bottom:24px;right:24px;z-index:2147483000;display:flex;align-items:flex-end;flex-direction:column;gap:14px}.floating>*{pointer-events:auto}.floating.left{right:auto;left:24px;align-items:flex-start}.panel{width:100%;height:min(650px,calc(100dvh - 108px));box-shadow:0 22px 80px #172d3429;border-radius:20px;outline:0}.panel .assistant{min-height:0}.panel[hidden]{display:none}@media(max-width:480px){.floating{bottom:16px;right:16px}.floating.left{left:16px}.panel{height:min(640px,calc(100dvh - 104px))}.body{padding:18px}header{padding:16px 18px}}
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
    heading = element('div');
  heading.append(element('strong', options.title ?? '产品助手'), element('small', '有问题，随时来这里'));
  header.append(element('span', 'a18', 'mark'), heading);
  const headActions = element('div', '', 'head-actions');
  if (options.onOpenPage) {
    const open = element('button', '↗', 'icon');
    open.type = 'button';
    open.setAttribute('aria-label', '打开独立支持页');
    open.onclick = options.onOpenPage;
    headActions.append(open);
  }
  if (onClose) {
    const close = element('button', '×', 'icon');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭助手');
    close.onclick = onClose;
    headActions.append(close);
  }
  header.append(headActions);
  const tabs = element('nav', '', 'tabs');
  tabs.setAttribute('aria-label', '助手功能');
  tabs.setAttribute('role', 'tablist');
  const body = element('div', '', 'body');
  root.append(header, tabs, body, element('footer', 'Powered by agent18 · 你的产品助手'));
  target.append(root);
  let alive = true,
    busy = false,
    definitions: ActionDefinition[] = [],
    queries: BusinessQuery[] = [],
    model = false;
  const delivered = new Set<string>();
  const states = {
    proposed: '等待你确认',
    executing: '正在等待业务回执',
    succeeded: '操作成功',
    rejected: '业务系统拒绝',
    uncertain: '结果待确认',
    expired: '预览已过期',
  };
  const result = element('div', '', 'response');
  result.setAttribute('aria-live', 'polite');
  const run = async (fn: () => Promise<void>) => {
    if (busy || !alive) return;
    busy = true;
    body.setAttribute('aria-busy', 'true');
    for (const button of root.querySelectorAll<HTMLInputElement>(
      'button:not(.icon), input, select, textarea',
    ))
      button.disabled = true;
    try {
      await fn();
    } catch (e) {
      if (alive) {
        result.replaceChildren(
          element('b', '请求未完成', 'error'),
          element('p', e instanceof Error ? e.message : '请稍后重试。'),
        );
      }
    } finally {
      busy = false;
      if (alive) {
        body.removeAttribute('aria-busy');
        for (const button of root.querySelectorAll<HTMLInputElement>('button, input, select, textarea'))
          button.disabled = false;
      }
    }
  };
  const preview = (p: ActionProposal) => {
    if (!alive) return;
    const definition = definitions.find((a) => a.id === p.actionId);
    result.replaceChildren(element('h3', definition?.title ?? '业务操作'), element('p', p.preview.summary));
    const args = element('div', '', 'arguments');
    for (const [key, value] of Object.entries(p.arguments)) {
      const row = element('div');
      row.append(
        element('span', definition?.fields.find((f) => f.name === key)?.label ?? key),
        element('b', typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value)),
      );
      args.append(row);
    }
    result.append(args, element('span', states[p.state], 'status'));
    if (p.result?.message) result.append(element('p', p.result.message));
    if (p.state === 'proposed') {
      result.append(element('small', '确认后，将以你的身份向业务系统提交以上操作。'));
      const confirm = element('button', '确认执行', 'primary');
      confirm.type = 'button';
      confirm.onclick = () => void run(async () => preview(await client.confirmAction(p.id)));
      result.append(confirm);
    } else if (['executing', 'uncertain'].includes(p.state)) {
      const reconcile = element('button', '查询业务回执', 'secondary');
      reconcile.type = 'button';
      reconcile.onclick = () => void run(async () => preview(await client.reconcileAction(p.id)));
      result.append(reconcile, element('small', '仅核对本次执行结果，不会重复提交业务写入。'));
    } else if (p.state === 'succeeded' && !delivered.has(p.id)) {
      delivered.add(p.id);
      // A host refresh failure must not turn a verified business success into an execution error.
      try {
        options.onActionComplete?.(p);
      } catch {
        result.append(element('small', '业务已完成；请手动刷新原页面查看变化。'));
      }
    }
  };
  function intro(title: string, description: string) {
    const div = element('div', '', 'intro');
    div.append(element('span', 'HERE TO HELP', 'eyebrow'), element('h2', title), element('p', description));
    return div;
  }
  function queryForm(
    label: string,
    placeholder: string,
    submit: string,
    fn: (query: string) => Promise<void>,
  ) {
    const form = element('form');
    const input = element('textarea');
    input.required = true;
    input.minLength = 2;
    input.maxLength = 300;
    input.rows = 2;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    const button = element('button', submit, 'primary');
    button.type = 'submit';
    form.append(input, button);
    form.onsubmit = (e) => {
      e.preventDefault();
      void run(() => fn(input.value));
    };
    return { form, input };
  }
  function knowledge() {
    body.append(intro('你好，有什么可以帮你？', '使用指南、操作步骤和常见问题，从这里开始。'));
    const { form, input } = queryForm('你的问题', '描述你想了解的问题…', '查找答案  →', async (query) => {
      result.textContent = '正在查找相关资料…';
      const answer = await client.askKnowledge(query);
      if (!alive) return;
      result.replaceChildren(
        element('h3', answer.answer ? '找到了一些线索' : '相关知识'),
        element('p', answer.answer ?? answer.notice ?? '暂时没有可用答案。'),
      );
      for (const citation of answer.citations) {
        const details = element('details');
        details.append(
          element('summary', '▤ ' + citation.title),
          element('p', citation.excerpt),
          element('small', citation.source),
        );
        result.append(details);
      }
    });
    const chips = element('div', '', 'chips');
    for (const title of ['如何开始使用？', '支持哪些业务操作？']) {
      const chip = element('button', title, 'chip');
      chip.type = 'button';
      chip.onclick = () => {
        input.value = title;
        input.focus();
      };
      chips.append(chip);
    }
    body.append(chips, form, element('p', '回答来源于已发布、且你有权限访问的知识。', 'hint'), result);
  }
  function queryBusiness() {
    business(true);
  }
  function business(read = false) {
    const available = read ? queries : definitions;
    body.append(
      read
        ? intro('业务进展，一查就知道。', '沿用你的登录权限，获取业务系统的实时数据。')
        : intro('少点几步，把事情办好。', '选择业务操作，查看预览后再确认执行。'),
    );
    const plan = queryForm('业务需求', '例如：帮我关闭邮件通知', '生成操作预览  →', async (query) =>
      preview(await client.planAction(query)),
    );
    plan.form.className = 'plan-form';
    plan.form.hidden = read || !model;
    body.append(plan.form);
    const select = element('select');
    select.setAttribute('aria-label', read ? '可用业务查询' : '可用业务操作');
    const empty = element(
      'option',
      available.length ? (read ? '选择查询内容' : '选择你想办理的业务') : '当前身份暂无可用业务',
    );
    empty.value = '';
    select.append(empty);
    for (const a of available) {
      const option = element('option', a.title);
      option.value = a.id;
      select.append(option);
    }
    const fields = element('form');
    select.onchange = () => {
      fields.replaceChildren();
      result.replaceChildren();
      const definition = available.find((a) => a.id === select.value);
      if (!definition) return;
      const values = new Map<string, () => string | number | boolean | undefined>();
      for (const field of definition.fields) {
        const label = element('label', field.label);
        if (field.type === 'boolean' || field.enum) {
          const input = element('select');
          input.required = field.required;
          if (!field.required) {
            const empty = element('option', '不设置此项');
            empty.value = '';
            input.append(empty);
          }
          for (const value of field.enum ?? ['true', 'false']) {
            const option = element(
              'option',
              field.type === 'boolean' ? (value === 'true' ? '开启' : '关闭') : value,
            );
            option.value = value;
            input.append(option);
          }
          values.set(field.name, () =>
            !field.required && input.value === ''
              ? undefined
              : field.type === 'boolean'
                ? input.value === 'true'
                : input.value,
          );
          label.append(input);
        } else {
          const input = element('input');
          input.type = field.type === 'number' ? 'number' : 'text';
          input.maxLength = 500;
          input.required = field.required;
          if (field.type === 'number') input.step = 'any';
          values.set(field.name, () =>
            !field.required && !input.value
              ? undefined
              : field.type === 'number'
                ? Number(input.value)
                : input.value,
          );
          label.append(input);
        }
        fields.append(label);
      }
      const button = element('button', read ? '查询业务  →' : '查看操作预览  →', 'primary');
      button.type = 'submit';
      fields.append(button);
      fields.onsubmit = (e) => {
        e.preventDefault();
        void run(async () => {
          const args = Object.fromEntries(
            [...values].map(([k, v]) => [k, v()]).filter(([, v]) => v !== undefined),
          );
          if (!read) {
            preview(await client.prepareAction(definition.id, args));
            return;
          }
          const answer = await client.queryBusiness(definition.id, args);
          if (!alive) return;
          result.replaceChildren(element('h3', definition.title));
          if (!answer.rows.length) result.append(element('p', '没有可访问的记录。'));
          for (const record of answer.rows) {
            const card = element('div', '', 'arguments');
            for (const column of answer.columns) {
              const value = record[column.path],
                row = element('div');
              row.append(
                element('span', column.label),
                element(
                  'b',
                  value === null
                    ? '—'
                    : typeof value === 'boolean'
                      ? value
                        ? '开启'
                        : '关闭'
                      : String(value),
                ),
              );
              card.append(row);
            }
            result.append(card);
          }
          result.append(
            element(
              'small',
              (answer.truncated ? '已截取前 50 条 · ' : '') +
                '业务实时响应 · ' +
                new Date(answer.retrievedAt).toLocaleTimeString(),
            ),
          );
        });
      };
    };
    body.append(select, element('p', '执行主体：你的业务系统 · 身份：当前登录用户', 'hint'), fields, result);
    if (!available.length)
      result.textContent = '当前身份没有可用操作。部署者可以为项目注册业务接口和允许使用的角色。';
  }
  function cases() {
    const history = element('button', '我的问题与回复 ↗', 'secondary');
    history.onclick = () => void run(showCases);
    body.append(history);
    body.append(intro('把问题交给我们。', '留下操作步骤和实际表现，方便支持团队继续跟进。'));
    const form = element('form'),
      title = element('input'),
      description = element('textarea');
    title.required = true;
    title.minLength = 3;
    title.maxLength = 180;
    title.placeholder = '用一句话描述问题';
    description.required = true;
    description.minLength = 3;
    description.maxLength = 4000;
    description.rows = 4;
    description.placeholder = '操作步骤、预期结果与实际表现';
    const titleLabel = element('label', '问题标题'),
      descriptionLabel = element('label', '详细说明');
    titleLabel.append(title);
    descriptionLabel.append(description);
    const submit = element('button', '提交问题  →', 'primary');
    submit.type = 'submit';
    form.append(titleLabel, descriptionLabel, submit);
    let key = crypto.randomUUID();
    form.oninput = () => {
      key = crypto.randomUUID();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        const answer = await client.reportCase({ title: title.value, description: description.value }, key);
        if (!alive) return;
        result.replaceChildren(
          element('h3', '问题已记录 ✓'),
          element('p', answer.case.title),
          element('small', '点击“我的问题与回复”查看进展和补充说明。'),
        );
        form.reset();
        key = crypto.randomUUID();
      });
    };
    body.append(form, element('p', '请勿提交密码、密钥或不必要的个人信息。', 'hint'), result);
  }
  async function showCases() {
    const data = await client.listCases();
    if (!alive) return;
    result.replaceChildren(element('h3', '我的问题'));
    if (!data.cases.length) result.append(element('p', '还没有提交过问题。'));
    for (const c of data.cases) {
      const button = element('button', (c.status === 'resolved' ? '✓ ' : '◎ ') + c.title, 'secondary');
      button.onclick = () => void run(() => showCase(c.id));
      result.append(button);
    }
  }
  async function showCase(id: string) {
    const [detail, thread] = await Promise.all([client.getCase(id), client.caseMessages(id)]);
    if (!alive) return;
    result.replaceChildren(
      element('h3', detail.case.title),
      element('span', detail.case.status === 'resolved' ? '已解决' : '跟进中', 'status'),
      element('p', detail.case.description),
    );
    for (const r of detail.runs.slice(0, 1))
      result.append(
        element(
          'small',
          '自动处理：' +
            {
              pending: '排队中',
              running: '进行中',
              completed: '资料检索完成',
              blocked: '等待跟进',
              failed: '未完成',
              cancelled: '已取消',
            }[r.state],
        ),
      );
    for (const e of detail.evidence) {
      const citation = element('details');
      citation.append(element('summary', e.title), element('p', e.excerpt));
      result.append(citation);
    }
    for (const m of thread.messages) {
      const message = element('div', '', 'arguments');
      message.append(
        element(
          'small',
          (m.author === 'support' ? '支持团队' : '你') + ' · ' + new Date(m.createdAt).toLocaleString(),
        ),
        element('p', m.body),
      );
      result.append(message);
    }
    const input = element('textarea'),
      form = element('form'),
      send = element('button', '补充说明', 'primary');
    input.required = true;
    input.maxLength = 4000;
    input.placeholder = '回复支持团队或补充问题';
    input.setAttribute('aria-label', '补充说明');
    let key = crypto.randomUUID();
    input.oninput = () => {
      key = crypto.randomUUID();
    };
    form.append(input, send);
    form.onsubmit = (e) => {
      e.preventDefault();
      void run(async () => {
        await client.addCaseMessage(id, input.value, key);
        await showCase(id);
      });
    };
    const close = element(
      'button',
      detail.case.status === 'resolved' ? '重新打开问题' : '问题已解决 ✓',
      'secondary',
    );
    close.onclick = () =>
      void run(async () => {
        await client.setCaseStatus(id, detail.case.status === 'resolved' ? 'needs_human' : 'resolved');
        await showCase(id);
      });
    const refresh = element('button', '刷新进展', 'secondary');
    refresh.onclick = () => void run(() => showCase(id));
    result.append(form, close, refresh);
  }
  const render = (page: string) => {
    body.replaceChildren();
    result.replaceChildren();
    for (const button of tabs.querySelectorAll('button'))
      button.setAttribute('aria-selected', String(button.dataset.page === page));
    (({ knowledge, business, cases, queryBusiness })[page] ?? knowledge)();
  };
  for (const [id, label] of [
    ['knowledge', '▤  找答案'],
    ['queryBusiness', '⌕  查业务'],
    ['business', '↔  办业务'],
    ['cases', '◎  问题'],
  ]) {
    const button = element('button', label, 'tab');
    button.type = 'button';
    button.dataset.page = id;
    button.setAttribute('role', 'tab');
    button.onclick = () => {
      if (!busy) render(id!);
    };
    tabs.append(button);
  }
  render('knowledge');
  void client
    .listBusinessQueries()
    .then((data) => {
      if (alive) {
        queries = data.queries;
        if (
          tabs.querySelector('[data-page=queryBusiness]')?.getAttribute('aria-selected') === 'true' &&
          !busy
        )
          render('queryBusiness');
      }
    })
    .catch(() => {});
  void client
    .listActions()
    .then(({ actions }) => {
      if (alive) {
        definitions = actions;
        if (tabs.querySelector('[data-page=business]')?.getAttribute('aria-selected') === 'true' && !busy)
          render('business');
      }
    })
    .catch(() => {});
  void client
    .session()
    .then((session) => {
      if (alive) {
        model = session.capabilities.model === 'configured';
        const plan = root.querySelector<HTMLElement>('.plan-form');
        if (plan && tabs.querySelector('[data-page=business]')?.getAttribute('aria-selected') === 'true')
          plan.hidden = !model;
      }
    })
    .catch(() => {});
  return {
    focus() {
      root.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    },
    destroy() {
      alive = false;
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
