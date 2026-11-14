import { LIMITS } from './limits';
import type { Edge, Task, WorkflowInput } from './types';

export type DagShape = 'layered' | 'diamond' | 'chain' | 'random-dag' | 'multi-cycle';

export interface GeneratorOptions {
  shape: DagShape;
  taskCount: number;
  seed?: number;
  injectLeak?: boolean;
  patterns?: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSyntheticLog(id: string, bytesTarget: number, leak?: { pattern: string; at: number }): string {
  let s = '';
  for (let i = 0; s.length < bytesTarget; i++) {
    s += `[${id}] ${String(i).padStart(4, '0')} INFO step OK (${(i * 29) % 500}ms)\n`;
  }
  const base = s.slice(0, bytesTarget);
  if (!leak) return base;
  const pos = Math.min(Math.max(0, leak.at), Math.max(0, base.length - leak.pattern.length));
  return base.slice(0, pos) + leak.pattern + base.slice(pos + leak.pattern.length);
}

/**
 * Generates deterministic stress-test workflows of arbitrary shape and scale (up to 5,000 tasks),
 * optionally injecting a chunk-boundary-straddling leak into a middle node.
 */
export function generateSyntheticWorkflow(opts: GeneratorOptions): WorkflowInput {
  const count = Math.min(LIMITS.maxTasks, Math.max(2, Math.round(opts.taskCount)));
  const rnd = mulberry32(opts.seed ?? 1337);
  const patterns = opts.patterns?.length
    ? opts.patterns
    : ['UNAUTHORIZED_ACCESS', 'AWS_SECRET_ACCESS_KEY', 'DEPRECATED_CALL'];

  const tasks: Task[] = [];
  const edges: Edge[] = [];
  const edgeSet = new Set<string>();
  const addEdge = (a: string, b: string) => {
    if (edges.length >= LIMITS.maxEdges) return;
    const key = `${a}\u0000${b}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push([a, b]);
  };

  const leakIdx = opts.injectLeak ? Math.floor(count / 3) : -1;
  for (let i = 0; i < count; i++) {
    const id = `t${String(i).padStart(count >= 1000 ? 4 : 2, '0')}`;
    const dur = 400 + Math.floor(rnd() * 2600);
    const isLeak = i === leakIdx;
    // If leak injected, size log to 6,000 bytes and place pattern straddling 4096-byte boundary.
    const log = isLeak
      ? makeSyntheticLog(id, 6000, { pattern: patterns[0], at: 4088 })
      : makeSyntheticLog(id, count > 500 ? 120 : 800);
    tasks.push({ id, name: `Task ${id}`, durationMs: dur, log });
  }

  const idOf = (i: number) => tasks[i].id;

  switch (opts.shape) {
    case 'chain': {
      for (let i = 0; i < count - 1; i++) addEdge(idOf(i), idOf(i + 1));
      break;
    }
    case 'diamond': {
      // Fan-out from t0 -> middle tier(s) -> sink t_{n-1}
      if (count <= 2) {
        addEdge(idOf(0), idOf(1));
      } else {
        const layers = Math.max(1, Math.min(5, Math.floor(Math.sqrt(count - 2))));
        const mid = count - 2;
        const perLayer = Math.ceil(mid / layers);
        const groups: number[][] = [];
        for (let l = 0; l < layers; l++) {
          const g: number[] = [];
          for (let j = l * perLayer; j < Math.min(mid, (l + 1) * perLayer); j++) g.push(j + 1);
          if (g.length > 0) groups.push(g);
        }
        for (const u of groups[0]) addEdge(idOf(0), idOf(u));
        for (let l = 0; l < groups.length - 1; l++) {
          for (const u of groups[l]) {
            const nextG = groups[l + 1];
            addEdge(idOf(u), idOf(nextG[u % nextG.length]));
            if (nextG.length > 1) addEdge(idOf(u), idOf(nextG[(u + 1) % nextG.length]));
          }
        }
        for (const u of groups[groups.length - 1]) addEdge(idOf(u), idOf(count - 1));
      }
      break;
    }
    case 'layered': {
      const width = Math.max(2, Math.min(8, Math.ceil(Math.sqrt(count))));
      for (let i = width; i < count; i++) {
        const prevStart = Math.max(0, Math.floor(i / width) * width - width);
        const prevEnd = Math.floor(i / width) * width;
        const p1 = prevStart + (i % Math.max(1, prevEnd - prevStart));
        const p2 = prevStart + ((i + 1) % Math.max(1, prevEnd - prevStart));
        addEdge(idOf(p1), idOf(i));
        if (p2 !== p1) addEdge(idOf(p2), idOf(i));
      }
      break;
    }
    case 'random-dag': {
      const targetEdges = Math.min(LIMITS.maxEdges, count * 3);
      for (let k = 0; k < targetEdges; k++) {
        const u = Math.floor(rnd() * (count - 1));
        const span = Math.max(1, Math.min(count - 1 - u, 16));
        const v = u + 1 + Math.floor(rnd() * span);
        addEdge(idOf(u), idOf(v));
      }
      break;
    }
    case 'multi-cycle': {
      for (let i = 0; i < count - 1; i++) addEdge(idOf(i), idOf(i + 1));
      // Add two disjoint cycles (or one if count < 6)
      if (count >= 4) addEdge(idOf(2), idOf(0));
      if (count >= 8) addEdge(idOf(count - 1), idOf(count - 3));
      else if (count >= 2) addEdge(idOf(count - 1), idOf(count - 2));
      break;
    }
  }

  return {
    name: `Generated ${opts.shape} (${count} tasks)`,
    tasks,
    edges,
    patterns,
  };
}
