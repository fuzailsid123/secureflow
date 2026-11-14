import { ID_PATTERN, LIMITS } from './limits';
import { toSarifReport, type SarifFindingInput } from './sarif';
import type { Edge, Task, WorkflowInput } from './types';
import { validateWorkflowInput } from './validate';

export { toSarifReport, type SarifFindingInput };

export type ImportResult = { ok: true; value: WorkflowInput; format: 'json' | 'github-actions-yaml' } | { ok: false; errors: string[] };

function sanitizeId(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, LIMITS.maxIdLength);
  if (cleaned && ID_PATTERN.test(cleaned)) return cleaned;
  return fallback;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parses a GitHub Actions `.yml` / `.yaml` workflow into a SecureFlow `WorkflowInput`.
 * Maps `jobs.<jobId>` to tasks and `needs` (inline array, single scalar, or bullet list) to DAG edges.
 */
export function parseGitHubActionsYaml(yamlText: string): ImportResult {
  const lines = yamlText.replace(/\r\n/g, '\n').split('\n');
  let wfName = 'Imported GitHub Actions workflow';

  let inJobs = false;
  let jobsIndent = -1;
  let curJobId: string | null = null;
  let curJobIndent = -1;
  let curSection: 'none' | 'needs' | 'steps' = 'none';
  let curSectionIndent = -1;

  interface JobDraft {
    id: string;
    name: string;
    needs: string[];
    stepLines: string[];
  }
  const jobs = new Map<string, JobDraft>();
  const order: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = rawLine.search(/\S/);

    if (!inJobs && indent === 0 && trimmed.startsWith('name:')) {
      const val = unquote(trimmed.slice(5));
      if (val) wfName = val.slice(0, LIMITS.maxNameLength);
      continue;
    }

    if (indent === 0 && trimmed === 'jobs:') {
      inJobs = true;
      jobsIndent = 0;
      curJobId = null;
      curSection = 'none';
      continue;
    }

    if (inJobs && indent <= jobsIndent) {
      inJobs = false;
      curJobId = null;
      curSection = 'none';
      continue;
    }
    if (!inJobs) continue;

    // Detect job header under `jobs:`
    if (curJobId === null || indent === curJobIndent) {
      const m = /^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(trimmed);
      if (m) {
        curJobId = sanitizeId(m[1], `job-${order.length + 1}`);
        curJobIndent = indent;
        curSection = 'none';
        if (!jobs.has(curJobId)) {
          jobs.set(curJobId, { id: curJobId, name: curJobId, needs: [], stepLines: [] });
          order.push(curJobId);
        }
        continue;
      }
    }

    if (!curJobId) continue;
    const job = jobs.get(curJobId)!;

    if (indent <= curJobIndent) continue;

    if (curSection === 'needs' && indent > curSectionIndent && trimmed.startsWith('-')) {
      const dep = unquote(trimmed.slice(1));
      if (dep) job.needs.push(sanitizeId(dep, dep));
      continue;
    }

    if (curSection === 'steps' && indent > curSectionIndent) {
      job.stepLines.push(trimmed);
      continue;
    }

    curSection = 'none';

    if (trimmed.startsWith('name:')) {
      const val = unquote(trimmed.slice(5));
      if (val) job.name = val.slice(0, LIMITS.maxNameLength);
    } else if (trimmed.startsWith('needs:')) {
      const rest = trimmed.slice(6).trim();
      if (!rest) {
        curSection = 'needs';
        curSectionIndent = indent;
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        for (const item of rest.slice(1, -1).split(',')) {
          const dep = unquote(item);
          if (dep) job.needs.push(sanitizeId(dep, dep));
        }
      } else {
        job.needs.push(sanitizeId(unquote(rest), rest));
      }
    } else if (trimmed === 'steps:' || trimmed.startsWith('steps:')) {
      curSection = 'steps';
      curSectionIndent = indent;
    }
  }

  if (order.length === 0) {
    return { ok: false, errors: ['No `jobs:` entries found in YAML workflow'] };
  }

  const tasks: Task[] = order.map((id, idx) => {
    const j = jobs.get(id)!;
    const log = j.stepLines.length > 0
      ? j.stepLines.map((l, i) => `[${id}] step ${i + 1}: ${l}`).join('\n') + '\n'
      : `[${id}] job "${j.name}" completed cleanly\n`;
    return {
      id: j.id,
      name: j.name,
      durationMs: 1000 + ((idx * 350) % 2500),
      log,
    };
  });

  const idSet = new Set(order);
  const edges: Edge[] = [];
  for (const id of order) {
    const j = jobs.get(id)!;
    for (const dep of j.needs) {
      if (!idSet.has(dep)) {
        return { ok: false, errors: [`Job "${id}" needs unknown job "${dep}"`] };
      }
      edges.push([dep, id]);
    }
  }

  const candidate: WorkflowInput = {
    name: wfName,
    tasks,
    edges,
    patterns: ['UNAUTHORIZED_ACCESS', 'AWS_SECRET_ACCESS_KEY', 'DEPRECATED_CALL'],
  };
  const v = validateWorkflowInput(candidate);
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, value: v.value, format: 'github-actions-yaml' };
}

/** Auto-detects JSON vs GitHub Actions YAML and validates into a `WorkflowInput`. */
export function parseWorkflowImport(raw: string): ImportResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, errors: ['Import content is empty'] };
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const v = validateWorkflowInput(parsed);
      return v.ok ? { ok: true, value: v.value, format: 'json' } : { ok: false, errors: v.errors };
    } catch {
      return { ok: false, errors: ['Invalid JSON syntax'] };
    }
  }
  return parseGitHubActionsYaml(trimmed);
}
