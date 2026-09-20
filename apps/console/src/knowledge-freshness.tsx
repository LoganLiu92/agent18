import { useEffect, useState } from 'react';
type Status = {
  path: string;
  status: string;
  originalRevision?: string;
  latestRevision?: string;
  sourceEnabled?: boolean;
};
type Result = {
  evidence: Status[];
  changed: number;
  unknown: number;
  truncated: boolean;
  deployment: {
    status: string;
    records?: {
      service: string;
      environment: string;
      commit_hash: string;
      attestation: string;
      revoked_at: string | null;
      matchesDocument: boolean;
    }[];
  };
};
export function KnowledgeFreshness({
  request,
  path,
}: {
  request: <T>(path: string, body?: unknown) => Promise<T>;
  path: string;
}) {
  const [data, setData] = useState<Result>(),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    request<Result>(path + '/freshness')
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path]);
  return (
    <div className="ws-evidence">
      <b>来源更新检查</b>
      {error ? (
        <p role="alert">检查未完成：{error}</p>
      ) : !data ? (
        <p>正在核对最新扫描…</p>
      ) : (
        <>
          <p>
            {!data.evidence.length
              ? '人工补充文档，未关联源码片段。'
              : data.changed
                ? `${data.changed} 条原文依据已变化或移除，需要重新核对正文。`
                : data.unknown
                  ? '部分来源缺少原文，无法确认是否变化。'
                  : '原文片段与最新扫描一致。'}{' '}
            {data.unknown > 0 && `${data.unknown} 条依据状态未知。`}
          </p>
          <small>
            仅比较已完成扫描的固定片段。未扫描的仓库更新和线上部署状态不在此结论内；不会自动改写或撤回已发布文档。
          </small>
          <p>
            生产部署记录：{data.deployment.status === 'unknown' ? '未知' : '已有部署证明，需按适用服务核对'}
          </p>
          {data.deployment.records?.map((r) => (
            <p key={r.service}>
              {r.service} · {r.commit_hash} ·{' '}
              {r.revoked_at
                ? '证明已撤销，版本未知'
                : r.matchesDocument
                  ? '与文档来源版本一致'
                  : '与文档来源版本不同，需要核对适用范围'}
            </p>
          ))}
          <details>
            <summary>查看逐条比对</summary>
            {data.evidence.map((e, i) => (
              <p key={i}>
                {e.path} ·{' '}
                {e.status === 'changed' ? '已变化或移除' : e.status === 'unchanged' ? '片段一致' : '未知'}
                <small>
                  原版本 {e.originalRevision ?? '未知'} / 最新扫描 {e.latestRevision ?? '未知'}
                  {e.sourceEnabled === false ? ' · 来源已停用' : ''}
                </small>
              </p>
            ))}
            {data.truncated && <p>仅显示前 200 条依据。</p>}
          </details>
        </>
      )}
    </div>
  );
}
