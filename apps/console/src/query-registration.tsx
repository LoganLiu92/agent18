import { useState } from 'react';
import type { QueryConfig } from '@agent18/actions';

const example = {
  id: 'orders.search',
  title: '按状态筛选订单',
  description: '只查询当前用户有权访问的订单',
  method: 'POST',
  path: '/api/orders/search',
  fields: [
    {
      name: 'status',
      label: '订单状态',
      type: 'string',
      in: 'body',
      required: true,
      enum: ['处理中', '已完成', '待确认'],
    },
  ],
  rowsPath: 'items',
  columns: [
    { path: 'id', label: '订单' },
    { path: 'status', label: '状态' },
  ],
  roles: ['tenant-admin'],
};

export function QueryRegistration({
  request,
  onAdd,
}: {
  request: <T>(path: string, body?: unknown) => Promise<T>;
  onAdd: (query: QueryConfig['operations'][number]) => void;
}) {
  const [source, setSource] = useState(JSON.stringify(example, null, 2)),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  let valid = false;
  try {
    const value = JSON.parse(source);
    valid = value && typeof value === 'object' && !Array.isArray(value);
  } catch {
    /* Editable draft. */
  }
  return (
    <details className="ops-import">
      <summary>
        登记只读 POST 查询 <span>由部署者审核</span>
      </summary>
      <p>
        适用于已有的搜索、筛选接口。固定路径、参数位置、角色和返回字段；body
        仅支持列出的基础类型参数。写入接口请使用下方业务桥。
      </p>
      <label>
        查询定义 JSON
        <textarea
          className="ops-code"
          rows={12}
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setReviewed(false);
            setError('');
            setNotice('');
          }}
        />
      </label>
      <label className="ops-query">
        <span>
          <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
          我已核对该接口没有业务写入副作用，并按当前用户验证租户、对象权限与返回字段。
        </span>
      </label>
      <button
        className="experience-primary"
        disabled={!valid || !reviewed || busy}
        onClick={() => {
          setBusy(true);
          setError('');
          setNotice('');
          void request<{ operation: QueryConfig['operations'][number] }>('queries/review', {
            ...JSON.parse(source),
            method: 'POST',
            readOnly: true,
            enabled: false,
          })
            .then(({ operation }) => {
              onAdd(operation);
              setReviewed(false);
              setNotice('已加入待启用列表。核对后勾选启用，保存并应用。');
            })
            .catch(() =>
              setError('定义未通过检查。请核对标识、路径、参数位置、角色和字段；body 不支持嵌套对象。'),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? '正在检查…' : '审核定义并加入列表'}
      </button>
      {!valid && <p role="alert">请输入合法 JSON 对象。</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
