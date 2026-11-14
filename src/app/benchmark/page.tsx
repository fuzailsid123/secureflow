'use client';
import { useState } from 'react';
import { Badge } from '@/components/Badge';
import LineChart from '@/components/LineChart';
import { api, errorText } from '@/lib/client';
import { fmtBytes, fmtFast, fmtNum } from '@/lib/format';
import type { BenchmarkResult, SearchRow } from '@/lib/benchmark';

function SearchTable({ rows }: { rows: SearchRow[] }) {
  return (
    <div className="table-wrap" style={{ marginTop: 12 }}>
      <table>
        <thead>
          <tr><th>Text size n</th><th>KMP comparisons</th><th>Naive comparisons</th><th>Naive / KMP</th><th>KMP time</th><th>Naive time</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.n}>
              <td>{fmtNum(r.n)}</td>
              <td>{fmtNum(r.kmpComparisons)}</td>
              <td>{fmtNum(r.naiveComparisons)}</td>
              <td>{(r.naiveComparisons / r.kmpComparisons).toFixed(1)}&times;</td>
              <td>{fmtFast(r.kmpMs)}</td>
              <td>{fmtFast(r.naiveMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BenchmarkPage() {
  const [res, setRes] = useState<BenchmarkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setBusy(true);
    setError('');
    try {
      setRes(await api<BenchmarkResult>('/api/benchmark', { method: 'POST' }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const cmp = (rows: SearchRow[]) => [
    { name: 'KMP', color: '#3ddc97', points: rows.map((r) => ({ x: r.n, y: r.kmpComparisons })) },
    { name: 'Naive', color: '#ff6b6b', points: rows.map((r) => ({ x: r.n, y: r.naiveComparisons })) },
  ];

  return (
    <div className="page narrow">
      <h1>Benchmark</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Reproducible measurements (seeded random inputs) run on the server. Comparison counts are exact and machine
        independent; times vary by machine.
      </p>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="primary" onClick={run} disabled={busy}>
          {busy ? 'Running…' : res ? 'Run again' : 'Run benchmark'}
        </button>
        {res && <Badge tone="gray">pattern length m = {res.patternLength}</Badge>}
      </div>
      {error && <div className="alert err">{error}</div>}

      {res && (
        <>
          <div className="card">
            <header>
              <h2>Multi-pattern: Aho-Corasick O(N + Z) vs KMP O(k·N)</h2>
              <Badge tone="violet">k = 1..20 patterns</Badge>
            </header>
            <p className="muted small" style={{ marginTop: 0 }}>
              Fixed {fmtBytes(res.multiPattern[0]?.n ?? 120000)} text scanned for k = 1, 5, 10, 20 patterns. Running
              independent KMP scanners scales linearly with k, while Aho-Corasick scans every byte once.
            </p>
            <LineChart
              series={[
                {
                  name: 'Aho-Corasick comparisons',
                  color: '#a78bfa',
                  points: res.multiPattern.map((r) => ({ x: r.k, y: r.acComparisons })),
                },
                {
                  name: 'k × KMP comparisons',
                  color: '#3ddc97',
                  points: res.multiPattern.map((r) => ({ x: r.k, y: r.kmpComparisons })),
                },
              ]}
              xLabel="number of patterns k"
              yLabel="byte comparisons"
            />
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr><th>Patterns k</th><th>Aho-Corasick comps</th><th>k × KMP comps</th><th>Aho-Corasick time</th><th>k × KMP time</th><th>k × Naive time</th></tr>
                </thead>
                <tbody>
                  {res.multiPattern.map((r) => (
                    <tr key={r.k}>
                      <td>{r.k}</td>
                      <td>{fmtNum(r.acComparisons)}</td>
                      <td>{fmtNum(r.kmpComparisons)}</td>
                      <td>{fmtFast(r.acMs)}</td>
                      <td>{fmtFast(r.kmpMs)}</td>
                      <td>{fmtFast(r.naiveMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <header>
              <h2>KMP vs naive on adversarial input</h2>
              <Badge tone="red">worst case for naive</Badge>
            </header>
            <p className="muted small" style={{ marginTop: 0 }}>
              Text is all &quot;Z&quot;, pattern is 63 &quot;Z&quot;s followed by &quot;A&quot;. Naive search re-compares almost the whole pattern at every
              position (about n&times;m comparisons); KMP never rewinds the text, so it stays under 2n.
            </p>
            <LineChart series={cmp(res.adversarial)} xLabel="text length n (bytes)" yLabel="character comparisons" />
            <SearchTable rows={res.adversarial} />
          </div>

          <div className="card">
            <header>
              <h2>KMP vs naive on random text</h2>
              <Badge tone="amber">typical case</Badge>
            </header>
            <p className="muted small" style={{ marginTop: 0 }}>
              On random 4-letter text mismatches happen almost immediately, so naive search is also close to linear and
              often as fast in wall-clock time. KMP&apos;s value is the worst-case guarantee.
            </p>
            <LineChart series={cmp(res.random)} xLabel="text length n (bytes)" yLabel="character comparisons" />
            <SearchTable rows={res.random} />
          </div>

          <div className="card">
            <header>
              <h2>Topological sort scaling</h2>
              <Badge tone="blue">O(V + E)</Badge>
            </header>
            <p className="muted small" style={{ marginTop: 0 }}>
              Random DAGs with about 4 dependencies per task (median of 5 runs, graph build included). The spec budget is
              under 1 second at 5,000 tasks and 20,000 dependencies.
            </p>
            <LineChart
              series={[{ name: 'schedule time (ms)', color: '#5eb0ff', points: res.scheduling.map((s) => ({ x: s.v, y: s.ms })) }]}
              xLabel="tasks V"
              yLabel="milliseconds"
            />
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead><tr><th>Tasks V</th><th>Dependencies E</th><th>Time</th></tr></thead>
                <tbody>
                  {res.scheduling.map((s) => (
                    <tr key={s.v}><td>{fmtNum(s.v)}</td><td>{fmtNum(s.e)}</td><td>{fmtFast(s.ms)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
