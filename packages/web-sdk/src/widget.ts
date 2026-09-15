import { Agent18 } from './index.js';
import type { ActionProposal, ActionDefinition } from '@agent18/contracts';
/** Mount an optional small assistant in a host-owned element. All remote content is text, never HTML. */
export function mountAssistant(target: HTMLElement, client: Agent18) {
  const root = document.createElement('section');
  root.setAttribute('aria-label', 'agent18 assistant');
  root.style.cssText =
    'font:14px/1.6 system-ui,sans-serif;max-width:520px;border:1px solid #dce2ed;border-radius:12px;padding:20px;background:white;color:#25334c';
  const title = document.createElement('h3');
  title.textContent = 'agent18 · 帮助与业务助手';
  root.append(title);
  const result = document.createElement('div');
  result.setAttribute('aria-live', 'polite');
  result.style.cssText =
    'white-space:pre-wrap;overflow-wrap:anywhere;max-height:380px;overflow:auto;margin:12px 0';
  let definitions: ActionDefinition[] = [];
  const states = {
    proposed: '等待你确认',
    executing: '已发出，等待回执',
    succeeded: '操作成功',
    rejected: '业务系统拒绝',
    uncertain: '结果待确认',
    expired: '预览已过期',
  };
  const form = document.createElement('form'),
    query = document.createElement('input');
  query.required = true;
  query.minLength = 2;
  query.maxLength = 300;
  query.placeholder = '描述问题或业务需求';
  query.setAttribute('aria-label', '问题或业务需求');
  query.style.cssText = 'box-sizing:border-box;width:100%;padding:10px;margin-bottom:10px';
  const ask = document.createElement('button');
  ask.textContent = '查询知识';
  ask.type = 'submit';
  const plan = document.createElement('button');
  plan.textContent = '生成操作预览';
  plan.type = 'button';
  form.append(query, ask, plan);
  root.append(form, result);
  target.append(root);
  let alive = true,
    busy = false;
  const show = (text: string) => {
    if (alive) result.textContent = text;
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy || !alive) return;
    busy = true;
    ask.disabled = plan.disabled = true;
    try {
      await fn();
    } catch (e) {
      show(`请求未完成：${e instanceof Error ? e.message : 'REQUEST_FAILED'}`);
    } finally {
      busy = false;
      if (alive) ask.disabled = plan.disabled = false;
    }
  };
  const preview = (p: ActionProposal) => {
    if (!alive) return;
    show(
      [
        p.preview.summary,
        ...Object.entries(p.arguments).map(
          ([key, value]) =>
            `${definitions.find((a) => a.id === p.actionId)?.fields.find((f) => f.name === key)?.label ?? key}：${typeof value === 'boolean' ? (value ? '开启' : '关闭') : value}`,
        ),
        states[p.state],
        p.result?.message ?? '',
      ].join('\n'),
    );
    if (p.state === 'proposed') {
      const button = document.createElement('button');
      button.textContent = '确认执行此操作';
      button.type = 'button';
      button.onclick = () => {
        button.disabled = true;
        void run(async () => preview(await client.confirmAction(p.id)));
      };
      result.append(document.createElement('br'), button);
    } else if (['executing', 'uncertain'].includes(p.state)) {
      const button = document.createElement('button');
      button.textContent = '查询业务回执';
      button.type = 'button';
      button.onclick = () => void run(async () => preview(await client.reconcileAction(p.id)));
      result.append(document.createElement('br'), button);
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    void run(async () => {
      const r = await client.askKnowledge(query.value);
      show(
        [r.answer ?? r.notice, ...r.citations.map((c) => `${c.title}\n${c.excerpt}\n${c.source}`)].join(
          '\n\n',
        ),
      );
    });
  };
  plan.onclick = () => {
    if (form.reportValidity()) void run(async () => preview(await client.planAction(query.value)));
  };
  const select = document.createElement('select');
  select.setAttribute('aria-label', '可用业务操作');
  const empty = document.createElement('option');
  empty.textContent = '选择业务操作';
  empty.value = '';
  select.append(empty);
  const fields = document.createElement('form');
  root.append(select, fields);
  void client
    .listActions()
    .then(({ actions }) => {
      if (!alive) return;
      definitions = actions;
      for (const a of actions) {
        const option = document.createElement('option');
        option.value = a.id;
        option.textContent = a.title;
        select.append(option);
      }
      select.onchange = () => {
        fields.replaceChildren();
        const a = actions.find((x) => x.id === select.value);
        if (!a) return;
        const values = new Map<string, () => string | number | boolean>();
        for (const f of a.fields) {
          const label = document.createElement('label');
          label.textContent = f.label + ' ';
          label.style.display = 'block';
          if (f.type === 'boolean' || f.enum) {
            const input = document.createElement('select');
            input.required = f.required;
            for (const value of f.enum ?? ['true', 'false']) {
              const option = document.createElement('option');
              option.value = value;
              option.textContent = f.type === 'boolean' ? (value === 'true' ? '开启' : '关闭') : value;
              input.append(option);
            }
            values.set(f.name, () => (f.type === 'boolean' ? input.value === 'true' : input.value));
            label.append(input);
          } else {
            const input = document.createElement('input');
            input.type = f.type === 'number' ? 'number' : 'text';
            input.maxLength = 500;
            input.required = f.required;
            values.set(f.name, () => (f.type === 'number' ? Number(input.value) : input.value));
            label.append(input);
          }
          fields.append(label);
        }
        const button = document.createElement('button');
        button.textContent = '预览操作';
        fields.append(button);
        fields.onsubmit = (e) => {
          e.preventDefault();
          void run(async () =>
            preview(
              await client.prepareAction(a.id, Object.fromEntries([...values].map(([k, v]) => [k, v()]))),
            ),
          );
        };
      };
    })
    .catch((e) => show(e.message));
  void client
    .session()
    .then((s) => {
      if (alive) plan.hidden = s.capabilities.model !== 'configured';
    })
    .catch(() => {});
  return {
    destroy() {
      alive = false;
      root.remove();
    },
  };
}
