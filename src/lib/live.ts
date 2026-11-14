import { fmtMs } from './format';
import type { Finding, RunEvent, TaskResult, TaskState } from './types';

export interface Segment {
  taskId: string;
  worker: number;
  start: number;
  end: number | null;
  state: TaskState;
}

export interface LogLine {
  t: number;
  kind: 'start' | 'ok' | 'bad' | 'cancel' | 'info';
  text: string;
}

export interface LiveState {
  states: Record<string, TaskState>;
  segments: Segment[];
  findings: Finding[];
  log: LogLine[];
  now: number;
  done: boolean;
  cancelled: boolean;
}

const LOG_CAP = 300;

export const emptyLive = (): LiveState => ({
  states: {},
  segments: [],
  findings: [],
  log: [],
  now: 0,
  done: false,
  cancelled: false,
});

function pushLog(s: LiveState, line: LogLine) {
  s.log.push(line);
  if (s.log.length > LOG_CAP) s.log.shift();
}

function finish(s: LiveState, id: string, t: number, state: TaskState) {
  s.states[id] = state;
  for (let i = s.segments.length - 1; i >= 0; i--) {
    if (s.segments[i].taskId === id) {
      s.segments[i].end = t;
      s.segments[i].state = state;
      return;
    }
  }
}

/** Applies one event IN PLACE (cheap, used for streaming and replay). */
export function applyEventMut(s: LiveState, e: RunEvent): LiveState {
  s.now = e.t;
  const at = fmtMs(e.t);
  switch (e.type) {
    case 'task_start':
      s.states[e.taskId] = 'running';
      s.segments.push({ taskId: e.taskId, worker: e.worker, start: e.t, end: null, state: 'running' });
      pushLog(s, { t: e.t, kind: 'start', text: `${at}  \u25b6 ${e.taskId} started on worker ${e.worker + 1}` });
      break;
    case 'task_complete':
      finish(s, e.taskId, e.t, 'completed');
      pushLog(s, { t: e.t, kind: 'ok', text: `${at}  \u2714 ${e.taskId} completed` });
      break;
    case 'task_quarantined':
      finish(s, e.taskId, e.t, 'quarantined');
      s.findings.push(e.finding);
      pushLog(s, {
        t: e.t,
        kind: 'bad',
        text: `${at}  \u26d4 ${e.taskId} QUARANTINED: found "${e.finding.pattern}" at byte ${e.finding.byteOffset} (line ${e.finding.line})`,
      });
      break;
    case 'task_cancelled':
      s.states[e.taskId] = 'cancelled';
      pushLog(s, {
        t: e.t,
        kind: 'cancel',
        text: `${at}  \u2716 ${e.taskId} cancelled (${e.because === 'USER_CANCEL' ? 'run aborted' : `depends on quarantined ${e.because}`})`,
      });
      break;
    case 'run_cancelled':
      s.done = true;
      s.cancelled = true;
      pushLog(s, { t: e.t, kind: 'bad', text: `${at}  \u25a0 run cancelled${e.reason ? `: ${e.reason}` : ''}` });
      break;
    case 'run_complete':
      s.done = true;
      pushLog(s, { t: e.t, kind: 'info', text: `${at}  \u25a0 run complete` });
      break;
  }
  return s;
}

/** Rebuilds the full final state from a stored event list (plus optional pre-completed resumed tasks). */
export function replay(events: RunEvent[], seededTasks?: TaskResult[]): LiveState {
  const s = emptyLive();
  if (seededTasks) {
    for (const t of seededTasks) {
      if (t.state === 'completed' && t.startMs === undefined) {
        s.states[t.id] = 'completed';
      }
    }
  }
  for (const e of events) applyEventMut(s, e);
  return s;
}
