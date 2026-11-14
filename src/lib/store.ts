import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS } from './limits';
import type {
  Finding,
  Run,
  RunEvent,
  RunMetrics,
  RunMode,
  RunStatus,
  RunSummary,
  ScannerMode,
  SchedulePolicy,
  TaskResult,
  Workflow,
  WorkflowInput,
  WorkflowSummary,
} from './types';

/**
 * SQLite-backed persistence (using built-in `node:sqlite`) at `${DATA_DIR}/secureflow.db`.
 * Stores workflows, runs, ordered run events, and security findings in normalized indexed tables.
 * Automatically migrates legacy `store.json` data on first open if present.
 */
interface LegacyDB {
  workflows?: Record<string, Workflow>;
  runs?: Record<string, Run>;
}

interface StoreState {
  dir: string;
  initialized: boolean;
  chain: Promise<unknown>;
}

function state(): StoreState {
  const g = globalThis as typeof globalThis & { __secureflowStore?: StoreState };
  const dir = process.env.DATA_DIR ?? path.join(process.cwd(), '.data');
  if (!g.__secureflowStore || g.__secureflowStore.dir !== dir) {
    g.__secureflowStore = { dir, initialized: false, chain: Promise.resolve() };
  }
  return g.__secureflowStore;
}

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = TRUNCATE;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  edges_json TEXT NOT NULL,
  patterns_json TEXT NOT NULL,
  task_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  pattern_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  workers INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  mode TEXT NOT NULL DEFAULT 'simulate',
  policy TEXT NOT NULL DEFAULT 'topo-fifo',
  scanner TEXT NOT NULL DEFAULT 'kmp',
  resumed_from_run_id TEXT,
  allowlisted_patterns_json TEXT,
  levels_json TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  event_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_wf_created ON runs(workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  t REAL NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  line INTEGER NOT NULL,
  column_num INTEGER NOT NULL,
  rule_kind TEXT,
  entropy REAL,
  context_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
`;

function insertRunRecords(db: DatabaseSync, run: Run): void {
  db.prepare(
    `INSERT OR REPLACE INTO runs (
      id, workflow_id, workflow_name, created_at, workers, status, mode, policy, scanner,
      resumed_from_run_id, allowlisted_patterns_json, levels_json, tasks_json, metrics_json, event_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.workflowId,
    run.workflowName,
    run.createdAt,
    run.workers,
    run.status ?? 'completed',
    run.mode ?? 'simulate',
    run.policy ?? 'topo-fifo',
    run.scanner ?? 'kmp',
    run.resumedFromRunId ?? null,
    run.allowlistedPatterns ? JSON.stringify(run.allowlistedPatterns) : null,
    JSON.stringify(run.levels),
    JSON.stringify(run.tasks),
    JSON.stringify(run.metrics),
    run.events.length,
  );

  db.prepare('DELETE FROM run_events WHERE run_id = ?').run(run.id);
  const insEv = db.prepare('INSERT INTO run_events (run_id, seq, t, type, payload_json) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < run.events.length; i++) {
    const ev = run.events[i];
    insEv.run(run.id, i, ev.t, ev.type, JSON.stringify(ev));
  }

  db.prepare('DELETE FROM findings WHERE run_id = ?').run(run.id);
  const insFind = db.prepare(
    `INSERT INTO findings (run_id, task_id, pattern, byte_offset, line, column_num, rule_kind, entropy, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of run.findings) {
    insFind.run(
      run.id,
      f.taskId,
      f.pattern,
      f.byteOffset,
      f.line,
      f.column,
      f.ruleKind ?? null,
      f.entropy ?? null,
      f.context ? JSON.stringify(f.context) : null,
    );
  }
}

function migrateLegacyJsonIfNeeded(db: DatabaseSync, dir: string): void {
  const legacyPath = path.join(dir, 'store.json');
  if (!existsSync(legacyPath)) return;
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM workflows').get() as { cnt: number };
  if (countRow.cnt > 0) return;

  try {
    const raw = readFileSync(legacyPath, 'utf8');
    const parsed = JSON.parse(raw) as LegacyDB;
    const workflows = Object.values(parsed.workflows ?? {});
    const runs = Object.values(parsed.runs ?? {});
    if (workflows.length === 0 && runs.length === 0) return;

    db.exec('BEGIN IMMEDIATE');
    try {
      const insWf = db.prepare(
        `INSERT OR IGNORE INTO workflows (
          id, name, tasks_json, edges_json, patterns_json, task_count, edge_count, pattern_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const w of workflows) {
        insWf.run(
          w.id,
          w.name,
          JSON.stringify(w.tasks),
          JSON.stringify(w.edges),
          JSON.stringify(w.patterns),
          w.tasks.length,
          w.edges.length,
          w.patterns.length,
          w.createdAt,
          w.updatedAt,
        );
      }
      for (const r of runs) {
        if (parsed.workflows?.[r.workflowId]) {
          insertRunRecords(db, r);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch {
    /* ignore malformed legacy file if empty/corrupt */
  }
}

function withDb<T>(s: StoreState, write: boolean, fn: (db: DatabaseSync) => T): T {
  mkdirSync(s.dir, { recursive: true });
  const db = new DatabaseSync(path.join(s.dir, 'secureflow.db'));
  try {
    if (!s.initialized) {
      db.exec(SCHEMA_SQL);
      migrateLegacyJsonIfNeeded(db, s.dir);
      s.initialized = true;
    } else {
      db.exec('PRAGMA foreign_keys = ON;');
    }

    if (!write) {
      return fn(db);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn(db);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw e;
    }
  } finally {
    db.close();
  }
}

function runSerialized<T>(write: boolean, fn: (db: DatabaseSync) => T): Promise<T> {
  const s = state();
  const res = s.chain.then(() => withDb(s, write, fn));
  s.chain = res.catch(() => undefined);
  return res;
}

export function summarize(w: Workflow): WorkflowSummary {
  return {
    id: w.id,
    name: w.name,
    taskCount: w.tasks.length,
    edgeCount: w.edges.length,
    patternCount: w.patterns.length,
    updatedAt: w.updatedAt,
  };
}

export function listWorkflows(): Promise<WorkflowSummary[]> {
  return runSerialized(false, (db) => {
    const rows = db
      .prepare(
        'SELECT id, name, task_count, edge_count, pattern_count, updated_at FROM workflows ORDER BY updated_at DESC',
      )
      .all() as Array<{
      id: string;
      name: string;
      task_count: number;
      edge_count: number;
      pattern_count: number;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      taskCount: r.task_count,
      edgeCount: r.edge_count,
      patternCount: r.pattern_count,
      updatedAt: r.updated_at,
    }));
  });
}

export function getWorkflow(id: string): Promise<Workflow | null> {
  return runSerialized(false, (db) => {
    const row = db
      .prepare(
        'SELECT id, name, tasks_json, edges_json, patterns_json, created_at, updated_at FROM workflows WHERE id = ?',
      )
      .get(id) as
      | {
          id: string;
          name: string;
          tasks_json: string;
          edges_json: string;
          patterns_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      tasks: JSON.parse(row.tasks_json) as Workflow['tasks'],
      edges: JSON.parse(row.edges_json) as Workflow['edges'],
      patterns: JSON.parse(row.patterns_json) as Workflow['patterns'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function createWorkflow(input: WorkflowInput): Promise<Workflow> {
  return runSerialized(true, (db) => {
    const now = new Date().toISOString();
    const w: Workflow = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    db.prepare(
      `INSERT INTO workflows (
        id, name, tasks_json, edges_json, patterns_json, task_count, edge_count, pattern_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      w.id,
      w.name,
      JSON.stringify(w.tasks),
      JSON.stringify(w.edges),
      JSON.stringify(w.patterns),
      w.tasks.length,
      w.edges.length,
      w.patterns.length,
      w.createdAt,
      w.updatedAt,
    );
    return w;
  });
}

export function updateWorkflow(id: string, input: WorkflowInput): Promise<Workflow | null> {
  return runSerialized(true, (db) => {
    const prev = db.prepare('SELECT created_at FROM workflows WHERE id = ?').get(id) as
      | { created_at: string }
      | undefined;
    if (!prev) return null;
    const updatedAt = new Date().toISOString();
    db.prepare(
      `UPDATE workflows
       SET name = ?, tasks_json = ?, edges_json = ?, patterns_json = ?,
           task_count = ?, edge_count = ?, pattern_count = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      JSON.stringify(input.tasks),
      JSON.stringify(input.edges),
      JSON.stringify(input.patterns),
      input.tasks.length,
      input.edges.length,
      input.patterns.length,
      updatedAt,
      id,
    );
    return { ...input, id, createdAt: prev.created_at, updatedAt };
  });
}

export function deleteWorkflow(id: string): Promise<boolean> {
  return runSerialized(true, (db) => {
    const info = db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return Number(info.changes) > 0;
  });
}

export function toSummary(run: Run): RunSummary {
  const { events, ...rest } = run;
  void events;
  return rest;
}

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  created_at: string;
  workers: number;
  status: RunStatus;
  mode: RunMode;
  policy: SchedulePolicy;
  scanner: ScannerMode;
  resumed_from_run_id: string | null;
  allowlisted_patterns_json: string | null;
  levels_json: string;
  tasks_json: string;
  metrics_json: string;
  event_count: number;
}

interface FindingRow {
  task_id: string;
  pattern: string;
  byte_offset: number;
  line: number;
  column_num: number;
  rule_kind: Finding['ruleKind'] | null;
  entropy: number | null;
  context_json: string | null;
}

function hydrateFindings(db: DatabaseSync, runId: string): Finding[] {
  const rows = db
    .prepare(
      'SELECT task_id, pattern, byte_offset, line, column_num, rule_kind, entropy, context_json FROM findings WHERE run_id = ? ORDER BY id ASC',
    )
    .all(runId) as unknown as FindingRow[];
  return rows.map((f) => {
    const out: Finding = {
      taskId: f.task_id,
      pattern: f.pattern,
      byteOffset: f.byte_offset,
      line: f.line,
      column: f.column_num,
    };
    if (f.rule_kind) out.ruleKind = f.rule_kind;
    if (f.entropy !== null) out.entropy = f.entropy;
    if (f.context_json) out.context = JSON.parse(f.context_json) as Finding['context'];
    return out;
  });
}

function hydrateSummary(db: DatabaseSync, row: RunRow): RunSummary {
  const summary: RunSummary = {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    createdAt: row.created_at,
    workers: row.workers,
    status: row.status,
    mode: row.mode,
    policy: row.policy,
    scanner: row.scanner,
    levels: JSON.parse(row.levels_json) as string[][],
    tasks: JSON.parse(row.tasks_json) as TaskResult[],
    findings: hydrateFindings(db, row.id),
    metrics: JSON.parse(row.metrics_json) as RunMetrics,
    eventCount: row.event_count,
  };
  if (row.resumed_from_run_id) summary.resumedFromRunId = row.resumed_from_run_id;
  if (row.allowlisted_patterns_json) {
    summary.allowlistedPatterns = JSON.parse(row.allowlisted_patterns_json) as string[];
  }
  return summary;
}

function enforceRunRetention(db: DatabaseSync, workflowId: string): void {
  const old = db
    .prepare('SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?')
    .all(workflowId, LIMITS.maxRunsPerWorkflow) as Array<{ id: string }>;
  const del = db.prepare('DELETE FROM runs WHERE id = ?');
  for (const row of old) del.run(row.id);
}

export function saveRun(run: Run): Promise<Run> {
  return runSerialized(true, (db) => {
    insertRunRecords(db, run);
    enforceRunRetention(db, run.workflowId);
    return run;
  });
}

export function getRun(id: string): Promise<Run | null> {
  return runSerialized(false, (db) => {
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) return null;
    const summary = hydrateSummary(db, row);
    const evRows = db
      .prepare('SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq ASC')
      .all(id) as Array<{ payload_json: string }>;
    const events = evRows.map((e) => JSON.parse(e.payload_json) as RunEvent);
    return { ...summary, events };
  });
}

export function listRuns(workflowId: string): Promise<RunSummary[]> {
  return runSerialized(false, (db) => {
    const rows = db
      .prepare('SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC')
      .all(workflowId) as unknown as RunRow[];
    return rows.map((r) => hydrateSummary(db, r));
  });
}
