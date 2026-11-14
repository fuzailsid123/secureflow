import { badRequest, json, notFound, readJson, requireApiKey } from '@/lib/http';
import { deleteWorkflow, getWorkflow, updateWorkflow } from '@/lib/store';
import { validateWorkflowInput } from '@/lib/validate';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const w = await getWorkflow((await params).id);
  return w ? json(w) : notFound('Workflow');
}

export async function PUT(req: Request, { params }: Ctx) {
  const denied = requireApiKey(req);
  if (denied) return denied;
  const { id } = await params;
  const body = await readJson(req);
  if (body === undefined) return badRequest(['Body must be valid JSON']);
  const v = validateWorkflowInput(body);
  if (!v.ok) return badRequest(v.errors);
  const w = await updateWorkflow(id, v.value);
  return w ? json(w) : notFound('Workflow');
}

export async function DELETE(req: Request, { params }: Ctx) {
  const denied = requireApiKey(req);
  if (denied) return denied;
  const ok = await deleteWorkflow((await params).id);
  return ok ? json({ deleted: true }) : notFound('Workflow');
}
