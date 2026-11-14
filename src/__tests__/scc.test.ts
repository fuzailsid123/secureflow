import { describe, expect, it } from 'vitest';
import { analyzeCycles, bottomLevels, tarjanSCC } from '@/lib/scc';
import { simulateRun } from '@/lib/simulate';
import { buildGraph, topoSort } from '@/lib/topo';
import type { Task } from '@/lib/types';

describe('Tarjan SCC and feedback-arc suggestions', () => {
  it('detects multiple disjoint cyclic SCCs and suggests breaks that make the graph acyclic', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges: [string, string][] = [
      ['a', 'b'],
      ['b', 'a'], // cycle 1
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['e', 'c'], // cycle 2
      ['f', 'f'], // self-loop cycle 3
    ];
    const g = buildGraph(ids, edges);
    const sccs = tarjanSCC(g);
    expect(sccs.length).toBeGreaterThanOrEqual(3);

    const analysis = analyzeCycles(g);
    expect(analysis.cyclicSccs.length).toBe(3);
    expect(analysis.suggestedBreaks.length).toBeGreaterThanOrEqual(3);

    const breakSet = new Set(analysis.suggestedBreaks.map((s) => `${s.from}>${s.to}`));
    const remaining = edges.filter(([u, v]) => !breakSet.has(`${u}>${v}`));
    const cleaned = topoSort(buildGraph(ids, remaining));
    expect(cleaned.ok).toBe(true);
  });

  it('handles a 5,000-node deep chain without stack overflow', () => {
    const n = 5000;
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const edges: [string, string][] = Array.from({ length: n - 1 }, (_, i) => [ids[i], ids[i + 1]]);
    const g = buildGraph(ids, edges);
    const analysis = analyzeCycles(g);
    expect(analysis.cyclicSccs).toEqual([]);
    expect(analysis.suggestedBreaks).toEqual([]);
  });
});

describe('Critical-Path-First list scheduling vs Topo FIFO', () => {
  it('reduces makespan on an asymmetric bottleneck DAG', () => {
    // Level 0 has: short leaf s1 (10ms), s2 (10ms), and bottleneck root b0 (10ms) -> b1 (100ms).
    // With 2 workers:
    //  - topo-fifo starts s1 and s2 first (t=0..10), then b0 (t=10..20), then b1 (t=20..120) => makespan 120ms.
    //  - critical-path sees bottomLevel(b0) = 110 > bottomLevel(s1) = 10, so b0 starts at t=0 => makespan 110ms!
    const tasks: Task[] = [
      { id: 's1', name: 's1', durationMs: 10, log: '' },
      { id: 's2', name: 's2', durationMs: 10, log: '' },
      { id: 'b0', name: 'b0', durationMs: 10, log: '' },
      { id: 'b1', name: 'b1', durationMs: 100, log: '' },
    ];
    const edges: [string, string][] = [['b0', 'b1']];
    const wf = { id: 'asym', name: 'asym', tasks, edges, patterns: [] };

    const fifo = simulateRun(wf, 2, { policy: 'topo-fifo' });
    const cp = simulateRun(wf, 2, { policy: 'critical-path' });

    expect(fifo.metrics.makespanMs).toBe(120);
    expect(cp.metrics.makespanMs).toBe(110);

    const g = buildGraph(tasks.map((t) => t.id), edges);
    const sorted = topoSort(g);
    if (!sorted.ok) throw new Error('expected acyclic');
    const bl = bottomLevels(g, sorted.levels.flat(), tasks.map((t) => t.durationMs));
    expect(bl[2]).toBe(110); // b0
  });
});
