import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sampleWorkflowInput } from '@/lib/sample';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'secureflow-runner-'));
  process.env.DATA_DIR = dir;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const req = (url: string, method = 'GET', body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('Live async runner, cancellation, and incremental subgraph resume', () => {
  it('streams live async execution via Aho-Corasick, quarantines mid-stream, and resumes subgraph after allowlisting', async () => {
    const wfRoute = await import('@/app/api/workflows/route');
    const runsRoute = await import('@/app/api/workflows/[id]/runs/route');
    const runRoute = await import('@/app/api/runs/[id]/route');
    const streamRoute = await import('@/app/api/runs/[id]/stream/route');
    const resumeRoute = await import('@/app/api/workflows/[id]/runs/[runId]/resume/route');

    const w = await (await wfRoute.POST(req('/api/workflows', 'POST', { sample: true }))).json();
    const created = await runsRoute.POST(
      req(`/api/workflows/${w.id}/runs`, 'POST', {
        workers: 3,
        mode: 'live',
        policy: 'critical-path',
        scanner: 'aho-corasick',
        speed: 500,
      }),
      ctx(w.id),
    );
    expect(created.status).toBe(201);
    const liveSummary = await created.json();
    expect(liveSummary.status).toBe('running');
    expect(liveSummary.mode).toBe('live');

    // Consume live SSE until end event
    const sse = await streamRoute.GET(req(`/api/runs/${liveSummary.id}/stream`), ctx(liveSummary.id));
    const sseText = await sse.text();
    expect(sseText).toContain('event: end');
    expect(sseText).toContain('task_quarantined');
    expect(sseText).toContain('run_complete');

    const finished = await (await runRoute.GET(req('/x'), ctx(liveSummary.id))).json();
    expect(finished.status).toBe('completed');
    expect(finished.metrics).toMatchObject({ completed: 7, quarantined: 1, cancelled: 4 });
    expect(finished.findings[0].context).toBeDefined();

    // Resume subgraph allowlisting UNAUTHORIZED_ACCESS: the 7 already-completed tasks are reused without running!
    const resumedRes = await resumeRoute.POST(
      req(`/api/workflows/${w.id}/runs/${liveSummary.id}/resume`, 'POST', {
        mode: 'simulate',
        allowlistPatterns: ['UNAUTHORIZED_ACCESS'],
      }),
      { params: Promise.resolve({ id: w.id, runId: liveSummary.id }) },
    );
    expect(resumedRes.status).toBe(201);
    const resumed = await resumedRes.json();
    expect(resumed.resumedFromRunId).toBe(liveSummary.id);
    expect(resumed.metrics).toMatchObject({ completed: 12, quarantined: 0, cancelled: 0 });

    const fullResumed = await (await runRoute.GET(req('/x'), ctx(resumed.id))).json();
    const startedIds = fullResumed.events
      .filter((e: { type: string }) => e.type === 'task_start')
      .map((e: { taskId: string }) => e.taskId);
    expect(startedIds.sort()).toEqual([
      'deploy-prod',
      'deploy-staging',
      'integration-tests',
      'package',
      'smoke-tests',
    ]);
  });

  it('aborts an active live run via POST /api/runs/[id]/cancel', async () => {
    const wfRoute = await import('@/app/api/workflows/route');
    const runsRoute = await import('@/app/api/workflows/[id]/runs/route');
    const cancelRoute = await import('@/app/api/runs/[id]/cancel/route');
    const runRoute = await import('@/app/api/runs/[id]/route');

    const base = sampleWorkflowInput();
    base.tasks[0].durationMs = 5000;
    const w = await (await wfRoute.POST(req('/api/workflows', 'POST', base))).json();
    const created = await runsRoute.POST(
      req(`/api/workflows/${w.id}/runs`, 'POST', { workers: 1, mode: 'live', speed: 1 }),
      ctx(w.id),
    );
    const summary = await created.json();

    const cancelRes = await cancelRoute.POST(req(`/api/runs/${summary.id}/cancel`, 'POST'), ctx(summary.id));
    expect(cancelRes.status).toBe(200);

    const after = await (await runRoute.GET(req('/x'), ctx(summary.id))).json();
    expect(after.status).toBe('cancelled');
    expect(after.events.some((e: { type: string }) => e.type === 'run_cancelled')).toBe(true);
  });
});
