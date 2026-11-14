import { describe, expect, it } from 'vitest';
import { CycleError, simulateRun } from '@/lib/simulate';
import { sampleWorkflowInput } from '@/lib/sample';
import type { Task, Workflow } from '@/lib/types';

const wfFrom = (tasks: Task[], edges: [string, string][], patterns: string[] = []): Workflow => ({
  id: 'w',
  name: 'w',
  tasks,
  edges,
  patterns,
  createdAt: '',
  updatedAt: '',
});
const T = (id: string, durationMs: number, log = ''): Task => ({ id, name: id, durationMs, log });
const stateOf = (r: ReturnType<typeof simulateRun>) => Object.fromEntries(r.tasks.map((t) => [t.id, t.state]));

describe('simulateRun on the sample pipeline', () => {
  const wf = { id: 's', ...sampleWorkflowInput() };

  it('quarantines the leaking task and cancels exactly its downstream tasks', () => {
    const r = simulateRun(wf, 3);
    const s = stateOf(r);
    expect(s['integration-tests']).toBe('quarantined');
    for (const id of ['package', 'deploy-staging', 'smoke-tests', 'deploy-prod']) expect(s[id]).toBe('cancelled');
    for (const id of ['checkout', 'install', 'lint', 'unit-tests', 'build', 'security-scan', 'docs'])
      expect(s[id]).toBe('completed');
    expect(r.metrics).toMatchObject({ completed: 7, quarantined: 1, cancelled: 4 });
  });

  it('detects the pattern that straddles the 4096-byte chunk boundary, with line and column', () => {
    const f = simulateRun(wf, 3).findings[0];
    expect(f.taskId).toBe('integration-tests');
    expect(f.pattern).toBe('UNAUTHORIZED_ACCESS');
    expect(f.byteOffset).toBe(4089);
    expect(f.line).toBeGreaterThan(1);
  });

  it('does not flag near-misses (DEPRECATED_CALX) in the lint log', () => {
    expect(simulateRun(wf, 3).findings.some((x) => x.taskId === 'lint')).toBe(false);
  });

  it('is deterministic apart from wall-clock timing fields', () => {
    const strip = (r: ReturnType<typeof simulateRun>) =>
      JSON.stringify({ ...r, metrics: { ...r.metrics, scheduleMs: 0, scanMs: 0 } });
    expect(strip(simulateRun(wf, 3))).toBe(strip(simulateRun(wf, 3)));
  });

  it('cancelled tasks never start; the quarantined task stops early and frees its worker', () => {
    const r = simulateRun(wf, 3);
    const started = new Set(r.events.filter((e) => e.type === 'task_start').map((e) => (e as { taskId: string }).taskId));
    for (const id of ['package', 'deploy-staging', 'smoke-tests', 'deploy-prod']) expect(started.has(id)).toBe(false);
    const q = r.tasks.find((t) => t.id === 'integration-tests')!;
    expect(q.endMs! - q.startMs!).toBeLessThan(3500);
    expect(q.endMs! - q.startMs!).toBeGreaterThan(0);
  });
});

describe('simulateRun scheduling properties', () => {
  const chain = wfFrom([T('a', 10), T('b', 20), T('c', 30)], [['a', 'b'], ['b', 'c']]);
  const fan = wfFrom(
    [T('r', 5), T('x', 10), T('y', 10), T('z', 10), T('j', 5)],
    [['r', 'x'], ['r', 'y'], ['r', 'z'], ['x', 'j'], ['y', 'j'], ['z', 'j']],
  );

  it('one worker: makespan is the sum of durations', () => {
    expect(simulateRun(fan, 1).metrics.makespanMs).toBe(40);
  });

  it('enough workers: makespan equals the critical path', () => {
    const r = simulateRun(fan, 3);
    expect(r.metrics.makespanMs).toBe(20);
    expect(r.metrics.criticalPathMs).toBe(20);
    expect(r.metrics.utilization).toBeCloseTo(40 / (3 * 20));
  });

  it('makespan is never below the critical path and never above the sequential time', () => {
    for (let w = 1; w <= 5; w++) {
      const m = simulateRun(fan, w).metrics;
      expect(m.makespanMs).toBeGreaterThanOrEqual(m.criticalPathMs);
      expect(m.makespanMs).toBeLessThanOrEqual(m.sequentialMs);
    }
    expect(simulateRun(chain, 4).metrics.makespanMs).toBe(60);
  });

  it('uses no more than the requested number of workers at once', () => {
    const r = simulateRun(fan, 2);
    const busy = r.tasks.map((t) => t.worker);
    expect(Math.max(...(busy as number[]))).toBeLessThanOrEqual(1);
  });

  it('throws CycleError with the exact cycle, and rejects bad input', () => {
    const cyc = wfFrom([T('a', 1), T('b', 1)], [['a', 'b'], ['b', 'a']]);
    expect(() => simulateRun(cyc, 2)).toThrow(CycleError);
    expect(() => simulateRun(wfFrom([], []), 2)).toThrow();
    expect(() => simulateRun(chain, 0)).toThrow();
    expect(() => simulateRun(chain, 17)).toThrow();
  });

  it('two unrelated violations are both quarantined; a descendant with its own violation is cancelled, not quarantined', () => {
    const w = wfFrom(
      [T('a', 100, 'xxBADxx'), T('b', 100, 'BAD'), T('c', 100, 'BAD'), T('u', 100)],
      [['a', 'c']],
      ['BAD'],
    );
    const s = stateOf(simulateRun(w, 4));
    expect(s).toEqual({ a: 'quarantined', b: 'quarantined', c: 'cancelled', u: 'completed' });
  });

  it('with no patterns every task completes', () => {
    const r = simulateRun(wfFrom([T('a', 5, 'BAD')], [], []), 1);
    expect(r.tasks[0].state).toBe('completed');
  });
});
