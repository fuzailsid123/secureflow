'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/Badge';
import { api, errorText } from '@/lib/client';
import type { Workflow, WorkflowSummary } from '@/lib/types';

type DagShape = 'layered' | 'diamond' | 'chain' | 'random-dag' | 'multi-cycle';

const SAMPLE_YAML = `name: Sample GitHub Actions CI
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
  build:
    needs: lint
    steps:
      - run: npm run build
  deploy:
    needs: [lint, build]
    steps:
      - run: echo "deploying"
`;

export default function Home() {
  const router = useRouter();
  const [items, setItems] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [panel, setPanel] = useState<'none' | 'import' | 'generate'>('none');
  const [importText, setImportText] = useState(SAMPLE_YAML);
  const [genShape, setGenShape] = useState<DagShape>('layered');
  const [genCount, setGenCount] = useState(24);
  const [genLeak, setGenLeak] = useState(true);

  const load = useCallback(async () => {
    try {
      setItems(await api<WorkflowSummary[]>('/api/workflows'));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(payload: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const w = await api<Workflow>('/api/workflows', { method: 'POST', json: payload });
      router.push(`/workflows/${w.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  async function remove(w: WorkflowSummary) {
    if (!confirm(`Delete "${w.name}" and its run history?`)) return;
    try {
      await api(`/api/workflows/${w.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="page narrow">
      <div className="hero">
        <h1>SecureFlow</h1>
        <p>
          Dependency-aware task scheduler and streaming security auditor. Orders DAGs with{' '}
          <b>Kahn&apos;s topological sort</b>, <b>Tarjan&apos;s SCC</b>, and <b>critical-path scheduling</b>, then streams
          task logs through <b>KMP</b>, <b>Aho-Corasick</b>, <b>Thompson NFA regex</b>, and <b>Shannon entropy</b>{' '}
          detectors—quarantining leaks mid-stream and cancelling downstream tasks automatically.
        </p>
        <div className="row">
          <Badge tone="blue">Kahn + Tarjan SCC + Bottom-Level: O(V + E)</Badge>
          <Badge tone="violet">KMP + Aho-Corasick + Thompson NFA</Badge>
          <Badge tone="green">SQLite + Async AbortController Streams</Badge>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" disabled={busy} onClick={() => void create({ sample: true })}>
            Load sample pipeline
          </button>
          <button disabled={busy} onClick={() => void create({})}>
            New blank workflow
          </button>
          <button disabled={busy} onClick={() => setPanel((p) => (p === 'import' ? 'none' : 'import'))}>
            Import JSON / GitHub Actions YAML
          </button>
          <button disabled={busy} onClick={() => setPanel((p) => (p === 'generate' ? 'none' : 'generate'))}>
            Generate Stress DAG
          </button>
        </div>
      </div>

      {error && <div className="alert err">{error}</div>}

      {panel === 'import' && (
        <div className="card">
          <header>
            <h2>Import Workflow (SecureFlow JSON or GitHub Actions YAML)</h2>
            <button className="ghost icon" onClick={() => setPanel('none')}>✕</button>
          </header>
          <textarea rows={10} value={importText} onChange={(e) => setImportText(e.target.value)} spellCheck={false} />
          <div className="row" style={{ marginTop: 10 }}>
            <input
              type="file"
              accept=".json,.yml,.yaml"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void file.text().then((txt) => setImportText(txt));
              }}
            />
            <span className="spacer" />
            <button className="primary" disabled={busy || !importText.trim()} onClick={() => void create({ importText })}>
              Import &amp; Open
            </button>
          </div>
        </div>
      )}

      {panel === 'generate' && (
        <div className="card">
          <header>
            <h2>Generate Synthetic Stress DAG</h2>
            <button className="ghost icon" onClick={() => setPanel('none')}>✕</button>
          </header>
          <div className="row">
            <label className="field">
              Graph shape
              <select value={genShape} onChange={(e) => setGenShape(e.target.value as DagShape)}>
                <option value="layered">Layered DAG</option>
                <option value="diamond">Diamond Fan-Out/Join</option>
                <option value="chain">Deep Chain</option>
                <option value="random-dag">Random DAG</option>
                <option value="multi-cycle">Multi-Cycle Graph (for Tarjan SCC)</option>
              </select>
            </label>
            <label className="field">
              Tasks (2–5,000)
              <input
                type="number"
                min={2}
                max={5000}
                value={genCount}
                onChange={(e) => setGenCount(Math.min(5000, Math.max(2, Number(e.target.value) || 2)))}
                style={{ width: 110 }}
              />
            </label>
            <label className="row small muted" style={{ gap: 6, marginTop: 18 }}>
              <input type="checkbox" checked={genLeak} onChange={(e) => setGenLeak(e.target.checked)} />
              Inject boundary-straddling leak
            </label>
            <span className="spacer" />
            <button
              className="primary"
              disabled={busy}
              style={{ marginTop: 14 }}
              onClick={() => void create({ generate: { shape: genShape, taskCount: genCount, injectLeak: genLeak } })}
            >
              Generate &amp; Open
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <header>
          <h2>Your workflows</h2>
        </header>
        {items === null ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="empty">No workflows yet. Load the sample pipeline, import YAML/JSON, or generate a stress DAG.</div>
        ) : (
          <div className="grid-cards">
            {items.map((w) => (
              <div key={w.id} className="stat" style={{ display: 'grid', gap: 8 }}>
                <Link href={`/workflows/${w.id}`} style={{ fontSize: 16, fontWeight: 650 }}>
                  {w.name}
                </Link>
                <div className="row">
                  <Badge tone="blue">{w.taskCount} tasks</Badge>
                  <Badge tone="gray">{w.edgeCount} deps</Badge>
                  <Badge tone="violet">{w.patternCount} patterns</Badge>
                </div>
                <div className="row">
                  <span className="muted small">Updated {new Date(w.updatedAt).toLocaleString()}</span>
                  <span className="spacer" />
                  <button className="danger ghost icon" onClick={() => remove(w)} aria-label={`Delete ${w.name}`}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
