import { AhoCorasickScanner } from './ahoCorasick';
import { KMPScanner, LineIndex } from './kmp';
import { LIMITS } from './limits';
import { extractSnippet, NFAScanner, scanEntropy } from './nfa';
import { bottomLevels } from './scc';
import { buildGraph, criticalPath, descendants, topoSort } from './topo';
import type {
  Finding,
  RuleKind,
  Run,
  RunEvent,
  ScannerMode,
  SchedulePolicy,
  TaskResult,
  TaskState,
  Workflow,
} from './types';

export class CycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Circular dependency: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
  }
}

export interface SimulateOptions {
  policy?: SchedulePolicy;
  scanner?: ScannerMode;
  regexPatterns?: string[];
  entropyThreshold?: number;
  allowlistedPatterns?: string[];
  seededCompleted?: ReadonlySet<string>;
  resumedFromRunId?: string;
}

/** Generic binary min-heap parameterized by comparator. */
export class PriorityHeap<T> {
  private a: T[] = [];
  constructor(private readonly cmp: (x: T, y: T) => number) {}
  get size(): number {
    return this.a.length;
  }
  push(x: T): void {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[p], a[i]) <= 0) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): T {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface Violation {
  pattern: string;
  start: number;
  end: number;
  ruleKind: RuleKind;
  entropy?: number;
}

export interface CompiledScanners {
  mode: ScannerMode;
  kmp: KMPScanner[];
  ac: AhoCorasickScanner | null;
  nfa: NFAScanner[];
  entropyThreshold?: number;
}

export function compileScanners(
  patterns: readonly string[],
  mode: ScannerMode = 'kmp',
  regexPatterns: readonly string[] = [],
  entropyThreshold?: number,
): CompiledScanners {
  const kmp = mode === 'kmp' ? patterns.map((p) => new KMPScanner(p)) : [];
  const ac = mode === 'aho-corasick' && patterns.length > 0 ? new AhoCorasickScanner(patterns) : null;
  const nfa = regexPatterns.map((r) => new NFAScanner(r));
  return { mode, kmp, ac, nfa, entropyThreshold };
}

export function resetScanners(c: CompiledScanners): void {
  for (const s of c.kmp) s.reset();
  c.ac?.reset();
  for (const n of c.nfa) n.reset();
}

/** Feeds a single chunk into compiled scanners and returns the earliest-ending violation in that chunk, if any. */
export function scanChunk(chunk: Uint8Array, c: CompiledScanners): Violation | null {
  let best: Violation | null = null;
  const consider = (v: Violation) => {
    if (!best || v.end < best.end || (v.end === best.end && v.start < best.start)) best = v;
  };

  if (c.ac) {
    const hits = c.ac.feed(chunk);
    for (const h of hits) {
      consider({
        pattern: h.pattern,
        start: h.byteOffset,
        end: h.byteOffset + c.ac.patternLengths[h.patternIndex],
        ruleKind: 'literal',
      });
    }
  } else {
    for (const s of c.kmp) {
      const hits = s.feed(chunk);
      if (hits.length > 0) {
        const start = hits[0];
        consider({ pattern: s.pattern, start, end: start + s.length, ruleKind: 'literal' });
      }
    }
  }

  for (const n of c.nfa) {
    const hits = n.feed(chunk);
    if (hits.length > 0) {
      consider({ pattern: hits[0].pattern, start: hits[0].start, end: hits[0].end, ruleKind: 'regex' });
    }
  }

  return best;
}

/** Finalizes stream scanners at EOF (e.g., pending NFA matches and entropy check). */
export function finalizeScanners(fullBytes: Uint8Array, c: CompiledScanners): Violation | null {
  let best: Violation | null = null;
  const consider = (v: Violation) => {
    if (!best || v.end < best.end) best = v;
  };
  for (const n of c.nfa) {
    const hits = n.end();
    if (hits.length > 0) {
      consider({ pattern: hits[0].pattern, start: hits[0].start, end: hits[0].end, ruleKind: 'regex' });
    }
  }
  if (c.entropyThreshold !== undefined && !best) {
    const ent = scanEntropy(fullBytes, c.entropyThreshold, 20, 1);
    if (ent.length > 0) {
      consider({
        pattern: `HIGH_ENTROPY(H>=${c.entropyThreshold.toFixed(1)})`,
        start: ent[0].start,
        end: ent[0].end,
        ruleKind: 'entropy',
        entropy: ent[0].entropy,
      });
    }
  }
  return best;
}

export function buildFinding(taskId: string, bytes: Uint8Array, v: Violation): Finding {
  const loc = new LineIndex(bytes).locate(v.start);
  const f: Finding = {
    taskId,
    pattern: v.pattern,
    byteOffset: v.start,
    line: loc.line,
    column: loc.column,
    ruleKind: v.ruleKind,
    context: extractSnippet(bytes, v.start, Math.max(1, v.end - v.start), loc.lineStart, loc.lineEnd),
  };
  if (v.entropy !== undefined) f.entropy = v.entropy;
  return f;
}

/**
 * Streams a task log through the configured scanners chunk by chunk, stopping at the first
 * chunk in which any pattern completes.
 */
function scanLog(
  bytes: Buffer,
  scanners: CompiledScanners,
): { violation: Violation | null; bytesScanned: number } {
  const hasAny =
    scanners.kmp.length > 0 ||
    scanners.ac !== null ||
    scanners.nfa.length > 0 ||
    scanners.entropyThreshold !== undefined;
  if (!hasAny || bytes.length === 0) return { violation: null, bytesScanned: 0 };
  resetScanners(scanners);
  for (let pos = 0; pos < bytes.length; pos += LIMITS.chunkBytes) {
    const chunk = bytes.subarray(pos, pos + LIMITS.chunkBytes);
    const hit = scanChunk(chunk, scanners);
    if (hit) return { violation: hit, bytesScanned: Math.min(bytes.length, pos + chunk.length) };
  }
  const tailHit = finalizeScanners(bytes, scanners);
  return { violation: tailHit, bytesScanned: bytes.length };
}

interface Running {
  task: number;
  worker: number;
  end: number;
  quarantine: boolean;
  finding?: Finding;
}

/**
 * Deterministic discrete-event simulation of a workflow run on a fixed worker pool.
 *
 *  1. Topological sort (source removal) fixes the dispatch priority and detects cycles.
 *  2. Ready tasks (all prerequisites completed) are dispatched according to `policy`
 *     (`topo-fifo` default, `critical-path` by bottom-level, or `shortest-first`) to the
 *     lowest-numbered free worker.
 *  3. When a task starts, its log is streamed through KMP or Aho-Corasick (+ optional NFA/entropy).
 *     A violation stops the task at the proportional point of its duration, quarantines it, and a
 *     DFS over the same adjacency list cancels every downstream task. Unrelated tasks keep running.
 */
export function simulateRun(
  wf: Pick<Workflow, 'id' | 'name' | 'tasks' | 'edges' | 'patterns'>,
  workers: number,
  options: SimulateOptions = {},
): Omit<Run, 'id' | 'createdAt'> {
  if (wf.tasks.length === 0) throw new Error('Workflow has no tasks');
  if (!Number.isInteger(workers) || workers < LIMITS.minWorkers || workers > LIMITS.maxWorkers) {
    throw new Error(`workers must be an integer between ${LIMITS.minWorkers} and ${LIMITS.maxWorkers}`);
  }

  const policy: SchedulePolicy = options.policy ?? 'topo-fifo';
  const scannerMode: ScannerMode = options.scanner ?? 'kmp';
  const allowSet = new Set(options.allowlistedPatterns ?? []);
  const activePatterns = wf.patterns.filter((p) => !allowSet.has(p));

  const ids = wf.tasks.map((t) => t.id);
  const durations = wf.tasks.map((t) => t.durationMs);
  const n = ids.length;

  const s0 = performance.now();
  const g = buildGraph(ids, wf.edges);
  const sorted = topoSort(g);
  const scheduleMs = performance.now() - s0;
  if (!sorted.ok) throw new CycleError(sorted.cycle.map((i) => ids[i]));

  const flat = sorted.levels.flat();
  const pos = new Int32Array(n);
  flat.forEach((task, p) => (pos[task] = p));
  const bLevels = policy === 'critical-path' ? bottomLevels(g, flat, durations) : null;

  const cmpTask = (a: number, b: number): number => {
    if (policy === 'critical-path' && bLevels) {
      const diff = bLevels[b] - bLevels[a];
      if (diff !== 0) return diff;
    } else if (policy === 'shortest-first') {
      const diff = durations[a] - durations[b];
      if (diff !== 0) return diff;
    }
    return pos[a] - pos[b];
  };

  const remaining = g.indeg.slice();
  const state: TaskState[] = new Array(n).fill('pending');
  const results: TaskResult[] = ids.map((id) => ({ id, state: 'pending' }));
  const events: RunEvent[] = [];
  const findings: Finding[] = [];
  const scanners = compileScanners(
    activePatterns,
    scannerMode,
    options.regexPatterns ?? [],
    options.entropyThreshold,
  );

  // Seed pre-completed tasks when resuming a failed/quarantined run incrementally.
  const seeded = options.seededCompleted;
  if (seeded && seeded.size > 0) {
    for (const u of flat) {
      if (seeded.has(ids[u])) {
        state[u] = 'completed';
        results[u] = { id: ids[u], state: 'completed' };
        for (const v of g.adj[u]) {
          remaining[v]--;
        }
      }
    }
  }

  const ready = new PriorityHeap<number>(cmpTask);
  for (let i = 0; i < n; i++) {
    if (state[i] === 'pending' && remaining[i] === 0) ready.push(i);
  }

  const freeWorker: boolean[] = new Array(workers).fill(true);
  const running: Running[] = [];
  let t = 0;
  let busyMs = 0;
  let sequentialMs = 0;
  let scanMs = 0;
  let bytesScanned = 0;

  for (;;) {
    while (ready.size > 0) {
      const w = freeWorker.indexOf(true);
      if (w === -1) break;
      const task = ready.pop();
      freeWorker[w] = false;
      state[task] = 'running';

      const bytes = Buffer.from(wf.tasks[task].log, 'utf8');
      const sc0 = performance.now();
      const scan = scanLog(bytes, scanners);
      scanMs += performance.now() - sc0;
      bytesScanned += scan.bytesScanned;

      const duration = durations[task];
      let end = t + duration;
      let finding: Finding | undefined;
      if (scan.violation) {
        end = t + Math.max(1, Math.round(duration * (scan.violation.end / bytes.length)));
        finding = buildFinding(ids[task], bytes, scan.violation);
      }
      results[task] = { id: ids[task], state: 'running', worker: w, startMs: t };
      events.push({ t, type: 'task_start', taskId: ids[task], worker: w });
      running.push({ task, worker: w, end, quarantine: !!scan.violation, finding });
    }
    if (running.length === 0) break;

    let bi = 0;
    for (let r = 1; r < running.length; r++) {
      const a = running[r];
      const b = running[bi];
      if (a.end < b.end || (a.end === b.end && pos[a.task] < pos[b.task])) bi = r;
    }
    const fin = running.splice(bi, 1)[0];
    t = fin.end;
    freeWorker[fin.worker] = true;
    const startMs = results[fin.task].startMs ?? 0;
    busyMs += fin.end - startMs;
    sequentialMs += fin.end - startMs;
    results[fin.task].endMs = fin.end;

    if (!fin.quarantine) {
      state[fin.task] = 'completed';
      results[fin.task].state = 'completed';
      events.push({ t, type: 'task_complete', taskId: ids[fin.task] });
      for (const v of g.adj[fin.task]) {
        if (--remaining[v] === 0 && state[v] === 'pending') ready.push(v);
      }
    } else {
      state[fin.task] = 'quarantined';
      results[fin.task].state = 'quarantined';
      findings.push(fin.finding!);
      events.push({ t, type: 'task_quarantined', taskId: ids[fin.task], finding: fin.finding! });
      for (const d of descendants(g, fin.task)) {
        if (state[d] === 'cancelled' || state[d] === 'completed') continue;
        state[d] = 'cancelled';
        results[d] = { id: ids[d], state: 'cancelled', cancelledBy: ids[fin.task] };
        events.push({ t, type: 'task_cancelled', taskId: ids[d], because: ids[fin.task] });
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (state[i] === 'pending' || state[i] === 'running') {
      throw new Error(`Internal error: task "${ids[i]}" was never scheduled`);
    }
  }
  events.push({ t, type: 'run_complete' });

  const cp = criticalPath(g, flat, durations);
  const count = (s: TaskState) => state.filter((x) => x === s).length;

  return {
    workflowId: wf.id,
    workflowName: wf.name,
    workers,
    status: 'completed',
    mode: 'simulate',
    policy,
    scanner: scannerMode,
    resumedFromRunId: options.resumedFromRunId,
    allowlistedPatterns: options.allowlistedPatterns,
    levels: sorted.levels.map((lv) => lv.map((i) => ids[i])),
    tasks: results,
    findings,
    metrics: {
      makespanMs: t,
      sequentialMs,
      speedup: t > 0 ? sequentialMs / t : 1,
      utilization: t > 0 ? busyMs / (workers * t) : 0,
      criticalPath: cp.path.map((i) => ids[i]),
      criticalPathMs: cp.lengthMs,
      scheduleMs,
      scanMs,
      bytesScanned,
      completed: count('completed'),
      quarantined: count('quarantined'),
      cancelled: count('cancelled'),
    },
    eventCount: events.length,
    events,
  };
}
