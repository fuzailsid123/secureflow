'use client';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, api, downloadJson, errorText } from '@/lib/client';
import { fmtBytes, fmtFast, fmtMs, fmtNum } from '@/lib/format';
import { ID_PATTERN, LIMITS } from '@/lib/limits';
import { applyEventMut, emptyLive, replay, type LiveState } from '@/lib/live';
import { toSarifReport } from '@/lib/sarif';
import type {
  Edge,
  Run,
  RunMode,
  RunSummary,
  ScannerMode,
  SchedulePolicy,
  ScheduleResponse,
  Task,
  Workflow,
  WorkflowInput,
} from '@/lib/types';
import { Badge, StateBadge } from './Badge';
import Gantt from './Gantt';
import GraphView from './GraphView';

type Notice = { kind: 'ok' | 'err' | 'info'; text: string } | null;

/* ------------------------------------------------------------------ tasks */
function TasksCard({
  tasks,
  patterns,
  openId,
  onToggleOpen,
  onChange,
  onAdd,
  onRemove,
}: {
  tasks: Task[];
  patterns: string[];
  openId: string | null;
  onToggleOpen: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Task>) => void;
  onAdd: (id: string, durationMs: number) => void;
  onRemove: (id: string) => void;
}) {
  const [newId, setNewId] = useState('');
  const [newDur, setNewDur] = useState(1000);

  const idProblem = useMemo(() => {
    if (!newId) return '';
    if (newId.length > LIMITS.maxIdLength) return `max ${LIMITS.maxIdLength} characters`;
    if (!ID_PATTERN.test(newId)) return 'letters, digits, _ - . only';
    if (tasks.some((t) => t.id === newId)) return 'id already exists';
    if (tasks.length >= LIMITS.maxTasks) return `max ${LIMITS.maxTasks} tasks`;
    return '';
  }, [newId, tasks]);

  return (
    <div className="card">
      <header>
        <h2>Tasks</h2>
        <Badge tone="gray">{tasks.length} / {LIMITS.maxTasks}</Badge>
      </header>
      {tasks.length === 0 ? (
        <div className="empty" style={{ marginBottom: 12 }}>No tasks yet. Add your first task below.</div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr><th>Id</th><th>Name</th><th style={{ textAlign: 'right' }}>ms</th><th>Log</th><th /></tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const expanded = openId === t.id;
                return (
                  <Fragment key={t.id}>
                    <tr className={expanded ? 'expanded' : undefined}>
                      <td className="mono">{t.id}</td>
                      <td>
                        <input
                          value={t.name}
                          maxLength={LIMITS.maxNameLength}
                          onChange={(e) => onChange(t.id, { name: e.target.value })}
                          aria-label={`Name of ${t.id}`}
                        />
                      </td>
                      <td>
                        <input
                          className="num"
                          type="number"
                          min={1}
                          max={LIMITS.maxDurationMs}
                          value={t.durationMs}
                          onChange={(e) => onChange(t.id, { durationMs: Math.round(Number(e.target.value)) || 1 })}
                          aria-label={`Duration of ${t.id} in ms`}
                        />
                      </td>
                      <td>
                        <button className="ghost icon" onClick={() => onToggleOpen(expanded ? null : t.id)}>
                          {expanded ? 'Hide' : `${fmtNum(t.log.length)} ch`}
                        </button>
                      </td>
                      <td>
                        <button className="danger ghost icon" onClick={() => onRemove(t.id)} aria-label={`Remove ${t.id}`}>
                          ✕
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="expanded">
                        <td colSpan={5}>
                          <textarea
                            rows={7}
                            value={t.log}
                            spellCheck={false}
                            placeholder="Task log output (scanned when the task runs)"
                            onChange={(e) => onChange(t.id, { log: e.target.value })}
                          />
                          <div className="row small muted" style={{ marginTop: 6 }}>
                            <span>{fmtBytes(new TextEncoder().encode(t.log).length)} of max {fmtBytes(LIMITS.maxTaskLogBytes)}</span>
                            <span className="spacer" />
                            <button
                              className="ghost"
                              disabled={patterns.length === 0}
                              onClick={() =>
                                onChange(t.id, {
                                  log: `${t.log}${t.log && !t.log.endsWith('\n') ? '\n' : ''}ERROR: ${patterns[0]} detected\n`,
                                })
                              }
                            >
                              Inject first pattern
                            </button>
                            <button className="ghost" onClick={() => onChange(t.id, { log: '' })}>Clear</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <input
          placeholder="new task id"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          style={{ width: 150 }}
          aria-label="New task id"
        />
        <input
          type="number"
          min={1}
          value={newDur}
          onChange={(e) => setNewDur(Math.round(Number(e.target.value)) || 1)}
          style={{ width: 100 }}
          aria-label="New task duration in ms"
        />
        <span className="muted small">ms</span>
        <button
          className="primary"
          disabled={!newId || !!idProblem}
          onClick={() => {
            onAdd(newId, Math.min(Math.max(1, newDur), LIMITS.maxDurationMs));
            setNewId('');
          }}
        >
          Add task
        </button>
        {idProblem && <span className="small" style={{ color: 'var(--red)' }}>{idProblem}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ edges */
function EdgesCard({
  tasks,
  edges,
  cycle,
  onAdd,
  onRemove,
}: {
  tasks: Task[];
  edges: Edge[];
  cycle: string[] | null;
  onAdd: (e: Edge) => void;
  onRemove: (i: number) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const cyc = useMemo(() => {
    const s = new Set<string>();
    if (cycle) for (let i = 0; i < cycle.length - 1; i++) s.add(`${cycle[i]}>${cycle[i + 1]}`);
    return s;
  }, [cycle]);
  const dup = edges.some(([a, b]) => a === from && b === to);

  return (
    <div className="card">
      <header>
        <h2>Dependencies</h2>
        <Badge tone="gray">{edges.length} / {LIMITS.maxEdges}</Badge>
      </header>
      <p className="muted small" style={{ marginTop: 0 }}>&quot;A → B&quot; means A must finish before B starts.</p>
      <div className="row">
        <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Prerequisite task">
          <option value="">prerequisite…</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
        </select>
        <span className="muted">→</span>
        <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Dependent task">
          <option value="">dependent…</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
        </select>
        <button disabled={!from || !to || dup || edges.length >= LIMITS.maxEdges} onClick={() => onAdd([from, to])}>Add</button>
      </div>
      {edges.length > 0 && (
        <div className="chips" style={{ marginTop: 12, maxHeight: 180, overflowY: 'auto' }}>
          {edges.map(([a, b], i) => (
            <span key={`${a}>${b}`} className={`chip${cyc.has(`${a}>${b}`) ? ' cycle' : ''}`}>
              {a} → {b}
              <button onClick={() => onRemove(i)} aria-label={`Remove dependency ${a} to ${b}`}>✕</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- patterns */
function PatternsCard({ patterns, onChange }: { patterns: string[]; onChange: (p: string[]) => void }) {
  const [text, setText] = useState('');
  const problem =
    text && patterns.includes(text)
      ? 'already added'
      : text && new TextEncoder().encode(text).length > LIMITS.maxPatternBytes
        ? `max ${LIMITS.maxPatternBytes} bytes`
        : patterns.length >= LIMITS.maxPatterns
          ? `max ${LIMITS.maxPatterns} patterns`
          : '';
  return (
    <div className="card">
      <header>
        <h2>Forbidden patterns</h2>
        <Badge tone="gray">{patterns.length} / {LIMITS.maxPatterns}</Badge>
      </header>
      <p className="muted small" style={{ marginTop: 0 }}>Case-sensitive. Matched on UTF-8 bytes while each task log streams in.</p>
      <div className="row">
        <input
          placeholder="e.g. UNAUTHORIZED_ACCESS"
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1 }}
          aria-label="New pattern"
        />
        <button disabled={!text || !!problem} onClick={() => { onChange([...patterns, text]); setText(''); }}>Add</button>
      </div>
      {problem && <div className="small" style={{ color: 'var(--red)', marginTop: 6 }}>{problem}</div>}
      {patterns.length > 0 && (
        <div className="chips" style={{ marginTop: 12 }}>
          {patterns.map((p) => (
            <span key={p} className="chip">
              {p}
              <button onClick={() => onChange(patterns.filter((x) => x !== p))} aria-label={`Remove pattern ${p}`}>✕</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- main page */
export default function Workspace({ id }: { id: string }) {
  const [draft, setDraft] = useState<WorkflowInput | null>(null);
  const [loadError, setLoadError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [sched, setSched] = useState<ScheduleResponse | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const [workers, setWorkers] = useState(3);
  const [speed, setSpeed] = useState('4');
  const [mode, setMode] = useState<RunMode>('live');
  const [policy, setPolicy] = useState<SchedulePolicy>('topo-fifo');
  const [scanner, setScanner] = useState<ScannerMode>('aho-corasick');
  const [showAdvancedRules, setShowAdvancedRules] = useState(false);
  const [regexInput, setRegexInput] = useState('');
  const [entropyEnabled, setEntropyEnabled] = useState(false);
  const [entropyThreshold, setEntropyThreshold] = useState(4.3);

  const [run, setRun] = useState<RunSummary | null>(null);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [running, setRunning] = useState(false);

  const liveRef = useRef<LiveState>(emptyLive());
  const [, repaint] = useReducer((x: number) => x + 1, 0);
  const rafRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const schedulePaint = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      repaint();
    });
  }, []);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const refreshRunAndHistory = useCallback(
    async (runId: string) => {
      try {
        const [full, hist] = await Promise.all([
          api<Run>(`/api/runs/${runId}`),
          api<RunSummary[]>(`/api/workflows/${id}/runs`),
        ]);
        const { events, ...summary } = full;
        void events;
        setRun(summary);
        setHistory(hist);
      } catch {
        /* ignore refresh race */
      }
    },
    [id],
  );

  const viewRun = useCallback(
    async (s: RunSummary) => {
      closeStream();
      setRunning(false);
      try {
        const full = await api<Run>(`/api/runs/${s.id}`);
        liveRef.current = replay(full.events, full.tasks);
        const { events, ...summary } = full;
        void events;
        setRun(summary);
        repaint();
      } catch (e) {
        setNotice({ kind: 'err', text: errorText(e) });
      }
    },
    [closeStream],
  );

  /* initial load */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [w, h] = await Promise.all([
          api<Workflow>(`/api/workflows/${id}`),
          api<RunSummary[]>(`/api/workflows/${id}/runs`),
        ]);
        if (!alive) return;
        setDraft({ name: w.name, tasks: w.tasks, edges: w.edges, patterns: w.patterns });
        setHistory(h);
        if (h[0]) void viewRun(h[0]);
      } catch (e) {
        if (alive) setLoadError(e instanceof ApiError && e.status === 404 ? 'This workflow does not exist.' : errorText(e));
      }
    })();
    return () => {
      alive = false;
      closeStream();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [id, viewRun, closeStream]);

  /* live topological analysis (debounced) on structural edits */
  const structKey = useMemo(
    () => (draft ? JSON.stringify({ t: draft.tasks.map((t) => [t.id, t.durationMs]), e: draft.edges }) : ''),
    [draft],
  );
  useEffect(() => {
    if (!structKey) return;
    const parsed = JSON.parse(structKey) as { t: [string, number][]; e: Edge[] };
    if (parsed.t.length === 0) {
      setSched(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const r = await api<ScheduleResponse>('/api/schedule', {
          method: 'POST',
          json: { tasks: parsed.t.map(([tid, d]) => ({ id: tid, durationMs: d })), edges: parsed.e },
        });
        if (alive) setSched(r);
      } catch (e) {
        if (alive) setNotice({ kind: 'err', text: errorText(e) });
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [structKey]);

  /* keep the event log scrolled to the newest line */
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  });

  const edit = (fn: (d: WorkflowInput) => WorkflowInput) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
  };

  async function save(): Promise<boolean> {
    if (!draft) return false;
    setSaving(true);
    try {
      await api<Workflow>(`/api/workflows/${id}`, { method: 'PUT', json: draft });
      setDirty(false);
      setNotice({ kind: 'ok', text: 'Saved.' });
      return true;
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof ApiError && e.body.errors ? e.body.errors.join(' • ') : errorText(e) });
      return false;
    } finally {
      setSaving(false);
    }
  }

  function openStream(runId: string) {
    closeStream();
    const es = new EventSource(`/api/runs/${runId}/stream?speed=${speed}`);
    esRef.current = es;
    es.onmessage = (m) => {
      applyEventMut(liveRef.current, JSON.parse(m.data));
      schedulePaint();
    };
    es.addEventListener('end', () => {
      es.close();
      esRef.current = null;
      liveRef.current.done = true;
      setRunning(false);
      repaint();
      void refreshRunAndHistory(runId);
    });
    es.onerror = () => {
      es.close();
      esRef.current = null;
      setRunning(false);
    };
  }

  function buildRunPayload() {
    const regexPatterns = regexInput
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      workers,
      mode,
      policy,
      scanner,
      speed: speed === 'instant' ? 1000 : Number(speed) || 4,
      regexPatterns,
      entropyThreshold: entropyEnabled ? entropyThreshold : undefined,
    };
  }

  async function startRun() {
    if (!draft) return;
    setNotice(null);
    setRunning(true);
    closeStream();
    try {
      if (dirty && !(await save())) {
        setRunning(false);
        return;
      }
      const summary = await api<RunSummary>(`/api/workflows/${id}/runs`, {
        method: 'POST',
        json: buildRunPayload(),
      });
      setRun(summary);
      setHistory((h) => [summary, ...h].slice(0, LIMITS.maxRunsPerWorkflow));
      liveRef.current = emptyLive();
      repaint();
      openStream(summary.id);
    } catch (e) {
      setRunning(false);
      if (e instanceof ApiError && e.status === 409 && e.body.cycle) {
        setNotice({
          kind: 'err',
          text: `Circular dependency: ${e.body.cycle.join(' → ')}. Remove one of these dependencies to run.`,
        });
      } else {
        setNotice({ kind: 'err', text: e instanceof ApiError && e.body.errors ? e.body.errors.join(' • ') : errorText(e) });
      }
    }
  }

  async function cancelActiveRun() {
    if (!run) return;
    try {
      await api(`/api/runs/${run.id}/cancel`, { method: 'POST' });
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    }
  }

  async function resumeSubgraph(allowlistExtra?: string) {
    if (!draft || !run) return;
    setNotice(null);
    setRunning(true);
    closeStream();
    try {
      if (dirty && !(await save())) {
        setRunning(false);
        return;
      }
      const allowlistPatterns = Array.from(
        new Set([...(run.allowlistedPatterns ?? []), ...(allowlistExtra ? [allowlistExtra] : [])]),
      );
      const summary = await api<RunSummary>(`/api/workflows/${id}/runs/${run.id}/resume`, {
        method: 'POST',
        json: { ...buildRunPayload(), allowlistPatterns },
      });
      setRun(summary);
      setHistory((h) => [summary, ...h].slice(0, LIMITS.maxRunsPerWorkflow));
      liveRef.current = replay([], summary.tasks);
      repaint();
      openStream(summary.id);
    } catch (e) {
      setRunning(false);
      setNotice({ kind: 'err', text: e instanceof ApiError && e.body.errors ? e.body.errors.join(' • ') : errorText(e) });
    }
  }

  async function exportSarif() {
    if (!run || !draft) return;
    const sarif = toSarifReport({
      toolRunName: draft.name,
      findings: liveRef.current.findings,
    });
    downloadJson(`${draft.name.replace(/\s+/g, '-').toLowerCase()}-findings.sarif.json`, sarif);
  }

  if (loadError) {
    return (
      <div className="page narrow">
        <div className="alert err">{loadError}</div>
        <Link href="/">← Back to workflows</Link>
      </div>
    );
  }
  if (!draft) return <div className="page"><p className="muted">Loading…</p></div>;

  const live = liveRef.current;
  const cycle = sched && !sched.ok ? sched.cycle : null;
  const sccs = sched && !sched.ok ? sched.sccs ?? [] : [];
  const suggestedBreaks = sched && !sched.ok ? sched.suggestedBreaks ?? [] : [];
  const levels = sched && sched.ok ? sched.levels : null;
  const ids = draft.tasks.map((t) => t.id);
  const hasRunData = run !== null;
  const m = run?.metrics;

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 12 }}>
        <Link href="/" className="muted">← Workflows</Link>
        <input
          className="title"
          value={draft.name}
          maxLength={LIMITS.maxNameLength}
          onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
          aria-label="Workflow name"
          style={{ flex: 1, minWidth: 220 }}
        />
        {dirty ? <Badge tone="amber">unsaved changes</Badge> : <Badge tone="green">saved</Badge>}
        <button className="ghost" onClick={() => downloadJson(`${draft.name || 'workflow'}.json`, draft)}>
          Export JSON
        </button>
        <button className="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {notice && (
        <div className={`alert ${notice.kind}`} role="status">
          <div className="row">
            <span>{notice.text}</span>
            <span className="spacer" />
            <button className="ghost icon" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
          </div>
        </div>
      )}

      <div className="workspace">
        {/* ---------------- left: editor ---------------- */}
        <div>
          <TasksCard
            tasks={draft.tasks}
            patterns={draft.patterns}
            openId={openTaskId}
            onToggleOpen={setOpenTaskId}
            onChange={(tid, patch) => edit((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === tid ? { ...t, ...patch } : t)) }))}
            onAdd={(tid, ms) => edit((d) => ({ ...d, tasks: [...d.tasks, { id: tid, name: tid, durationMs: ms, log: '' }] }))}
            onRemove={(tid) =>
              edit((d) => ({
                ...d,
                tasks: d.tasks.filter((t) => t.id !== tid),
                edges: d.edges.filter(([a, b]) => a !== tid && b !== tid),
              }))
            }
          />
          <EdgesCard
            tasks={draft.tasks}
            edges={draft.edges}
            cycle={cycle}
            onAdd={(e) => edit((d) => ({ ...d, edges: [...d.edges, e] }))}
            onRemove={(i) => edit((d) => ({ ...d, edges: d.edges.filter((_, k) => k !== i) }))}
          />
          <PatternsCard patterns={draft.patterns} onChange={(p) => edit((d) => ({ ...d, patterns: p }))} />
        </div>

        {/* ---------------- right: analysis + run ---------------- */}
        <div>
          <div className="card">
            <header>
              <h2>Dependency graph</h2>
              <div className="row">
                {cycle && <Badge tone="red">{sccs.length > 1 ? `${sccs.length} cyclic SCCs` : 'circular dependency'}</Badge>}
                {levels && <Badge tone="blue">{levels.length} level{levels.length === 1 ? '' : 's'}</Badge>}
                {sched?.ok && sched.criticalPath && sched.criticalPath.lengthMs > 0 && (
                  <Badge tone="violet" title={sched.criticalPath.path.join(' → ')}>critical path {fmtMs(sched.criticalPath.lengthMs)}</Badge>
                )}
                {sched && <Badge tone="gray" title="Time for the server to build the graph and run topological sort">sort {fmtFast(sched.scheduleMs)}</Badge>}
              </div>
            </header>
            {cycle && (
              <div className="alert err">
                <div>
                  <b>Circular dependency:</b> <span className="mono">{cycle.join(' → ')}</span>.
                  {sccs.length > 1 && <span> Tarjan SCC found <b>{sccs.length}</b> cyclic components.</span>}
                </div>
                {suggestedBreaks.length > 0 && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="small">Suggested edge breaks:</span>
                    {suggestedBreaks.map((sb) => (
                      <button
                        key={`${sb.from}->${sb.to}`}
                        className="danger icon"
                        onClick={() =>
                          edit((d) => ({
                            ...d,
                            edges: d.edges.filter(([a, b]) => !(a === sb.from && b === sb.to)),
                          }))
                        }
                      >
                        Break {sb.from} → {sb.to}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {draft.tasks.length > 0 && !sched ? (
              <div className="empty">Analyzing…</div>
            ) : (
              <GraphView
                ids={ids}
                edges={draft.edges}
                levels={levels}
                cycle={cycle}
                states={live.states}
                onSelectTask={(tid) => setOpenTaskId((cur) => (cur === tid ? null : tid))}
              />
            )}
            {levels && levels.length > 0 && levels.length <= 12 && (
              <div className="small muted" style={{ marginTop: 10, display: 'grid', gap: 3 }}>
                {levels.map((lv, i) => (
                  <div key={i}><b style={{ color: 'var(--text)' }}>Level {i + 1}</b> (can run in parallel): <span className="mono">{lv.join(', ')}</span></div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <header>
              <h2>Run</h2>
              <div className="row">
                <label className="row small muted" style={{ gap: 6 }}>
                  Mode
                  <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)} disabled={running}>
                    <option value="live">Live async stream</option>
                    <option value="simulate">Simulated replay</option>
                  </select>
                </label>
                <label className="row small muted" style={{ gap: 6 }}>
                  Policy
                  <select value={policy} onChange={(e) => setPolicy(e.target.value as SchedulePolicy)} disabled={running}>
                    <option value="topo-fifo">Topological FIFO</option>
                    <option value="critical-path">Critical Path First</option>
                    <option value="shortest-first">Shortest First</option>
                  </select>
                </label>
                <label className="row small muted" style={{ gap: 6 }}>
                  Scanner
                  <select value={scanner} onChange={(e) => setScanner(e.target.value as ScannerMode)} disabled={running}>
                    <option value="aho-corasick">Aho-Corasick O(N+Z)</option>
                    <option value="kmp">KMP O(k·N)</option>
                  </select>
                </label>
                <label className="row small muted" style={{ gap: 6 }}>
                  Workers
                  <input
                    type="number"
                    min={LIMITS.minWorkers}
                    max={LIMITS.maxWorkers}
                    value={workers}
                    style={{ width: 60 }}
                    onChange={(e) => setWorkers(Math.min(LIMITS.maxWorkers, Math.max(LIMITS.minWorkers, Math.round(Number(e.target.value)) || 1)))}
                    disabled={running}
                  />
                </label>
                <label className="row small muted" style={{ gap: 6 }}>
                  Speed
                  <select value={speed} onChange={(e) => setSpeed(e.target.value)} disabled={running}>
                    <option value="1">1× real time</option>
                    <option value="4">4×</option>
                    <option value="20">20×</option>
                    <option value="instant">Instant</option>
                  </select>
                </label>
                <button className="ghost icon" onClick={() => setShowAdvancedRules((v) => !v)}>
                  {showAdvancedRules ? 'Hide NFA/Entropy' : '+ NFA / Entropy'}
                </button>
                <button className="primary" onClick={() => void startRun()} disabled={running || draft.tasks.length === 0 || !!cycle}>
                  {running ? 'Running…' : '▶ Run workflow'}
                </button>
                {running && mode === 'live' && (
                  <button className="danger" onClick={() => void cancelActiveRun()}>■ Abort</button>
                )}
                {running && mode === 'simulate' && run && (
                  <button onClick={() => void viewRun(run)}>Skip to end</button>
                )}
              </div>
            </header>

            {showAdvancedRules && (
              <div className="stat" style={{ marginBottom: 12, display: 'grid', gap: 10 }}>
                <label className="field">
                  Thompson NFA Regex Rules (one per line, linear-time O(N·M))
                  <textarea
                    rows={2}
                    value={regexInput}
                    onChange={(e) => setRegexInput(e.target.value)}
                    placeholder="e.g. AKIA[0-9A-Z]{16} or token=[A-Za-z0-9._-]{16,}"
                    spellCheck={false}
                    disabled={running}
                  />
                </label>
                <div className="row small muted">
                  <label className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={entropyEnabled}
                      onChange={(e) => setEntropyEnabled(e.target.checked)}
                      disabled={running}
                    />
                    Detect high-entropy tokens (Shannon entropy ≥
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min={2.5}
                    max={7.5}
                    value={entropyThreshold}
                    onChange={(e) => setEntropyThreshold(Number(e.target.value) || 4.3)}
                    style={{ width: 70 }}
                    disabled={running || !entropyEnabled}
                  />
                  <span>bits/byte)</span>
                </div>
              </div>
            )}

            {!hasRunData ? (
              <div className="empty">Press Run to schedule tasks, stream their logs through the byte scanner, and watch quarantines happen live.</div>
            ) : (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <Badge tone={live.cancelled ? 'red' : live.done ? 'green' : 'blue'}>
                    {live.cancelled ? 'aborted' : live.done ? 'finished' : 'running'}
                  </Badge>
                  <Badge tone="gray">{run.mode ?? 'simulate'}</Badge>
                  <Badge tone="violet">{run.policy ?? 'topo-fifo'}</Badge>
                  <Badge tone="blue">{run.scanner ?? 'kmp'}</Badge>
                  {run.resumedFromRunId && <Badge tone="amber">resumed subgraph</Badge>}
                  <span className="muted small mono">
                    virtual time {fmtMs(live.now)} · {run.workers} worker{run.workers === 1 ? '' : 's'} · {new Date(run.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="spacer" />
                  {live.done && (
                    <>
                      <button className="ghost icon" onClick={() => void exportSarif()}>Export SARIF</button>
                      <button className="ghost icon" onClick={() => downloadJson(`run-${run.id}.json`, run)}>Export JSON</button>
                      {(live.findings.length > 0 || live.cancelled) && (
                        <button className="primary icon" onClick={() => void resumeSubgraph()}>
                          ↻ Resume subgraph
                        </button>
                      )}
                    </>
                  )}
                </div>

                <Gantt segments={live.segments} workers={run.workers} now={live.now} makespan={live.done ? m!.makespanMs : 0} />

                {live.done && m && (
                  <>
                    <div className="stats" style={{ marginTop: 14 }}>
                      <div className="stat"><div className="v">{fmtMs(m.makespanMs)}</div><div className="k">Makespan</div></div>
                      <div className="stat"><div className="v">{fmtMs(m.sequentialMs)}</div><div className="k">One-worker time</div></div>
                      <div className="stat"><div className="v">{m.speedup.toFixed(2)}×</div><div className="k">Speedup</div></div>
                      <div className="stat"><div className="v">{Math.round(m.utilization * 100)}%</div><div className="k">Worker utilization</div></div>
                      <div className="stat" title={m.criticalPath.join(' → ')}><div className="v">{fmtMs(m.criticalPathMs)}</div><div className="k">Critical path (plan)</div></div>
                      <div className="stat"><div className="v">{fmtFast(m.scheduleMs)}</div><div className="k">Topological sort</div></div>
                      <div className="stat"><div className="v">{fmtFast(m.scanMs)}</div><div className="k">Scan · {fmtBytes(m.bytesScanned)}</div></div>
                      <div className="stat"><div className="v">
                        <span style={{ color: 'var(--green)' }}>{m.completed}</span> / <span style={{ color: 'var(--red)' }}>{m.quarantined}</span> / <span style={{ color: 'var(--muted)' }}>{m.cancelled}</span>
                      </div><div className="k">Done / quarantined / cancelled</div></div>
                    </div>
                    {m.criticalPath.length > 0 && (
                      <p className="muted small mono" style={{ marginBottom: 0 }}>Critical path: {m.criticalPath.join(' → ')}</p>
                    )}
                  </>
                )}

                <h2 style={{ margin: '18px 0 8px' }}>Event log</h2>
                <div className="eventlog" ref={logRef} aria-live="polite">
                  {live.log.length === 0 ? <span className="muted">waiting for events…</span> : live.log.map((l, i) => <div key={i} className={l.kind}>{l.text}</div>)}
                </div>

                <h2 style={{ margin: '18px 0 8px' }}>Security findings</h2>
                {live.findings.length === 0 ? (
                  <div className="empty">{live.done ? 'No forbidden patterns found. All tasks completed.' : 'None so far.'}</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Task</th><th>Rule</th><th>Byte / Line</th><th>Context</th><th>Action</th></tr>
                      </thead>
                      <tbody>
                        {live.findings.map((f) => (
                          <tr key={`${f.taskId}-${f.byteOffset}`}>
                            <td className="mono">{f.taskId}</td>
                            <td>
                              <Badge tone="red">{f.pattern}</Badge>
                              {f.ruleKind && <span className="muted small" style={{ marginLeft: 6 }}>{f.ruleKind}</span>}
                            </td>
                            <td className="mono">{fmtNum(f.byteOffset)} ({f.line}:{f.column})</td>
                            <td className="snippet">
                              {f.context ? (
                                <>
                                  {f.context.before}<mark>{f.context.match}</mark>{f.context.after}
                                </>
                              ) : (
                                <StateBadge state="quarantined" />
                              )}
                            </td>
                            <td>
                              {live.done && f.ruleKind !== 'regex' && f.ruleKind !== 'entropy' && (
                                <button className="ghost icon" onClick={() => void resumeSubgraph(f.pattern)}>
                                  Allowlist &amp; resume
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {live.done && run.tasks.some((t) => t.state === 'cancelled') && (
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    Cancelled because a prerequisite was quarantined/aborted:{' '}
                    {run.tasks.filter((t) => t.state === 'cancelled').map((t) => `${t.id} (via ${t.cancelledBy})`).join(', ')}.
                  </p>
                )}
              </>
            )}
          </div>

          {history.length > 0 && (
            <div className="card">
              <header><h2>Run history</h2><Badge tone="gray">last {LIMITS.maxRunsPerWorkflow}</Badge></header>
              <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>When</th><th>Config</th><th>Makespan</th><th>Outcome</th><th /></tr></thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td className="small">{new Date(h.createdAt).toLocaleString()}</td>
                        <td className="small muted">{h.workers}w · {h.policy ?? 'topo-fifo'} · {h.scanner ?? 'kmp'}</td>
                        <td>{fmtMs(h.metrics.makespanMs)}</td>
                        <td>
                          <span className="row" style={{ gap: 6 }}>
                            <Badge tone="green">{h.metrics.completed}</Badge>
                            {h.metrics.quarantined > 0 && <Badge tone="red">{h.metrics.quarantined} quarantined</Badge>}
                            {h.metrics.cancelled > 0 && <Badge tone="gray">{h.metrics.cancelled} cancelled</Badge>}
                          </span>
                        </td>
                        <td><button className="ghost icon" onClick={() => void viewRun(h)}>{run?.id === h.id ? 'Viewing' : 'View'}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
