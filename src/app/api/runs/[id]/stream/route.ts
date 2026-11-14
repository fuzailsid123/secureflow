import { notFound } from '@/lib/http';
import { subscribeLiveRun } from '@/lib/runner';
import { getRun } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Server-Sent Events stream for a run.
 * - If the run is actively executing via `LiveRunManager`, streams backlog + real-time events.
 * - Otherwise, replays the stored run timeline paced by `?speed=` (or `instant`).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const enc = new TextEncoder();

  // Check active live run first.
  let unsub: (() => void) | null = null;
  let cancelled = false;
  const live = subscribeLiveRun(
    id,
    () => {
      /* placeholder, replaced inside stream start */
    },
    () => {
      /* placeholder */
    },
  );
  if (live) {
    live.unsubscribe();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (s: string) => {
          if (cancelled) return;
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            /* closed */
          }
        };
        const close = () => {
          if (cancelled) return;
          send('event: end\ndata: {}\n\n');
          cancelled = true;
          unsub?.();
          try {
            controller.close();
          } catch {
            /* closed */
          }
        };

        send(': stream open\n\n');
        let sentCount = 0;
        const sub = subscribeLiveRun(
          id,
          (ev) => {
            send(`data: ${JSON.stringify(ev)}\n\n`);
          },
          close,
        );
        if (!sub) {
          close();
          return;
        }
        unsub = sub.unsubscribe;
        for (const ev of sub.backlog) {
          send(`data: ${JSON.stringify(ev)}\n\n`);
          sentCount++;
        }
        void sentCount;
        req.signal.addEventListener('abort', () => {
          cancelled = true;
          unsub?.();
        });
      },
      cancel() {
        cancelled = true;
        unsub?.();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const run = await getRun(id);
  if (!run) return notFound('Run');

  const raw = new URL(req.url).searchParams.get('speed') ?? '1';
  const instant = raw === 'instant';
  const speed = instant ? Infinity : Math.min(10000, Math.max(0.1, Number(raw) || 1));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      try {
        send(': stream open\n\n');
        let prev = 0;
        for (const ev of run.events) {
          if (cancelled || req.signal.aborted) return;
          if (!instant) {
            const wait = Math.min((ev.t - prev) / speed, 2000);
            if (wait >= 1) await sleep(wait);
          }
          prev = ev.t;
          send(`data: ${JSON.stringify(ev)}\n\n`);
        }
        send('event: end\ndata: {}\n\n');
        controller.close();
      } catch {
        /* client disconnected */
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
