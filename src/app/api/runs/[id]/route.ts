import { json, notFound } from '@/lib/http';
import { getActiveLiveRun } from '@/lib/runner';
import { getRun } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getActiveLiveRun(id) ?? (await getRun(id));
  return run ? json(run) : notFound('Run');
}
