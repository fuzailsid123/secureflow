import { badRequest, json, readJson } from '@/lib/http';
import { LIMITS } from '@/lib/limits';
import { analyzeCycles, bottomLevels } from '@/lib/scc';
import { buildGraph, criticalPath, GraphError, topoSort } from '@/lib/topo';
import type { ScheduleResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Stateless validation: given task ids (+ optional durations) and edges, return levels or the exact cycle. */
export async function POST(req: Request) {
  const body = (await readJson(req)) as { tasks?: unknown; edges?: unknown } | undefined;
  if (!body || !Array.isArray(body.tasks) || !Array.isArray(body.edges)) {
    return badRequest(['Body must be { tasks: [{ id, durationMs? }], edges: [[from, to]] }']);
  }
  if (body.tasks.length > LIMITS.maxTasks) return badRequest([`at most ${LIMITS.maxTasks} tasks are allowed`]);
  if (body.edges.length > LIMITS.maxEdges) return badRequest([`at most ${LIMITS.maxEdges} dependencies are allowed`]);

  const ids: string[] = [];
  const durations: number[] = [];
  for (const t of body.tasks) {
    const id = (t as { id?: unknown })?.id;
    if (typeof id !== 'string') return badRequest(['every task needs a string id']);
    ids.push(id);
    const d = (t as { durationMs?: unknown }).durationMs;
    durations.push(typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : 0);
  }
  const edges: [string, string][] = [];
  for (const e of body.edges) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || typeof e[1] !== 'string') {
      return badRequest(['every edge must be a [from, to] pair of task ids']);
    }
    edges.push([e[0], e[1]]);
  }

  try {
    const t0 = performance.now();
    const g = buildGraph(ids, edges);
    const r = topoSort(g);
    const scheduleMs = performance.now() - t0;
    let out: ScheduleResponse;
    if (!r.ok) {
      const scc = analyzeCycles(g);
      out = {
        ok: false,
        cycle: r.cycle.map((i) => ids[i]),
        scheduleMs,
        sccs: scc.cyclicSccs,
        suggestedBreaks: scc.suggestedBreaks,
      };
    } else {
      const flat = r.levels.flat();
      const cp = criticalPath(g, flat, durations);
      const bl = bottomLevels(g, flat, durations);
      const bottomLevelMap: Record<string, number> = {};
      for (let i = 0; i < ids.length; i++) bottomLevelMap[ids[i]] = bl[i];
      out = {
        ok: true,
        levels: r.levels.map((lv) => lv.map((i) => ids[i])),
        order: flat.map((i) => ids[i]),
        scheduleMs,
        criticalPath: { path: cp.path.map((i) => ids[i]), lengthMs: cp.lengthMs },
        bottomLevels: bottomLevelMap,
      };
    }
    return json(out);
  } catch (e) {
    if (e instanceof GraphError) return badRequest([e.message]);
    throw e;
  }
}
