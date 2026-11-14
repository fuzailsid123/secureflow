import { randomUUID } from 'node:crypto';
import { badRequest, json, notFound, readJson, requireApiKey } from '@/lib/http';
import { startLiveRun } from '@/lib/runner';
import { CycleError, simulateRun } from '@/lib/simulate';
import { getWorkflow, listRuns, saveRun, toSummary } from '@/lib/store';
import { analyzeCycles } from '@/lib/scc';
import { buildGraph, GraphError } from '@/lib/topo';
import {
  validateEntropyThreshold,
  validateRegexList,
  validateRunMode,
  validateScannerMode,
  validateSchedulePolicy,
  validateWorkers,
} from '@/lib/validate';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!(await getWorkflow(id))) return notFound('Workflow');
  return json(await listRuns(id));
}

/** Executes the workflow simulation (or starts an async live run) and returns the run summary. */
export async function POST(req: Request, { params }: Ctx) {
  const denied = requireApiKey(req);
  if (denied) return denied;

  const { id } = await params;
  const wf = await getWorkflow(id);
  if (!wf) return notFound('Workflow');

  const body = (await readJson(req)) as Record<string, unknown> | undefined;
  const obj = typeof body === 'object' && body !== null ? body : {};

  const rawWorkers = 'workers' in obj ? obj.workers : 3;
  const w = validateWorkers(rawWorkers);
  if (!w.ok) return badRequest(w.errors);
  if (wf.tasks.length === 0) return badRequest(['Workflow has no tasks']);

  const pol = validateSchedulePolicy(obj.policy);
  if (!pol.ok) return badRequest(pol.errors);
  const scn = validateScannerMode(obj.scanner);
  if (!scn.ok) return badRequest(scn.errors);
  const md = validateRunMode(obj.mode);
  if (!md.ok) return badRequest(md.errors);
  const rx = validateRegexList(obj.regexPatterns);
  if (!rx.ok) return badRequest(rx.errors);
  const ent = validateEntropyThreshold(obj.entropyThreshold);
  if (!ent.ok) return badRequest(ent.errors);

  const speed = typeof obj.speed === 'number' && Number.isFinite(obj.speed) ? obj.speed : 4;

  try {
    const opts = {
      policy: pol.value,
      scanner: scn.value,
      regexPatterns: rx.value,
      entropyThreshold: ent.value,
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
      const g = buildGraph(
        wf.tasks.map((t) => t.id),
        wf.edges,
      );
      const scc = analyzeCycles(g);
      return json(
        {
          error: 'CIRCULAR_DEPENDENCY',
          message: e.message,
          cycle: e.cycle,
          sccs: scc.cyclicSccs,
          suggestedBreaks: scc.suggestedBreaks,
          errors: [e.message],
        },
        409,
      );
    }
    if (e instanceof GraphError) return badRequest([e.message]);
    throw e;
  }
}
