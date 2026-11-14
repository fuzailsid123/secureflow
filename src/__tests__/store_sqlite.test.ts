import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'secureflow-sqlite-'));
  process.env.DATA_DIR = dir;
});
afterAll(() => {
  delete process.env.SECUREFLOW_API_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe('SQLite store migration, streaming file audit, and optional API key guard', () => {
  it('migrates legacy store.json automatically into secureflow.db', async () => {
    const legacy = {
      workflows: {
        'wf-legacy': {
          id: 'wf-legacy',
          name: 'Legacy Pipeline',
          tasks: [{ id: 'a', name: 'Task A', durationMs: 100, log: 'ok' }],
          edges: [],
          patterns: ['BAD'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      runs: {},
    };
    writeFileSync(path.join(dir, 'store.json'), JSON.stringify(legacy), 'utf8');
    (globalThis as { __secureflowStore?: unknown }).__secureflowStore = undefined;

    const store = await import('@/lib/store');
    const wf = await store.getWorkflow('wf-legacy');
    expect(wf).not.toBeNull();
    expect(wf?.name).toBe('Legacy Pipeline');
  });

  it('audits raw streams and multipart file uploads via /api/audit/stream across chunk boundaries', async () => {
    const streamAudit = await import('@/app/api/audit/stream/route');
    const payload = 'ok\n' + 'x'.repeat(4090) + 'UNAUTHORIZED_ACCESS' + '\nSECRET_TOKEN_XYZ_98765432109876543210\n';

    const rawReq = new Request(
      `http://localhost/api/audit/stream?pattern=UNAUTHORIZED_ACCESS&regex=${encodeURIComponent('SECRET_TOKEN_[A-Z0-9_]+')}&scanner=aho-corasick`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: payload,
        // @ts-expect-error duplex required by Node Request with string/stream body
        duplex: 'half',
      },
    );
    const res = await streamAudit.POST(rawReq);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalMatches).toBe(2);
    expect(data.scanner).toBe('aho-corasick');

    const form = new FormData();
    form.append('file', new File([payload], 'app.log', { type: 'text/plain' }));
    form.append('patterns', 'UNAUTHORIZED_ACCESS');
    form.append('scanner', 'kmp');
    const formReq = new Request('http://localhost/api/audit/stream', { method: 'POST', body: form });
    const formRes = await streamAudit.POST(formReq);
    expect(formRes.status).toBe(200);
    const formData = await formRes.json();
    expect(formData.totalMatches).toBe(1);
    expect(formData.matches[0].line).toBe(2);
  });

  it('enforces SECUREFLOW_API_KEY on mutating endpoints only when configured', async () => {
    process.env.SECUREFLOW_API_KEY = 'top-secret-key';
    const wfRoute = await import('@/app/api/workflows/route');

    const denied = await wfRoute.POST(
      new Request('http://localhost/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(denied.status).toBe(401);

    const allowed = await wfRoute.POST(
      new Request('http://localhost/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer top-secret-key' },
        body: JSON.stringify({}),
      }),
    );
    expect(allowed.status).toBe(201);
    delete process.env.SECUREFLOW_API_KEY;
  });
});
