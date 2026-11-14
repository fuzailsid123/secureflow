import { json, notFound, requireApiKey } from '@/lib/http';
import { cancelLiveRun } from '@/lib/runner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireApiKey(req);
  if (denied) return denied;

  const { id } = await params;
  const ok = await cancelLiveRun(id);
  if (!ok) return notFound('Active run');
  return json({ cancelled: true, id });
}
