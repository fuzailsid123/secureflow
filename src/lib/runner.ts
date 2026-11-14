import { randomUUID } from 'node:crypto';
import { LIMITS } from './limits';
import { bottomLevels } from './scc';
import {
  buildFinding,
  compileScanners,
  CycleError,
  finalizeScanners,
  PriorityHeap,
  scanChunk,
  type SimulateOptions,
} from './simulate';
import { saveRun } from './store';
import { buildGraph, criticalPath, descendants, topoSort } from './topo';
import type {
  Finding,
  Run,
  RunEvent,
  ScannerMode,
  SchedulePolicy,
  TaskResult,
  TaskState,
  Workflow,
} from './types';

export interface LiveRunOptions extends SimulateOptions {
  /** Virtual-ms per real-ms while streaming chunks (default 4, capped [0.1, 10000]). */
  speed?: number;
}

interface ActiveLiveRun {
  run: Run;
  subscribers: Set<{ onEvent: (ev: RunEvent) => void; onEnd: () => void }>;
  abortAll: AbortController;
  donePromise: Promise<void>;
}

function registry(): Map<string, ActiveLiveRun> {
  const g = globalThis as typeof globalThis & { __secureflowLiveRuns?: Map<string, ActiveLiveRun> };
  if (!g.__secureflowLiveRuns) g.__secureflowLiveRuns = new Map();
  return g.__secureflowLiveRuns;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms < 1) return Promise.resolve(!signal.aborted);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Produces an asynchronous `ReadableStream<Uint8Array>` emitting the task log in `LIMITS.chunkBytes`
 * chunks paced over real time (`durationMs / speed`), aborting immediately when `signal` fires.
 */
function createTaskByteStream(
  bytes: Buffer,
  durationMs: number,
  speed: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const totalRealMs = Math.min(durationMs / speed, 15_000);
  if (bytes.length === 0) {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const ok = await abortableSleep(totalRealMs, signal);
        if (!ok) {
          try {
            controller.close();
          } catch {
            /* ignore */
          }
          return;
        }
        controller.close();
      },
    });
  }

  let pos = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted || pos >= bytes.length) {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        return;
      }
      const nextPos = Math.min(bytes.length, pos + LIMITS.chunkBytes);
      const slice = bytes.subarray(pos, nextPos);
      const frac = slice.length / bytes.length;
      pos = nextPos;
      const ok = await abortableSleep(totalRealMs * frac, signal);
      if (!ok || signal.aborted) {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        return;
      }
      controller.enqueue(slice);
    },
  });
}

/**
 * Starts a real asynchronous chunked streaming workflow run on a worker pool.
 * Returns immediately once validated and persisted in `'running'` state; clients subscribe via SSE.
 */
export async function startLiveRun(
  wf: Pick<Workflow, 'id' | 'name' | 'tasks' | 'edges' | 'patterns'>,
  workers: number,
  options: LiveRunOptions = {},
): Promise<Run> {
  if (wf.tasks.length === 0) throw new Error('Workflow has no tasks');
  if (!Number.isInteger(workers) || workers < LIMITS.minWorkers || workers > LIMITS.maxWorkers) {
    throw new Error(`workers must be an integer between ${LIMITS.minWorkers} and ${LIMITS.maxWorkers}`);
  }

  const policy: SchedulePolicy = options.policy ?? 'topo-fifo';
  const scannerMode: ScannerMode = options.scanner ?? 'kmp';
  const speed = Math.min(10000, Math.max(0.1, options.speed ?? 4));
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
  const cp = criticalPath(g, flat, durations);

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
  if (options.seededCompleted) {
    for (const u of flat) {
      if (options.seededCompleted.has(ids[u])) {
        state[u] = 'completed';
        results[u] = { id: ids[u], state: 'completed' };
        for (const v of g.adj[u]) remaining[v]--;
      }
    }
  }

  const runId = randomUUID();
  const run: Run = {
    id: runId,
    workflowId: wf.id,
    workflowName: wf.name,
    createdAt: new Date().toISOString(),
    workers,
    status: 'running',
    mode: 'live',
    policy,
    scanner: scannerMode,
    resumedFromRunId: options.resumedFromRunId,
    allowlistedPatterns: options.allowlistedPatterns,
    levels: sorted.levels.map((lv) => lv.map((i) => ids[i])),
    tasks: results,
    findings: [],
    metrics: {
      makespanMs: 0,
      sequentialMs: 0,
      speedup: 1,
      utilization: 0,
      criticalPath: cp.path.map((i) => ids[i]),
      criticalPathMs: cp.lengthMs,
      scheduleMs,
      scanMs: 0,
      bytesScanned: 0,
      completed: state.filter((s) => s === 'completed').length,
      quarantined: 0,
      cancelled: 0,
    },
    eventCount: 0,
    events: [],
  };

  await saveRun(run);

  const active: ActiveLiveRun = {
    run,
    subscribers: new Set(),
    abortAll: new AbortController(),
    donePromise: Promise.resolve(),
  };
  registry().set(runId, active);

  const emit = (ev: RunEvent) => {
    run.events.push(ev);
    run.eventCount = run.events.length;
    for (const sub of active.subscribers) {
      try {
        sub.onEvent(ev);
      } catch {
        /* ignore subscriber error */
      }
    }
  };

  active.donePromise = (async () => {
    const wall0 = performance.now();
    const vNow = () => Math.max(0, Math.round((performance.now() - wall0) * speed));

    const ready = new PriorityHeap<number>(cmpTask);
    for (let i = 0; i < n; i++) {
      if (state[i] === 'pending' && remaining[i] === 0) ready.push(i);
    }

    const freeWorkers = new Set<number>(Array.from({ length: workers }, (_, i) => i));
    const inFlight = new Map<number, Promise<void>>();
    let busyMs = 0;
    let sequentialMs = 0;
    let scanMs = 0;
    let bytesScanned = 0;

    const launchTask = (task: number, worker: number) => {
      freeWorkers.delete(worker);
      state[task] = 'running';
      const startMs = vNow();
      results[task] = { id: ids[task], state: 'running', worker, startMs };
      emit({ t: startMs, type: 'task_start', taskId: ids[task], worker });

      const taskAbort = new AbortController();
      const onGlobalAbort = () => taskAbort.abort();
      active.abortAll.signal.addEventListener('abort', onGlobalAbort, { once: true });

      const p = (async () => {
        const bytes = Buffer.from(wf.tasks[task].log, 'utf8');
        const scanners = compileScanners(
          activePatterns,
          scannerMode,
          options.regexPatterns ?? [],
          options.entropyThreshold,
        );
        const stream = createTaskByteStream(bytes, durations[task], speed, taskAbort.signal);
        const reader = stream.getReader();
        let violation = null;
        let readBytes = 0;

        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || taskAbort.signal.aborted) break;
            readBytes += value.length;
            const sc0 = performance.now();
            const hit = scanChunk(value, scanners);
            scanMs += performance.now() - sc0;
            if (hit) {
              violation = hit;
              taskAbort.abort();
              await reader.cancel().catch(() => undefined);
              break;
            }
          }
          if (!violation && !taskAbort.signal.aborted) {
            const sc0 = performance.now();
            violation = finalizeScanners(bytes, scanners);
            scanMs += performance.now() - sc0;
          }
        } finally {
          active.abortAll.signal.removeEventListener('abort', onGlobalAbort);
          reader.releaseLock();
        }

        bytesScanned += readBytes;
        const endMs = Math.max(startMs + 1, vNow());
        freeWorkers.add(worker);

        if (active.abortAll.signal.aborted && !violation) {
          state[task] = 'cancelled';
          results[task].state = 'cancelled';
          results[task].endMs = endMs;
          results[task].cancelledBy = 'USER_CANCEL';
          emit({ t: endMs, type: 'task_cancelled', taskId: ids[task], because: 'USER_CANCEL' });
          return;
        }

        busyMs += endMs - startMs;
        sequentialMs += endMs - startMs;
        results[task].endMs = endMs;

        if (!violation) {
          state[task] = 'completed';
          results[task].state = 'completed';
          emit({ t: endMs, type: 'task_complete', taskId: ids[task] });
          for (const v of g.adj[task]) {
            if (--remaining[v] === 0 && state[v] === 'pending') ready.push(v);
          }
        } else {
          const finding: Finding = buildFinding(ids[task], bytes, violation);
          state[task] = 'quarantined';
          results[task].state = 'quarantined';
          run.findings.push(finding);
          emit({ t: endMs, type: 'task_quarantined', taskId: ids[task], finding });
          for (const d of descendants(g, task)) {
            if (state[d] === 'cancelled' || state[d] === 'completed') continue;
            state[d] = 'cancelled';
            results[d] = { id: ids[d], state: 'cancelled', cancelledBy: ids[task] };
            emit({ t: endMs, type: 'task_cancelled', taskId: ids[d], because: ids[task] });
          }
        }
      })().finally(() => {
        inFlight.delete(task);
      });

      inFlight.set(task, p);
    };

    while (!active.abortAll.signal.aborted) {
      while (ready.size > 0 && freeWorkers.size > 0) {
        const w = Math.min(...freeWorkers);
        const task = ready.pop();
        launchTask(task, w);
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight.values());
    }

    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight.values());
    }

    const finalT = vNow();
    if (active.abortAll.signal.aborted) {
      for (let i = 0; i < n; i++) {
        if (state[i] === 'pending') {
          state[i] = 'cancelled';
          results[i] = { id: ids[i], state: 'cancelled', cancelledBy: 'USER_CANCEL' };
          emit({ t: finalT, type: 'task_cancelled', taskId: ids[i], because: 'USER_CANCEL' });
        }
      }
      run.status = 'cancelled';
      emit({ t: finalT, type: 'run_cancelled', reason: 'Cancelled by user' });
    } else {
      run.status = 'completed';
      emit({ t: finalT, type: 'run_complete' });
    }

    const count = (s: TaskState) => state.filter((x) => x === s).length;
    run.metrics = {
      makespanMs: finalT,
      sequentialMs,
      speedup: finalT > 0 ? sequentialMs / finalT : 1,
      utilization: finalT > 0 ? Math.min(1, busyMs / (workers * finalT)) : 0,
      criticalPath: cp.path.map((i) => ids[i]),
      criticalPathMs: cp.lengthMs,
      scheduleMs,
      scanMs,
      bytesScanned,
      completed: count('completed'),
      quarantined: count('quarantined'),
      cancelled: count('cancelled'),
    };

    await saveRun(run);
    for (const sub of active.subscribers) {
      try {
        sub.onEnd();
      } catch {
        /* ignore */
      }
    }
    active.subscribers.clear();
    registry().delete(runId);
  })();

  return run;
}

export function getActiveLiveRun(runId: string): Run | null {
  return registry().get(runId)?.run ?? null;
}

export async function cancelLiveRun(runId: string): Promise<boolean> {
  const active = registry().get(runId);
  if (!active) return false;
  active.abortAll.abort();
  await active.donePromise;
  return true;
}

export function subscribeLiveRun(
  runId: string,
  onEvent: (ev: RunEvent) => void,
  onEnd: () => void,
): { active: boolean; backlog: RunEvent[]; unsubscribe: () => void } | null {
  const active = registry().get(runId);
  if (!active) return null;
  const sub = { onEvent, onEnd };
  const backlog = [...active.run.events];
  active.subscribers.add(sub);
  return {
    active: true,
    backlog,
    unsubscribe: () => active.subscribers.delete(sub),
  };
}
