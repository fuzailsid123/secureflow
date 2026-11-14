/**
 * Topological sorting by source removal (Kahn's algorithm), O(V + E).
 * Works on integer indices internally; no recursion anywhere, so a 5,000-deep chain is safe.
 */
export class GraphError extends Error {
  constructor(
    readonly code: 'UNKNOWN_TASK' | 'DUPLICATE_ID',
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export interface Graph {
  ids: string[];
  index: Map<string, number>;
  adj: number[][];
  indeg: number[];
  edgeCount: number;
}

/** Builds the adjacency list + in-degree array. Duplicate edges are ignored; self-loops are kept (they are cycles). */
export function buildGraph(ids: string[], edges: ReadonlyArray<readonly [string, string]>): Graph {
  const n = ids.length;
  const index = new Map<string, number>();
  ids.forEach((id, i) => {
    if (index.has(id)) throw new GraphError('DUPLICATE_ID', `Duplicate task id "${id}"`);
    index.set(id, i);
  });
  const adj: number[][] = Array.from({ length: n }, () => []);
  const indeg: number[] = new Array(n).fill(0);
  const seen = new Set<number>();
  let edgeCount = 0;
  for (const [a, b] of edges) {
    const u = index.get(a);
    const v = index.get(b);
    if (u === undefined || v === undefined) {
      throw new GraphError('UNKNOWN_TASK', `Edge ${a} -> ${b} references an unknown task`);
    }
    const key = u * n + v;
    if (seen.has(key)) continue;
    seen.add(key);
    adj[u].push(v);
    indeg[v]++;
    edgeCount++;
  }
  return { ids, index, adj, indeg, edgeCount };
}

export type SortResult =
  | { ok: true; levels: number[][] }
  | { ok: false; cycle: number[] };

/**
 * Repeatedly removes all vertices whose in-degree is 0. Each removed batch is one "level"
 * (tasks that are mutually independent). If vertices remain but none has in-degree 0, the graph
 * has a cycle; the exact cycle is recovered by walking predecessor links among the leftovers.
 */
export function topoSort(g: Graph): SortResult {
  const n = g.ids.length;
  const indeg = g.indeg.slice();
  let frontier: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) frontier.push(i);

  const levels: number[][] = [];
  let done = 0;
  while (frontier.length > 0) {
    levels.push(frontier);
    done += frontier.length;
    const next: number[] = [];
    for (const u of frontier) {
      for (const v of g.adj[u]) {
        if (--indeg[v] === 0) next.push(v);
      }
    }
    frontier = next;
  }
  if (done === n) return { ok: true, levels };

  // Leftovers (indeg > 0) = the cycle(s) plus everything downstream of them. Every leftover has at
  // least one unprocessed predecessor, which is itself a leftover, so following pred links must loop.
  const pred = new Int32Array(n).fill(-1);
  let start = -1;
  for (let u = 0; u < n; u++) {
    if (indeg[u] <= 0) continue;
    if (start === -1) start = u;
    for (const v of g.adj[u]) if (indeg[v] > 0 && pred[v] === -1) pred[v] = u;
  }
  const seenAt = new Int32Array(n).fill(-1);
  const walk: number[] = [];
  let cur = start;
  while (seenAt[cur] === -1) {
    seenAt[cur] = walk.length;
    walk.push(cur);
    cur = pred[cur];
  }
  const cycle = walk.slice(seenAt[cur]).reverse();
  cycle.push(cycle[0]);
  return { ok: false, cycle };
}

/** All vertices reachable from `start` (excluding `start`). Iterative DFS, O(V + E). */
export function descendants(g: Graph, start: number): number[] {
  const seen = new Uint8Array(g.ids.length);
  const out: number[] = [];
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of g.adj[u]) {
      if (!seen[v]) {
        seen[v] = 1;
        out.push(v);
        stack.push(v);
      }
    }
  }
  return out;
}

/** Longest path by total duration (the minimum possible build time). Requires an acyclic graph. O(V + E). */
export function criticalPath(
  g: Graph,
  order: number[],
  durations: number[],
): { path: number[]; lengthMs: number } {
  const n = g.ids.length;
  const best = new Array<number>(n).fill(0); // longest finish time of any predecessor chain
  const parent = new Int32Array(n).fill(-1);
  const finish = new Array<number>(n).fill(0);
  let tail = -1;
  for (const u of order) {
    finish[u] = best[u] + durations[u];
    if (tail === -1 || finish[u] > finish[tail]) tail = u;
    for (const v of g.adj[u]) {
      if (finish[u] > best[v] || (finish[u] === best[v] && parent[v] === -1)) {
        best[v] = finish[u];
        parent[v] = u;
      }
    }
  }
  if (tail === -1) return { path: [], lengthMs: 0 };
  const path: number[] = [];
  for (let c = tail; c !== -1; c = parent[c]) path.push(c);
  return { path: path.reverse(), lengthMs: finish[tail] };
}

/** String-id convenience wrapper used by the API and the benchmark. */
export type ScheduleResult =
  | { ok: true; levels: string[][]; order: string[]; graph: Graph }
  | { ok: false; cycle: string[]; graph: Graph };

export function schedule(ids: string[], edges: ReadonlyArray<readonly [string, string]>): ScheduleResult {
  const graph = buildGraph(ids, edges);
  const r = topoSort(graph);
  if (!r.ok) return { ok: false, cycle: r.cycle.map((i) => ids[i]), graph };
  const levels = r.levels.map((lv) => lv.map((i) => ids[i]));
  return { ok: true, levels, order: levels.flat(), graph };
}
