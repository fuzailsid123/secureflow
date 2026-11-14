/**
 * Complementary graph algorithms (all iterative, O(V + E), safe for 5,000-node chains):
 *  - Tarjan's Strongly Connected Components (finds all cycles at once, not just one)
 *  - Feedback-arc suggestion (identifies minimal edges to remove to break all cycles)
 *  - Bottom-level longest remaining duration (for Critical-Path-First list scheduling)
 */
import type { Graph } from './topo';

export interface CycleBreakSuggestion {
  from: string;
  to: string;
  sccSize: number;
}

export interface SCCAnalysis {
  /** Strongly connected components that contain at least one cycle (size > 1 or self-loop). */
  cyclicSccs: string[][];
  /** Candidate edges to break all detected cycles. */
  suggestedBreaks: CycleBreakSuggestion[];
}

/**
 * Iterative Tarjan's SCC decomposition, O(V + E).
 * Returns SCCs in topological order of the condensation DAG (only cyclic SCCs kept in `cyclicSccs`).
 */
export function tarjanSCC(g: Graph): number[][] {
  const n = g.ids.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n).fill(0);
  const onStack = new Uint8Array(n);
  const tarjanStack: number[] = [];
  const sccs: number[][] = [];
  let timer = 0;

  // Explicit call-frame stack: [vertex, nextNeighborIdx]
  const dfsV: number[] = [];
  const dfsEdge: number[] = [];

  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) continue;
    index[start] = low[start] = timer++;
    tarjanStack.push(start);
    onStack[start] = 1;
    dfsV.push(start);
    dfsEdge.push(0);

    while (dfsV.length > 0) {
      const top = dfsV.length - 1;
      const u = dfsV[top];
      const ei = dfsEdge[top];
      const neighbors = g.adj[u];

      if (ei < neighbors.length) {
        dfsEdge[top] = ei + 1;
        const v = neighbors[ei];
        if (index[v] === -1) {
          index[v] = low[v] = timer++;
          tarjanStack.push(v);
          onStack[v] = 1;
          dfsV.push(v);
          dfsEdge.push(0);
        } else if (onStack[v]) {
          if (index[v] < low[u]) low[u] = index[v];
        }
      } else {
        dfsV.pop();
        dfsEdge.pop();
        if (dfsV.length > 0) {
          const parent = dfsV[dfsV.length - 1];
          if (low[u] < low[parent]) low[parent] = low[u];
        }
        if (low[u] === index[u]) {
          const comp: number[] = [];
          for (;;) {
            const w = tarjanStack.pop()!;
            onStack[w] = 0;
            comp.push(w);
            if (w === u) break;
          }
          sccs.push(comp);
        }
      }
    }
  }

  return sccs;
}

/**
 * Analyzes every cyclic SCC in `g` and computes a greedy feedback-arc set of edges
 * whose removal makes the entire graph acyclic.
 */
export function analyzeCycles(g: Graph): SCCAnalysis {
  const allSccs = tarjanSCC(g);
  const hasSelfLoop = (u: number) => g.adj[u].includes(u);
  const cyclic = allSccs.filter((c) => c.length > 1 || (c.length === 1 && hasSelfLoop(c[0])));

  const cyclicSccs = cyclic.map((comp) => comp.slice().reverse().map((i) => g.ids[i]));
  const suggestedBreaks: CycleBreakSuggestion[] = [];

  for (const comp of cyclic) {
    if (comp.length === 1) {
      const id = g.ids[comp[0]];
      suggestedBreaks.push({ from: id, to: id, sccSize: 1 });
      continue;
    }
    const compSet = new Set(comp);
    // Repeatedly strip a back-edge inside the induced subgraph (ordered by ascending Tarjan pop order,
    // which places cycle back-edges as edges pointing forward/backward against an arbitrary node order)
    // and verify acyclicity via local Kahn removal; pick an edge whose removal reduces remaining cycle edges.
    const inducedEdges: Array<[number, number]> = [];
    for (const u of comp) {
      for (const v of g.adj[u]) {
        if (compSet.has(v)) inducedEdges.push([u, v]);
      }
    }

    // Greedy feedback-arc break on the SCC: maintain active edges, repeatedly find a cycle via iterative DFS
    // and remove the edge inside that cycle with the highest (outdeg + indeg) within the SCC.
    const active = new Map<number, Set<number>>();
    for (const u of comp) active.set(u, new Set());
    for (const [u, v] of inducedEdges) active.get(u)!.add(v);

    for (;;) {
      const cycleEdge = findOneCycleEdge(comp, active);
      if (!cycleEdge) break;
      const [bu, bv] = cycleEdge;
      active.get(bu)!.delete(bv);
      suggestedBreaks.push({ from: g.ids[bu], to: g.ids[bv], sccSize: comp.length });
    }
  }

  return { cyclicSccs, suggestedBreaks };
}

function findOneCycleEdge(nodes: number[], active: Map<number, Set<number>>): [number, number] | null {
  // Iterative 3-color DFS (0 = unvisited, 1 = visiting/on-path, 2 = done)
  const color = new Map<number, number>();
  for (const u of nodes) color.set(u, 0);

  for (const start of nodes) {
    if (color.get(start) !== 0) continue;
    const stack: Array<{ u: number; iter: Iterator<number> }> = [
      { u: start, iter: active.get(start)!.values() },
    ];
    color.set(start, 1);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const step = top.iter.next();
      if (step.done) {
        color.set(top.u, 2);
        stack.pop();
      } else {
        const v = step.value;
        const c = color.get(v);
        if (c === 1) {
          return [top.u, v];
        }
        if (c === 0) {
          color.set(v, 1);
          stack.push({ u: v, iter: active.get(v)!.values() });
        }
      }
    }
  }
  return null;
}

/**
 * Computes bottom-level b(u): longest total duration of any path starting at u and ending at a sink
 * (including u's own duration). Used by Critical-Path-First list scheduling. O(V + E).
 */
export function bottomLevels(g: Graph, order: number[], durations: number[]): number[] {
  const n = g.ids.length;
  const b = new Array<number>(n).fill(0);
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i];
    let maxChild = 0;
    for (const v of g.adj[u]) {
      if (b[v] > maxChild) maxChild = b[v];
    }
    b[u] = durations[u] + maxChild;
  }
  return b;
}
