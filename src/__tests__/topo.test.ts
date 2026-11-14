import { describe, expect, it } from 'vitest';
import { GraphError, buildGraph, criticalPath, descendants, schedule, topoSort } from '@/lib/topo';

type E = [string, string];
const edgeSet = (es: E[]) => new Set(es.map((e) => e.join('>')));

describe('schedule (source removal)', () => {
  it('groups independent tasks into levels and ignores duplicate edges', () => {
    const r = schedule(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'b']]);
    expect(r.ok && r.levels).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(r.graph.edgeCount).toBe(4);
  });

  it('every edge goes from an earlier to a later position in the order', () => {
    const edges: E[] = [['e', 'a'], ['a', 'c'], ['b', 'c'], ['c', 'd'], ['e', 'd']];
    const r = schedule(['a', 'b', 'c', 'd', 'e'], edges);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pos = new Map(r.order.map((id, i) => [id, i]));
    for (const [u, v] of edges) expect(pos.get(u)!).toBeLessThan(pos.get(v)!);
  });

  it('handles empty graph, single task and disconnected components', () => {
    expect(schedule([], [])).toMatchObject({ ok: true, levels: [] });
    expect(schedule(['x'], [])).toMatchObject({ ok: true, levels: [['x']] });
    const r = schedule(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']]);
    expect(r.ok && r.levels).toEqual([['a', 'c'], ['b', 'd']]);
  });

  it('reports the exact cycle, excluding upstream and downstream tasks', () => {
    const edges: E[] = [['a', 'b'], ['b', 'c'], ['c', 'b'], ['c', 'd'], ['d', 'e']];
    const r = schedule(['a', 'b', 'c', 'd', 'e'], edges);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.cycle[0]).toBe(r.cycle.at(-1));
    const set = edgeSet(edges);
    for (let i = 0; i < r.cycle.length - 1; i++) expect(set.has(`${r.cycle[i]}>${r.cycle[i + 1]}`)).toBe(true);
    for (const id of ['a', 'd', 'e']) expect(r.cycle).not.toContain(id);
  });

  it('treats a self-loop as a cycle', () => {
    const r = schedule(['x'], [['x', 'x']]);
    expect(r).toMatchObject({ ok: false, cycle: ['x', 'x'] });
  });

  it('finds a long cycle', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `n${i}`);
    const edges: E[] = ids.map((id, i) => [id, ids[(i + 1) % ids.length]]);
    const r = schedule(ids, edges);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cycle.length).toBe(51);
  });

  it('rejects unknown tasks and duplicate ids', () => {
    expect(() => schedule(['a'], [['a', 'zzz']])).toThrow(GraphError);
    expect(() => schedule(['a', 'a'], [])).toThrow(GraphError);
  });

  it('is deterministic', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const edges: E[] = [['a', 'd'], ['b', 'd'], ['c', 'd']];
    expect(JSON.stringify(schedule(ids, edges))).toBe(JSON.stringify(schedule(ids, edges)));
  });

  it('survives a 5,000-deep chain (no recursion) and a 5,000 task / 20,000 edge graph in under 1s', () => {
    const chainIds = Array.from({ length: 5000 }, (_, i) => `c${i}`);
    const chain: E[] = chainIds.slice(1).map((id, i) => [chainIds[i], id]);
    const r1 = schedule(chainIds, chain);
    expect(r1.ok && r1.levels.length).toBe(5000);

    const ids = Array.from({ length: 5000 }, (_, i) => `t${i}`);
    const edges: E[] = [];
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    while (edges.length < 20000) {
      const u = Math.floor(rnd() * 4999);
      const v = u + 1 + Math.floor(rnd() * (4999 - u));
      edges.push([ids[u], ids[v]]);
    }
    const t0 = performance.now();
    const r2 = schedule(ids, edges);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r2.ok).toBe(true);
  });
});

describe('descendants and criticalPath', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const edges: E[] = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['x', 'a']].filter(
    ([u]) => ids.includes(u),
  ) as E[];
  const g = buildGraph(ids, edges);

  it('descendants returns everything reachable, not the start', () => {
    expect(descendants(g, 0).sort()).toEqual([1, 2, 3]);
    expect(descendants(g, 4)).toEqual([]);
  });

  it('criticalPath is the longest path by duration', () => {
    const sorted = topoSort(g);
    expect(sorted.ok).toBe(true);
    if (!sorted.ok) return;
    // a=1 b=10 c=2 d=1 e=100 (isolated)
    const cp = criticalPath(g, sorted.levels.flat(), [1, 10, 2, 1, 100]);
    expect(cp.lengthMs).toBe(100);
    const cp2 = criticalPath(g, sorted.levels.flat(), [1, 10, 2, 1, 5]);
    expect(cp2.path.map((i) => ids[i])).toEqual(['a', 'b', 'd']);
    expect(cp2.lengthMs).toBe(12);
  });
});
