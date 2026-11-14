import { describe, expect, it } from 'vitest';
import { KMPScanner, LineIndex, buildLPS, kmpFindAll, naiveFindAll } from '@/lib/kmp';

const rndInt = (n: number) => Math.floor(Math.random() * n);

describe('buildLPS', () => {
  it('matches the textbook example', () => {
    expect(Array.from(buildLPS(Buffer.from('ABCDABD')))).toEqual([0, 0, 0, 0, 1, 2, 0]);
    expect(Array.from(buildLPS(Buffer.from('AAAA')))).toEqual([0, 1, 2, 3]);
  });
});

describe('KMPScanner', () => {
  it('equals naive search on random data split at random chunk boundaries (overlaps included)', () => {
    for (let round = 0; round < 2000; round++) {
      const text = Buffer.from(Array.from({ length: 200 }, () => 97 + rndInt(2)));
      const pattern = Array.from({ length: 1 + rndInt(5) }, () => String.fromCharCode(97 + rndInt(2))).join('');
      const s = new KMPScanner(pattern);
      const got: number[] = [];
      for (let i = 0; i < text.length; ) {
        const c = 1 + rndInt(17);
        got.push(...s.feed(text.subarray(i, i + c)));
        i += c;
      }
      expect(got).toEqual(naiveFindAll(text, pattern).offsets);
    }
  });

  it('finds a match that straddles a chunk boundary using only carried state', () => {
    const s = new KMPScanner('UNAUTHORIZED');
    expect(s.feed(Buffer.from('xxxxUNAUTH'))).toEqual([]);
    expect(s.feed(Buffer.from('ORIZEDyyy'))).toEqual([4]);
  });

  it('reports overlapping matches', () => {
    expect(kmpFindAll(Buffer.from('aaaa'), 'aa').offsets).toEqual([0, 1, 2]);
  });

  it('handles multi-byte UTF-8 patterns split mid-character', () => {
    const buf = Buffer.from('xx h\u00e9llo yy');
    const s = new KMPScanner('h\u00e9llo');
    const cut = buf.indexOf(0xc3) + 1; // split between the two bytes of the e-acute
    expect([...s.feed(buf.subarray(0, cut)), ...s.feed(buf.subarray(cut))]).toEqual([3]);
  });

  it('rejects an empty pattern', () => {
    expect(() => new KMPScanner('')).toThrow();
  });

  it('reset() lets one scanner be reused for a fresh stream', () => {
    const s = new KMPScanner('ab');
    s.feed(Buffer.from('xxa'));
    s.reset();
    expect(s.feed(Buffer.from('b'))).toEqual([]);
  });

  it('never rewinds: comparisons are at most 2N even on the adversarial input', () => {
    const n = 100_000;
    const text = Buffer.from('Z'.repeat(n));
    const pattern = 'Z'.repeat(63) + 'A';
    const k = kmpFindAll(text, pattern, 4096);
    const nv = naiveFindAll(text, pattern);
    expect(k.offsets).toEqual([]);
    expect(k.comparisons).toBeLessThanOrEqual(2 * n);
    expect(nv.comparisons).toBeGreaterThan(50 * n); // ~ (n-m+1)*m
  });
});

describe('LineIndex', () => {
  it('maps offsets to 1-based line and column', () => {
    const li = new LineIndex(Buffer.from('ab\ncde\n\nf'));
    expect(li.locate(0)).toMatchObject({ line: 1, column: 1 });
    expect(li.locate(4)).toMatchObject({ line: 2, column: 2 });
    expect(li.locate(8)).toMatchObject({ line: 4, column: 1 });
  });
});
