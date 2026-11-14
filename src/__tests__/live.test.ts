import { describe, expect, it } from 'vitest';
import { replay } from '@/lib/live';
import { simulateRun } from '@/lib/simulate';
import { sampleWorkflowInput } from '@/lib/sample';

describe('live reducer', () => {
  it('replaying a run reproduces the server-side final task states and findings', () => {
    const run = simulateRun({ id: 's', ...sampleWorkflowInput() }, 3);
    const live = replay(run.events);
    for (const t of run.tasks) expect(live.states[t.id]).toBe(t.state);
    expect(live.findings).toEqual(run.findings);
    expect(live.done).toBe(true);
    expect(live.now).toBe(run.metrics.makespanMs);
  });

  it('segments match the server-reported start/end times, and none are left open', () => {
    const run = simulateRun({ id: 's', ...sampleWorkflowInput() }, 2);
    const live = replay(run.events);
    expect(live.segments.every((s) => s.end !== null)).toBe(true);
    for (const seg of live.segments) {
      const t = run.tasks.find((x) => x.id === seg.taskId)!;
      expect([seg.start, seg.end, seg.worker]).toEqual([t.startMs, t.endMs, t.worker]);
    }
    expect(live.segments.length).toBe(run.metrics.completed + run.metrics.quarantined);
  });
});
