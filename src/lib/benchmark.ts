import { ahoCorasickFindAll } from './ahoCorasick';
import { kmpFindAll, naiveFindAll } from './kmp';
import { schedule } from './topo';

export interface SearchRow {
  n: number;
  kmpComparisons: number;
  naiveComparisons: number;
  kmpMs: number;
  naiveMs: number;
}
export interface MultiPatternRow {
  k: number;
  n: number;
  acComparisons: number;
  kmpComparisons: number;
  naiveComparisons: number;
  acMs: number;
  kmpMs: number;
  naiveMs: number;
}
export interface ScheduleRow {
  v: number;
  e: number;
  ms: number;
}
export interface BenchmarkResult {
  adversarial: SearchRow[];
  random: SearchRow[];
  multiPattern: MultiPatternRow[];
  scheduling: ScheduleRow[];
  patternLength: number;
}

/** Deterministic PRNG so benchmark inputs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function time<T>(fn: () => T): { out: T; ms: number } {
  const s = performance.now();
  const out = fn();
  return { out, ms: performance.now() - s };
}

function row(text: Buffer, pattern: string): SearchRow {
  const k = time(() => kmpFindAll(text, pattern, 4096));
  const nv = time(() => naiveFindAll(text, pattern));
  if (k.out.offsets.length !== nv.out.offsets.length) throw new Error('benchmark: KMP and naive disagree');
  return {
    n: text.length,
    kmpComparisons: k.out.comparisons,
    naiveComparisons: nv.out.comparisons,
    kmpMs: k.ms,
    naiveMs: nv.ms,
  };
}

export function runBenchmark(): BenchmarkResult {
  const m = 64;
  const sizes = [20_000, 40_000, 80_000, 160_000, 320_000];

  // Worst case for naive search: long runs of 'Z' and a pattern of 'Z'*(m-1) + 'A'.
  const advPattern = 'Z'.repeat(m - 1) + 'A';
  const adversarial = sizes.map((n) => row(Buffer.from('Z'.repeat(n)), advPattern));

  // Typical case: random 4-letter text, random pattern. Naive is competitive here (honest comparison).
  const rnd = mulberry32(42);
  const letters = 'ACGT';
  const randText = (n: number) => Buffer.from(Array.from({ length: n }, () => letters[Math.floor(rnd() * 4)]).join(''));
  const randPattern = Array.from({ length: m }, () => letters[Math.floor(rnd() * 4)]).join('');
  const random = sizes.map((n) => row(randText(n), randPattern));

  // Scheduling: random DAG with E ~ 4V (edges always go from lower to higher index, so it is acyclic).
  const scheduling: ScheduleRow[] = [];
  for (const v of [500, 1000, 2000, 5000]) {
    const ids = Array.from({ length: v }, (_, i) => `t${i}`);
    const edges: [string, string][] = [];
    for (let i = 0; i < 4 * v; i++) {
      const u = Math.floor(rnd() * (v - 1));
      const w = u + 1 + Math.floor(rnd() * (v - 1 - u));
      edges.push([ids[u], ids[w]]);
    }
    const samples: number[] = [];
    let distinct = 0;
    for (let r = 0; r < 5; r++) {
      const res = time(() => schedule(ids, edges));
      if (!res.out.ok) throw new Error('benchmark: generated DAG has a cycle');
      distinct = res.out.graph.edgeCount;
      samples.push(res.ms);
    }
    samples.sort((a, b) => a - b);
    scheduling.push({ v, e: distinct, ms: samples[2] });
  }

  // Multi-pattern comparison: Aho-Corasick O(N + Z) vs k*KMP O(k*N) vs k*Naive across k = 1, 5, 10, 20.
  const multiN = 120_000;
  const multiText = randText(multiN);
  const patternPool = Array.from({ length: 20 }, () =>
    Array.from({ length: 16 }, () => letters[Math.floor(rnd() * 4)]).join(''),
  );
  const multiPattern: MultiPatternRow[] = [1, 5, 10, 20].map((k) => {
    const pats = patternPool.slice(0, k);
    const ac = time(() => ahoCorasickFindAll(multiText, pats, 4096));
    let kmpComparisons = 0;
    let naiveComparisons = 0;
    const kmp = time(() => {
      let matches = 0;
      for (const p of pats) {
        const res = kmpFindAll(multiText, p, 4096);
        kmpComparisons += res.comparisons;
        matches += res.offsets.length;
      }
      return matches;
    });
    const nv = time(() => {
      let matches = 0;
      for (const p of pats) {
        const res = naiveFindAll(multiText, p);
        naiveComparisons += res.comparisons;
        matches += res.offsets.length;
      }
      return matches;
    });
    if (ac.out.matches.length !== kmp.out || kmp.out !== nv.out) {
      throw new Error('benchmark: Aho-Corasick, KMP, and naive disagree');
    }
    return {
      k,
      n: multiN,
      acComparisons: ac.out.comparisons,
      kmpComparisons,
      naiveComparisons,
      acMs: ac.ms,
      kmpMs: kmp.ms,
      naiveMs: nv.ms,
    };
  });

  return { adversarial, random, multiPattern, scheduling, patternLength: m };
}
