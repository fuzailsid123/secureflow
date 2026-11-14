export interface Task {
  id: string;
  name: string;
  durationMs: number;
  log: string;
}

export type Edge = [string, string];

export interface WorkflowInput {
  name: string;
  tasks: Task[];
  edges: Edge[];
  patterns: string[];
}

export interface Workflow extends WorkflowInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  taskCount: number;
  edgeCount: number;
  patternCount: number;
  updatedAt: string;
}

export type TaskState = 'pending' | 'running' | 'completed' | 'quarantined' | 'cancelled';
export type SchedulePolicy = 'topo-fifo' | 'critical-path' | 'shortest-first';
export type ScannerMode = 'kmp' | 'aho-corasick';
export type RunMode = 'simulate' | 'live';
export type RunStatus = 'running' | 'completed' | 'cancelled';
export type RuleKind = 'literal' | 'regex' | 'entropy';

export interface FindingContext {
  before: string;
  match: string;
  after: string;
}

export interface Finding {
  taskId: string;
  pattern: string;
  byteOffset: number;
  line: number;
  column: number;
  ruleKind?: RuleKind;
  entropy?: number;
  context?: FindingContext;
}

export type RunEvent =
  | { t: number; type: 'task_start'; taskId: string; worker: number }
  | { t: number; type: 'task_complete'; taskId: string }
  | { t: number; type: 'task_quarantined'; taskId: string; finding: Finding }
  | { t: number; type: 'task_cancelled'; taskId: string; because: string }
  | { t: number; type: 'run_cancelled'; reason?: string }
  | { t: number; type: 'run_complete' };

export interface TaskResult {
  id: string;
  state: TaskState;
  worker?: number;
  startMs?: number;
  endMs?: number;
  cancelledBy?: string;
}

export interface RunMetrics {
  makespanMs: number;
  sequentialMs: number;
  speedup: number;
  utilization: number;
  criticalPath: string[];
  criticalPathMs: number;
  scheduleMs: number;
  scanMs: number;
  bytesScanned: number;
  completed: number;
  quarantined: number;
  cancelled: number;
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  createdAt: string;
  workers: number;
  status?: RunStatus;
  mode?: RunMode;
  policy?: SchedulePolicy;
  scanner?: ScannerMode;
  resumedFromRunId?: string;
  allowlistedPatterns?: string[];
  levels: string[][];
  tasks: TaskResult[];
  findings: Finding[];
  metrics: RunMetrics;
  eventCount: number;
}

export interface Run extends RunSummary {
  events: RunEvent[];
}

export interface CycleBreakSuggestion {
  from: string;
  to: string;
  sccSize: number;
}

export type ScheduleResponse =
  | {
      ok: true;
      levels: string[][];
      order: string[];
      scheduleMs: number;
      criticalPath?: { path: string[]; lengthMs: number };
      bottomLevels?: Record<string, number>;
    }
  | {
      ok: false;
      cycle: string[];
      scheduleMs: number;
      sccs?: string[][];
      suggestedBreaks?: CycleBreakSuggestion[];
    };
