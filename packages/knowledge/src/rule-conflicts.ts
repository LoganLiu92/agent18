/** Conservative syntax detection only; the reviewer must establish a shared business scope. */
export type RuleRecord = { kind: 'document' | 'source'; id: string; version: string; body: string };
export function detectRuleConflicts(records: RuleRecord[]) {
  const groups = new Map<
    string,
    { kind: RuleRecord['kind']; id: string; version: string; value: string; number: number }[]
  >();
  for (const r of records.slice(0, 100))
    for (const line of r.body.slice(0, 20000).split('\n').slice(0, 500)) {
      const m =
        /^\s*(?:(?:export\s+)?(?:const|let|var)\s+)?["'`]?([A-Za-z\u4e00-\u9fff][A-Za-z0-9_ \u4e00-\u9fff]{1,79})["'`]?\s*[:=]\s*["'`]?([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|KiB|MiB|GiB|ms|seconds|minutes|hours|%|个|次)?["'`]?\s*[;,。]?\s*$/.exec(
          line,
        );
      if (!m) continue;
      const key =
        m[1]!
          .trim()
          .replace(/([a-z])([A-Z])/g, '$1_$2')
          .toLowerCase()
          .replace(/^maximum\b/, 'max')
          .replace(/[ _]+/g, '_') +
        ' (' +
        (m[3] ?? 'number') +
        ')';
      const value = Number(m[2]);
      if (!Number.isFinite(value) || value > 1e15) continue;
      const entries = groups.get(key) ?? [];
      if (!entries.some((e) => e.kind === r.kind && e.id === r.id))
        entries.push({
          kind: r.kind,
          id: r.id,
          version: r.version,
          value: line.trim().slice(0, 300),
          number: value,
        });
      groups.set(key, entries);
    }
  return [...groups]
    .filter(([, v]) => v.length >= 2 && new Set(v.map((x) => x.number)).size > 1)
    .slice(0, 30)
    .map(([ruleKey, v]) => ({
      ruleKey,
      claims: [...new Map(v.map((item) => [item.number, item])).values()]
        .slice(0, 5)
        .map(({ number: _n, ...ref }) => ref),
    }));
}
