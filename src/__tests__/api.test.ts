import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'secureflow-test-'));
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

async function routes() {
  return {
    wf: await import('@/app/api/workflows/route'),
    wfId: await import('@/app/api/workflows/[id]/route'),
    runs: await import('@/app/api/workflows/[id]/runs/route'),
    run: await import('@/app/api/runs/[id]/route'),
    stream: await import('@/app/api/runs/[id]/stream/route'),
    schedule: await import('@/app/api/schedule/route'),
    audit: await import('@/app/api/audit/route'),
    bench: await import('@/app/api/benchmark/route'),
  };
}

describe('workflow CRUD', () => {
  it('creates the sample, lists, reads, updates, validates and deletes', async () => {
    const r = await routes();
    const created = await r.wf.POST(req('/api/workflows', 'POST', { sample: true }));
    expect(created.status).toBe(201);
    const w = await created.json();
    expect(w.tasks.length).toBe(12);

    const list = await (await r.wf.GET()).json();
    expect(list.some((x: { id: string }) => x.id === w.id)).toBe(true);

    const got = await r.wfId.GET(req(`/api/workflows/${w.id}`), ctx(w.id));
    expect(got.status).toBe(200);

    const bad = await r.wfId.PUT(req(`/api/workflows/${w.id}`, 'PUT', { ...w, edges: [['a', 'zzz']] }), ctx(w.id));
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors.length).toBeGreaterThan(0);

    const upd = await r.wfId.PUT(req(`/api/workflows/${w.id}`, 'PUT', { ...w, name: 'Renamed' }), ctx(w.id));
    expect((await upd.json()).name).toBe('Renamed');

    expect((await r.wfId.GET(req('/api/workflows/nope'), ctx('nope'))).status).toBe(404);
    expect((await r.wf.POST(req('/api/workflows', 'POST', { name: '' }))).status).toBe(400);

    expect((await r.wfId.DELETE(req('/x', 'DELETE'), ctx(w.id))).status).toBe(200);
    expect((await r.wfId.GET(req('/x'), ctx(w.id))).status).toBe(404);
  });

  it('creates a blank workflow with defaults', async () => {
    const r = await routes();
    const res = await r.wf.POST(req('/api/workflows', 'POST', {}));
    expect(res.status).toBe(201);
    expect((await res.json()).name).toBe('Untitled workflow');
  });
});

describe('POST /api/schedule', () => {
  it('returns levels and critical path for a DAG', async () => {
    const r = await routes();
    const res = await r.schedule.POST(
      req('/api/schedule', 'POST', {
        tasks: [{ id: 'a', durationMs: 5 }, { id: 'b', durationMs: 10 }, { id: 'c', durationMs: 1 }],
        edges: [['a', 'b'], ['a', 'c']],
      }),
    );
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, levels: [['a'], ['b', 'c']] });
    expect(body.criticalPath).toEqual({ path: ['a', 'b'], lengthMs: 15 });
  });

  it('returns the exact cycle, and 400s on unknown tasks / bad shape', async () => {
    const r = await routes();
    const cyc = await (
      await r.schedule.POST(req('/api/schedule', 'POST', { tasks: [{ id: 'a' }, { id: 'b' }], edges: [['a', 'b'], ['b', 'a']] }))
    ).json();
    expect(cyc.ok).toBe(false);
    expect(cyc.cycle[0]).toBe(cyc.cycle.at(-1));
    expect((await r.schedule.POST(req('/api/schedule', 'POST', { tasks: [{ id: 'a' }], edges: [['a', 'q']] }))).status).toBe(400);
    expect((await r.schedule.POST(req('/api/schedule', 'POST', { nope: 1 }))).status).toBe(400);
  });
});

describe('runs, SSE stream and persistence', () => {
  it('runs the sample, streams every event over SSE, survives a store reload, and cascades on delete', async () => {
    const r = await routes();
    const w = await (await r.wf.POST(req('/api/workflows', 'POST', { sample: true }))).json();

    const created = await r.runs.POST(req(`/api/workflows/${w.id}/runs`, 'POST', { workers: 3 }), ctx(w.id));
    expect(created.status).toBe(201);
    const summary = await created.json();
    expect(summary.metrics).toMatchObject({ quarantined: 1, cancelled: 4, completed: 7 });
    expect(summary.events).toBeUndefined();
    expect(summary.findings[0]).toMatchObject({ taskId: 'integration-tests', pattern: 'UNAUTHORIZED_ACCESS', byteOffset: 4089 });

    const full = await (await r.run.GET(req('/x'), ctx(summary.id))).json();
    expect(full.events.length).toBe(summary.eventCount);

    const sse = await r.stream.GET(req(`/api/runs/${summary.id}/stream?speed=instant`), ctx(summary.id));
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const text = await sse.text();
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: {}');
    expect(dataLines.length).toBe(summary.eventCount);
    expect(text).toContain('event: end');
    expect(JSON.parse(dataLines.at(-1)!.slice(6)).type).toBe('run_complete');

    // paced replay actually takes real time (virtual 100ms gap at speed 1 => at least ~90ms)
    const tiny = await (
      await r.wf.POST(req('/api/workflows', 'POST', { name: 't', tasks: [{ id: 'a', durationMs: 120 }], edges: [], patterns: [] }))
    ).json();
    const tinyRun = await (await r.runs.POST(req('/x', 'POST', { workers: 1 }), ctx(tiny.id))).json();
    const t0 = Date.now();
    await (await r.stream.GET(req(`/api/runs/${tinyRun.id}/stream?speed=1`), ctx(tinyRun.id))).text();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);

    // simulate a server restart: drop the in-memory cache, reload from disk
    (globalThis as { __secureflowStore?: unknown }).__secureflowStore = undefined;
    const reloaded = await r.run.GET(req('/x'), ctx(summary.id));
    expect(reloaded.status).toBe(200);
    expect((await reloaded.json()).id).toBe(summary.id);

    const history = await (await r.runs.GET(req('/x'), ctx(w.id))).json();
    expect(history.length).toBe(1);

    await r.wfId.DELETE(req('/x', 'DELETE'), ctx(w.id));
    expect((await r.run.GET(req('/x'), ctx(summary.id))).status).toBe(404);
    expect((await r.stream.GET(req('/x'), ctx(summary.id))).status).toBe(404);
  });

  it('409s with the exact cycle on circular dependencies; 400s on bad workers / empty workflows', async () => {
    const r = await routes();
    const w = await (
      await r.wf.POST(
        req('/api/workflows', 'POST', {
          name: 'cyc',
          tasks: [{ id: 'a', durationMs: 1 }, { id: 'b', durationMs: 1 }, { id: 'c', durationMs: 1 }],
          edges: [['a', 'b'], ['b', 'c'], ['c', 'b']],
          patterns: [],
        }),
      )
    ).json();
    const res = await r.runs.POST(req('/x', 'POST', { workers: 2 }), ctx(w.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('CIRCULAR_DEPENDENCY');
    expect(body.cycle).toEqual(expect.arrayContaining(['b', 'c']));
    expect(body.cycle).not.toContain('a');

    expect((await r.runs.POST(req('/x', 'POST', { workers: 99 }), ctx(w.id))).status).toBe(400);
    const empty = await (await r.wf.POST(req('/api/workflows', 'POST', {}))).json();
    expect((await r.runs.POST(req('/x', 'POST', {}), ctx(empty.id))).status).toBe(400);
    expect((await r.runs.POST(req('/x', 'POST', {}), ctx('missing'))).status).toBe(404);
  });

  it('keeps only the newest runs per workflow', async () => {
    const r = await routes();
    const { LIMITS } = await import('@/lib/limits');
    const w = await (
      await r.wf.POST(req('/api/workflows', 'POST', { name: 'many', tasks: [{ id: 'a', durationMs: 1 }], edges: [], patterns: [] }))
    ).json();
    for (let i = 0; i < LIMITS.maxRunsPerWorkflow + 3; i++) await r.runs.POST(req('/x', 'POST', {}), ctx(w.id));
    expect((await (await r.runs.GET(req('/x'), ctx(w.id))).json()).length).toBe(LIMITS.maxRunsPerWorkflow);
  });
});

describe('POST /api/audit', () => {
  it('reports overlapping matches with line/column/context and comparison counts', async () => {
    const r = await routes();
    const res = await r.audit.POST(
      req('/api/audit', 'POST', { text: 'ok\nfoo AAAA bar\nBAD here', patterns: ['AA', 'BAD'], compare: true }),
    );
    const b = await res.json();
    expect(b.totalMatches).toBe(4); // AA x3 (overlapping) + BAD
    const bad = b.matches.find((m: { pattern: string }) => m.pattern === 'BAD');
    expect(bad).toMatchObject({ line: 3, column: 1, match: 'BAD', after: ' here' });
    const aa = b.matches.filter((m: { pattern: string }) => m.pattern === 'AA');
    expect(aa.map((m: { column: number }) => m.column)).toEqual([5, 6, 7]);
    expect(b.perPattern[0].naiveComparisons).toBeGreaterThan(0);
  });

  it('finds a match across the 4096-byte internal chunk boundary', async () => {
    const r = await routes();
    const text = 'x'.repeat(4090) + 'UNAUTHORIZED' + 'y'.repeat(50);
    const b = await (await r.audit.POST(req('/api/audit', 'POST', { text, patterns: ['UNAUTHORIZED'] }))).json();
    expect(b.matches[0]).toMatchObject({ byteOffset: 4090, line: 1, column: 4091 });
  });

  it('rejects bad input', async () => {
    const r = await routes();
    expect((await r.audit.POST(req('/a', 'POST', { text: 'x', patterns: [] }))).status).toBe(400);
    expect((await r.audit.POST(req('/a', 'POST', { text: 'x', patterns: [''] }))).status).toBe(400);
    expect((await r.audit.POST(req('/a', 'POST', { text: 5, patterns: ['a'] }))).status).toBe(400);
  });
});

describe('POST /api/benchmark', () => {
  it('shows linear KMP vs quadratic-ish naive on adversarial input and a fast scheduler', async () => {
    const r = await routes();
    const b = await (await r.bench.POST()).json();
    for (const row of b.adversarial) {
      expect(row.kmpComparisons).toBeLessThanOrEqual(2 * row.n);
      expect(row.naiveComparisons).toBeGreaterThan(30 * row.n);
    }
    expect(b.scheduling.at(-1)).toMatchObject({ v: 5000 });
    expect(b.scheduling.every((s: { ms: number }) => s.ms < 1000)).toBe(true);
  }, 60000);
});
