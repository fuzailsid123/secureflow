import { generateSyntheticWorkflow, type DagShape } from '@/lib/generator';
import { badRequest, json, readJson, requireApiKey } from '@/lib/http';
import { parseWorkflowImport } from '@/lib/import';
import { sampleWorkflowInput } from '@/lib/sample';
import { createWorkflow, listWorkflows } from '@/lib/store';
import { validateWorkflowInput } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const SHAPES = new Set<DagShape>(['layered', 'diamond', 'chain', 'random-dag', 'multi-cycle']);

export async function GET() {
  return json(await listWorkflows());
}

export async function POST(req: Request) {
  const denied = requireApiKey(req);
  if (denied) return denied;

  const body = await readJson(req);
  if (body === undefined) return badRequest(['Body must be valid JSON']);

  if (typeof body === 'object' && body !== null) {
    const rec = body as Record<string, unknown>;
    if (rec.sample === true) {
      return json(await createWorkflow(sampleWorkflowInput()), 201);
    }
    if (typeof rec.importText === 'string') {
      const imp = parseWorkflowImport(rec.importText);
      if (!imp.ok) return badRequest(imp.errors);
      return json(await createWorkflow(imp.value), 201);
    }
    if (typeof rec.generate === 'object' && rec.generate !== null) {
      const g = rec.generate as Record<string, unknown>;
      const shape = typeof g.shape === 'string' && SHAPES.has(g.shape as DagShape) ? (g.shape as DagShape) : null;
      if (!shape) return badRequest(['generate.shape must be layered, diamond, chain, random-dag, or multi-cycle']);
      const taskCount = typeof g.taskCount === 'number' && Number.isFinite(g.taskCount) ? g.taskCount : 16;
      const seed = typeof g.seed === 'number' && Number.isFinite(g.seed) ? g.seed : undefined;
      const injectLeak = g.injectLeak === true;
      const wfInput = generateSyntheticWorkflow({ shape, taskCount, seed, injectLeak });
      const vGen = validateWorkflowInput(wfInput);
      if (!vGen.ok) return badRequest(vGen.errors);
      return json(await createWorkflow(vGen.value), 201);
    }
  }

  const withDefaults =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? { name: 'Untitled workflow', tasks: [], edges: [], patterns: [], ...body }
      : body;
  const v = validateWorkflowInput(withDefaults);
  if (!v.ok) return badRequest(v.errors);
  return json(await createWorkflow(v.value), 201);
}
