import { describe, expect, it } from 'vitest';
import { ahoCorasickFindAll, AhoCorasickScanner } from '@/lib/ahoCorasick';
import { naiveFindAll } from '@/lib/kmp';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('AhoCorasickScanner', () => {
  it('matches all overlapping and nested suffix patterns across arbitrary chunk boundaries', () => {
    const patterns = ['ab', 'bc', 'abc', 'c', 'aa'];
    const text = Buffer.from('aaabcabc', 'utf8');
    const ac1 = ahoCorasickFindAll(text, patterns, 1); // 1-byte chunks
    const acWhole = ahoCorasickFindAll(text, patterns, 0);

    const expected: Array<{ pattern: string; byteOffset: number }> = [];
    for (const p of patterns) {
      const nv = naiveFindAll(text, p);
      for (const off of nv.offsets) expected.push({ pattern: p, byteOffset: off });
    }
    const sortMatches = (arr: Array<{ pattern: string; byteOffset: number }>) =>
      [...arr].sort((a, b) => a.byteOffset - b.byteOffset || a.pattern.localeCompare(b.pattern));

    expect(sortMatches(ac1.matches.map(({ pattern, byteOffset }) => ({ pattern, byteOffset })))).toEqual(
      sortMatches(expected),
    );
    expect(sortMatches(acWhole.matches.map(({ pattern, byteOffset }) => ({ pattern, byteOffset })))).toEqual(
      sortMatches(expected),
    );
  });

  it('matches multi-byte UTF-8 patterns split across chunk boundaries', () => {
    const text = Buffer.from('prefix-🔑SECRET_KEY-suffix-🚀', 'utf8');
    const patterns = ['🔑SECRET', 'SECRET_KEY', '🚀'];
    for (const chunkSize of [1, 2, 3, 5, 7]) {
      const res = ahoCorasickFindAll(text, patterns, chunkSize);
      expect(res.matches.map((m) => m.pattern).sort()).toEqual(['SECRET_KEY', '🔑SECRET', '🚀']);
    }
  });

  it('agrees with naive search across 500 fuzzed multi-pattern inputs and stays O(N)', () => {
    const rnd = mulberry32(2026);
    const alpha = ['a', 'b', 'c'];
    const sortMatches = (arr: Array<{ pattern: string; byteOffset: number }>) =>
      [...arr].sort((a, b) => a.byteOffset - b.byteOffset || a.pattern.localeCompare(b.pattern));

    for (let trial = 0; trial < 500; trial++) {
      const len = 20 + Math.floor(rnd() * 140);
      const textStr = Array.from({ length: len }, () => alpha[Math.floor(rnd() * alpha.length)]).join('');
      const patCount = 1 + Math.floor(rnd() * 6);
      const patSet = new Set<string>();
      for (let k = 0; k < patCount; k++) {
        const plen = 1 + Math.floor(rnd() * 6);
        patSet.add(Array.from({ length: plen }, () => alpha[Math.floor(rnd() * alpha.length)]).join(''));
      }
      const patterns = [...patSet];
      const bytes = Buffer.from(textStr, 'utf8');
      const chunkBytes = 1 + Math.floor(rnd() * 17);

      const ac = ahoCorasickFindAll(bytes, patterns, chunkBytes);
      expect(ac.comparisons).toBe(bytes.length);

      const expected: Array<{ pattern: string; byteOffset: number }> = [];
      for (const p of patterns) {
        for (const off of naiveFindAll(bytes, p).offsets) {
          expected.push({ pattern: p, byteOffset: off });
        }
      }
      expect(sortMatches(ac.matches.map(({ pattern, byteOffset }) => ({ pattern, byteOffset })))).toEqual(
        sortMatches(expected),
      );
    }
  });

  it('can be reset and reused without recompiling the automaton', () => {
    const s = new AhoCorasickScanner(['ERR', 'WARN']);
    expect(s.feed(Buffer.from('ERR1')).length).toBe(1);
    s.reset();
    expect(s.comparisons).toBe(0);
    const second = s.feed(Buffer.from('WARN2'));
    expect(second).toEqual([{ patternIndex: 1, pattern: 'WARN', byteOffset: 0 }]);
  });
});
