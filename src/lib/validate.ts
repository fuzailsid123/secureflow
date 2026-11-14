import { ID_PATTERN, LIMITS } from './limits';
import { NFAScanner, RegexCompileError } from './nfa';
import type { Edge, RunMode, ScannerMode, SchedulePolicy, Task, WorkflowInput } from './types';

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const MAX_ERRORS = 10;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Validates and normalizes a workflow payload: trims names, defaults, drops duplicate edges. */
export function validateWorkflowInput(body: unknown): Validation<WorkflowInput> {
  const errors: string[] = [];
  const err = (m: string) => {
    if (errors.length < MAX_ERRORS) errors.push(m);
  };
  if (!isRecord(body)) return { ok: false, errors: ['Body must be a JSON object'] };

  // name
  let name = '';
  if (typeof body.name !== 'string') err('name must be a string');
  else {
    name = body.name.trim();
    if (name.length < 1 || name.length > LIMITS.maxNameLength)
      err(`name must be 1-${LIMITS.maxNameLength} characters`);
  }

  // tasks
  const tasks: Task[] = [];
  const idSet = new Set<string>();
  let totalLog = 0;
  if (!Array.isArray(body.tasks)) err('tasks must be an array');
  else {
    if (body.tasks.length > LIMITS.maxTasks) err(`at most ${LIMITS.maxTasks} tasks are allowed`);
    else {
      body.tasks.forEach((raw, i) => {
        if (!isRecord(raw)) return err(`tasks[${i}] must be an object`);
        const id = raw.id;
        if (typeof id !== 'string' || id.length === 0 || id.length > LIMITS.maxIdLength || !ID_PATTERN.test(id)) {
          return err(`tasks[${i}].id must be 1-${LIMITS.maxIdLength} chars of letters, digits, "_", "-" or "."`);
        }
        if (idSet.has(id)) return err(`duplicate task id "${id}"`);
        idSet.add(id);
        const durationMs = raw.durationMs;
        if (
          typeof durationMs !== 'number' ||
          !Number.isInteger(durationMs) ||
          durationMs < 1 ||
          durationMs > LIMITS.maxDurationMs
        ) {
          return err(`task "${id}": durationMs must be an integer from 1 to ${LIMITS.maxDurationMs}`);
        }
        const tname = raw.name === undefined ? id : raw.name;
        if (typeof tname !== 'string' || tname.length > LIMITS.maxNameLength) {
          return err(`task "${id}": name must be a string of at most ${LIMITS.maxNameLength} characters`);
        }
        const log = raw.log === undefined ? '' : raw.log;
        if (typeof log !== 'string') return err(`task "${id}": log must be a string`);
        const logBytes = Buffer.byteLength(log, 'utf8');
        if (logBytes > LIMITS.maxTaskLogBytes) {
          return err(`task "${id}": log exceeds ${LIMITS.maxTaskLogBytes} bytes`);
        }
        totalLog += logBytes;
        tasks.push({ id, name: tname || id, durationMs, log });
      });
      if (totalLog > LIMITS.maxTotalLogBytes) err(`total log size exceeds ${LIMITS.maxTotalLogBytes} bytes`);
    }
  }

  // edges
  const edges: Edge[] = [];
  if (!Array.isArray(body.edges)) err('edges must be an array');
  else if (body.edges.length > LIMITS.maxEdges) err(`at most ${LIMITS.maxEdges} dependencies are allowed`);
  else {
    const seen = new Set<string>();
    body.edges.forEach((raw, i) => {
      if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'string' || typeof raw[1] !== 'string') {
        return err(`edges[${i}] must be a [from, to] pair of task ids`);
      }
      const [a, b] = raw as [string, string];
      if (!idSet.has(a) || !idSet.has(b)) return err(`edges[${i}] (${a} -> ${b}) references an unknown task`);
      const key = `${a}\u0000${b}`;
      if (seen.has(key)) return; // duplicate edges are ignored
      seen.add(key);
      edges.push([a, b]);
    });
  }

  // patterns
  const patterns: string[] = [];
  if (!Array.isArray(body.patterns)) err('patterns must be an array');
  else if (body.patterns.length > LIMITS.maxPatterns) err(`at most ${LIMITS.maxPatterns} patterns are allowed`);
  else {
    const seen = new Set<string>();
    body.patterns.forEach((p, i) => {
      if (typeof p !== 'string' || p.length === 0) return err(`patterns[${i}] must be a non-empty string`);
      if (Buffer.byteLength(p, 'utf8') > LIMITS.maxPatternBytes)
        return err(`patterns[${i}] exceeds ${LIMITS.maxPatternBytes} bytes`);
      if (seen.has(p)) return err(`duplicate pattern "${p}"`);
      seen.add(p);
      patterns.push(p);
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name, tasks, edges, patterns } };
}

export function validateWorkers(x: unknown): Validation<number> {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < LIMITS.minWorkers || x > LIMITS.maxWorkers) {
    return { ok: false, errors: [`workers must be an integer from ${LIMITS.minWorkers} to ${LIMITS.maxWorkers}`] };
  }
  return { ok: true, value: x };
}

/** Validates a list of patterns for the standalone audit endpoint. */
export function validatePatternList(x: unknown): Validation<string[]> {
  if (!Array.isArray(x) || x.length < 1 || x.length > LIMITS.maxPatterns) {
    return { ok: false, errors: [`patterns must be an array of 1-${LIMITS.maxPatterns} strings`] };
  }
  const out: string[] = [];
  for (const p of x) {
    if (typeof p !== 'string' || p.length === 0) return { ok: false, errors: ['every pattern must be a non-empty string'] };
    if (Buffer.byteLength(p, 'utf8') > LIMITS.maxPatternBytes)
      return { ok: false, errors: [`patterns may be at most ${LIMITS.maxPatternBytes} bytes`] };
    if (!out.includes(p)) out.push(p);
  }
  return { ok: true, value: out };
}

export function validateSchedulePolicy(x: unknown): Validation<SchedulePolicy> {
  if (x === undefined) return { ok: true, value: 'topo-fifo' };
  if (x === 'topo-fifo' || x === 'critical-path' || x === 'shortest-first') return { ok: true, value: x };
  return { ok: false, errors: ['policy must be "topo-fifo", "critical-path", or "shortest-first"'] };
}

export function validateScannerMode(x: unknown): Validation<ScannerMode> {
  if (x === undefined) return { ok: true, value: 'kmp' };
  if (x === 'kmp' || x === 'aho-corasick') return { ok: true, value: x };
  return { ok: false, errors: ['scanner must be "kmp" or "aho-corasick"'] };
}

export function validateRunMode(x: unknown): Validation<RunMode> {
  if (x === undefined) return { ok: true, value: 'simulate' };
  if (x === 'simulate' || x === 'live') return { ok: true, value: x };
  return { ok: false, errors: ['mode must be "simulate" or "live"'] };
}

export function validateRegexList(x: unknown): Validation<string[]> {
  if (x === undefined) return { ok: true, value: [] };
  if (!Array.isArray(x) || x.length > LIMITS.maxRegexPatterns) {
    return { ok: false, errors: [`regexPatterns must be an array of at most ${LIMITS.maxRegexPatterns} strings`] };
  }
  const out: string[] = [];
  for (const r of x) {
    if (typeof r !== 'string' || r.length === 0) return { ok: false, errors: ['every regex pattern must be non-empty'] };
    if (Buffer.byteLength(r, 'utf8') > LIMITS.maxPatternBytes) {
      return { ok: false, errors: [`regex pattern exceeds ${LIMITS.maxPatternBytes} bytes`] };
    }
    try {
      new NFAScanner(r);
    } catch (e) {
      return {
        ok: false,
        errors: [e instanceof RegexCompileError ? `Invalid regex "${r}": ${e.message}` : `Invalid regex "${r}"`],
      };
    }
    if (!out.includes(r)) out.push(r);
  }
  return { ok: true, value: out };
}

export function validateEntropyThreshold(x: unknown): Validation<number | undefined> {
  if (x === undefined || x === null) return { ok: true, value: undefined };
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 2.0 || x > 8.0) {
    return { ok: false, errors: ['entropyThreshold must be a number between 2.0 and 8.0'] };
  }
  return { ok: true, value: x };
}
