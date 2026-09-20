import { useEffect, useState } from 'react';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
export function KnowledgeDiscovery({
  request,
  base,
  onCreated,
}: {
  request: Request;
  base: string;
  onCreated: (id: string) => Promise<void>;
}) {
  type Candidate = {
    key: string;
    domain: string;
    title: string;
    paths: string[];
    categories: string[];
    evidenceIds: string[];
    totalEvidence: number;
  };
  const [snapshots, setSnapshots] = useState<{ id: string; name: string; revision: string }[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [candidates, setCandidates] = useState<Candidate[]>([]),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const path = base + '/topics';
  useEffect(() => {
    let active = true;
    request<{ snapshots: typeof snapshots }>(path + '/discovery/snapshots')
      .then((r) => {
        if (active) setSnapshots(r.snapshots);
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="admin-card ws-section">
      <summary>扫描结果 → 产品范围候选</summary>
      <p>
        选择最多 5
        个固定来源版本，以仓库目录分组发现可能的业务域。分组和证据均需人工确认，未命中的领域仍可手动添加。
      </p>
      {snapshots.map((s) => (
        <label className="ws-check" key={s.id}>
          <input
            type="checkbox"
            checked={selected.includes(s.id)}
            disabled={!selected.includes(s.id) && selected.length >= 5}
            onChange={(e) => {
              setSelected(e.target.checked ? [...selected, s.id] : selected.filter((id) => id !== s.id));
              setCandidates([]);
            }}
          />
          {s.name} · {s.revision}
        </label>
      ))}
      <button
        disabled={busy || !selected.length}
        onClick={() =>
          void act(async () => {
            const r = await request<{ candidates: Candidate[]; truncated: boolean }>(path + '/discover', {
              snapshotIds: selected,
            });
            setCandidates(r.candidates);
            setMessage(
              r.truncated
                ? '已达到本次扫描预算，请缩小来源范围分批处理。'
                : '已发现候选分组，可编辑名称后导入为待确认主题。',
            );
          })
        }
      >
        识别候选
      </button>
      {candidates.map((c) => (
        <article className="ws-reference" key={c.key}>
          <label>
            业务域
            <input
              value={c.domain}
              onChange={(e) =>
                setCandidates(candidates.map((v) => (v.key === c.key ? { ...v, domain: e.target.value } : v)))
              }
            />
          </label>
          <label>
            主题名称
            <input
              value={c.title}
              onChange={(e) =>
                setCandidates(candidates.map((v) => (v.key === c.key ? { ...v, title: e.target.value } : v)))
              }
            />
          </label>
          <p>{c.paths.join(' · ')}</p>
          <small>
            已映射 {c.evidenceIds.length} / {c.totalEvidence} 条证据 · {c.categories.join('、')}
          </small>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await request<{ id: string }>(path + '/candidates', {
                  snapshotIds: selected,
                  key: c.key,
                  title: c.title,
                  domain: c.domain,
                });
                await onCreated(r.id);
              })
            }
          >
            导入为待确认主题
          </button>
        </article>
      ))}
      <p role="status">{message}</p>
    </details>
  );
}
export function TopicMerge({
  request,
  base,
  source,
  targets,
  onMerged,
}: {
  request: Request;
  base: string;
  source: { id: string; version: number };
  targets: { id: string; title: string; version: number }[];
  onMerged: (id: string) => Promise<void>;
}) {
  const [target, setTarget] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <details className="ws-section">
      <summary>合并重复主题</summary>
      <p>
        文档关联和证据候选并入目标，原主题保留历史并标为已排除；目标范围重新确认，合并不改变文档发布状态。
      </p>
      <select aria-label="合并目标主题" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">选择目标</option>
        {targets
          .filter((t) => t.id !== source.id)
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
      </select>
      <input
        aria-label="合并理由"
        minLength={5}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        disabled={busy || !target || reason.trim().length < 5}
        onClick={() => {
          setBusy(true);
          void request(base + '/topics/' + source.id + '/merge', {
            version: source.version,
            targetId: target,
            targetVersion: targets.find((t) => t.id === target)!.version,
            reason,
          })
            .then(() => onMerged(target))
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        确认合并
      </button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
export function PublicationSets({
  request,
  base,
  canPublish,
}: {
  request: Request;
  base: string;
  canPublish: boolean;
}) {
  type Data = {
    approved: { id: string; title: string; audience: string; version: number }[];
    sets: {
      id: string;
      title: string;
      created_at: string;
      members: { documentId: string; title: string; audience: string; version: number; buildId: string }[];
    }[];
  };
  const [data, setData] = useState<Data>(),
    [selected, setSelected] = useState<string[]>([]),
    [title, setTitle] = useState('产品知识更新'),
    [reason, setReason] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID());
  const path = base + '/publication-sets';
  useEffect(() => {
    let active = true;
    request<Data>(path)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [request, path]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setData(await request<Data>(path));
      setSelected([]);
      setKey(crypto.randomUUID());
      setMessage('操作完成，发布集合与文档历史已记录。');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-card">
      <h2>发布集合</h2>
      <p>
        将已逐篇审核的文档一次性发布，任一版本变化则整批拒绝。客户与内部文档保留各自受众，不互相继承审核结果。
      </p>
      {canPublish && (
        <>
          <label>
            本次发布名称
            <input
              required
              minLength={2}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setKey(crypto.randomUUID());
              }}
            />
          </label>
          {data?.approved.map((d) => (
            <label className="ws-check" key={d.id}>
              <input
                type="checkbox"
                checked={selected.includes(d.id)}
                disabled={!selected.includes(d.id) && selected.length >= 30}
                onChange={(e) => {
                  setSelected(e.target.checked ? [...selected, d.id] : selected.filter((id) => id !== d.id));
                  setKey(crypto.randomUUID());
                }}
              />
              {d.title} · {d.audience === 'customer' ? '客户' : '内部'} · v{d.version}
            </label>
          ))}
          <button
            disabled={busy || !selected.length}
            onClick={() =>
              void act(() =>
                request(path, {
                  title,
                  requestKey: key,
                  documents: data!.approved
                    .filter((d) => selected.includes(d.id))
                    .map((d) => ({ id: d.id, version: d.version })),
                }),
              )
            }
          >
            发布所选 {selected.length} 份文档
          </button>
          <label>
            批量撤下理由
            <input minLength={5} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </>
      )}
      {data?.sets.map((s) => (
        <details key={s.id}>
          <summary>
            {s.title} · {new Date(s.created_at).toLocaleString()}
          </summary>
          {s.members.map((m) => (
            <p key={m.documentId}>
              {m.title} · {m.audience} · v{m.version} · {m.buildId}
            </p>
          ))}
          {canPublish && (
            <button
              disabled={busy || reason.trim().length < 5}
              onClick={() => void act(() => request(path + '/' + s.id + '/revoke', { reason }))}
            >
              整批撤下（有新发布则拒绝）
            </button>
          )}
        </details>
      ))}
      <p role="status">{message}</p>
    </section>
  );
}
