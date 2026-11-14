import { json } from '@/lib/http';
import { runBenchmark } from '@/lib/benchmark';

export const dynamic = 'force-dynamic';

/** Runs the reproducible KMP-vs-naive and scheduling benchmarks (CPU-bound, takes about a second). */
export async function POST() {
  return json(runBenchmark());
}
