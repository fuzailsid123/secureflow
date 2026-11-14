import { randomUUID } from 'node:crypto';
import { badRequest, json, notFound, readJson, requireApiKey } from '@/lib/http';
import { startLiveRun } from '@/lib/runner';
import { CycleError, simulateRun } from '@/lib/simulate';
import { getRun, getWorkflow, saveRun, toSummary } from '@/lib/store';
import { GraphError } from '@/lib/topo';
import {
  validateEntropyThreshold,
  validateRegexList,
  validateRunMode,
  validateScannerMode,
  validateSchedulePolicy,
  validateWorkers,
} from '@/lib/validate';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; runId: string }> };

/**
 * Incremental subgraph recovery: reuses `completed` tasks from `runId` and re-schedules only
 * the quarantined + downstream cancelled + unrun tasks (optionally allowlisting false-positive patterns).
 */
export async function POST(req: Request, { params }: Ctx) {
  const denied = requireApiKey(req);
  if (denied) return denied;

  const { id, runId } = await params;
  const wf = await getWorkflow(id);
  if (!wf) return notFound('Workflow');

  const prevRun = await getRun(runId);
  if (!prevRun || prevRun.workflowId !== id) return notFound('Run');

  const body = (await readJson(req)) as Record<string, unknown> | undefined;
  const obj = typeof body === 'object' && body !== null ? body : {};

  const w = validateWorkers('workers' in obj ? obj.workers : prevRun.workers);
  if (!w.ok) return badRequest(w.errors);
  const pol = validateSchedulePolicy(obj.policy ?? prevRun.policy);
  if (!pol.ok) return badRequest(pol.errors);
  const scn = validateScannerMode(obj.scanner ?? prevRun.scanner);
  if (!scn.ok) return badRequest(scn.errors);
  const md = validateRunMode(obj.mode ?? prevRun.mode);
  if (!md.ok) return badRequest(md.errors);
  const rx = validateRegexList(obj.regexPatterns);
  if (!rx.ok) return badRequest(rx.errors);
  const ent = validateEntropyThreshold(obj.entropyThreshold);
  if (!ent.ok) return badRequest(ent.errors);

  const allowlistRaw = obj.allowlistPatterns;
  const allowlistedPatterns: string[] = Array.isArray(allowlistRaw)
    ? allowlistRaw.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : prevRun.allowlistedPatterns ?? [];

  // Only keep tasks that completed in `prevRun` AND still exist in the workflow.
  const currentIds = new Set(wf.tasks.map((t) => t.id));
  const completedIds = new Set(
    prevRun.tasks.filter((t) => t.state === 'completed' && currentIds.has(t.id)).map((t) => t.id),
  );
  // Safety invariant: if a task was edited to depend on a non-completed task, don't pre-seed it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [u, v] of wf.edges) {
      if (completedIds.has(v) && !completedIds.has(u)) {
        completedIds.delete(v);
        changed = true;
      }
    }
  }

  const speed = typeof obj.speed === 'number' && Number.isFinite(obj.speed) ? obj.speed : 4;

  try {
    const opts = {
      policy: pol.value,
      scanner: scn.value,
      regexPatterns: rx.value,
      entropyThreshold: ent.value,
      allowlistedPatterns,
      seededCompleted: completedIds,
      resumedFromRunId: runId,
    };
    if (md.value === 'live') {
      const run = await startLiveRun(wf, w.value, { ...opts, speed });
      return json(toSummary(run), 201);
    }
    const result = simulateRun(wf, w.value, opts);
    const run = await saveRun({ ...result, id: randomUUID(), createdAt: new Date().toISOString() });
    return json(toSummary(run), 201);
  } catch (e) {
    if (e instanceof CycleError) {
      return json(
        { error: 'CIRCULAR_DEPENDENCY', message: e.message, cycle: e.cycle, errors: [e.message] },
        409,
      );
    }
    if (e instanceof GraphError) return badRequest([e.message]);
    throw e;
  }
}
