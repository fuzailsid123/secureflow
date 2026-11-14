import { describe, expect, it } from 'vitest';
import { nfaFindAll, RegexCompileError, scanEntropy } from '@/lib/nfa';

describe('Thompson NFA regex scanner', () => {
  it('matches secrets across arbitrary chunk boundaries', () => {
    const text = Buffer.from('log line 1 AKIAIOSFODNN7EXAMPLE ok\nnext token=abc_123.XYZ end', 'utf8');
    const pat = 'AKIA[0-9A-Z]{16}';
    const whole = nfaFindAll(text, pat, 0);
    const chunked = nfaFindAll(text, pat, 3);
    expect(whole.length).toBe(1);
    expect(chunked).toEqual(whole);
    expect(text.subarray(whole[0].start, whole[0].end).toString('utf8')).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('handles alternation, grouping, and non-overlapping leftmost-longest matches', () => {
    const text = Buffer.from('foo bar foobar aab', 'utf8');
    const matches = nfaFindAll(text, '(foo|bar)+', 2);
    expect(matches.map((m) => text.subarray(m.start, m.end).toString('utf8'))).toEqual(['foo', 'bar', 'foobar']);
  });

  it('runs in linear time without ReDoS on pathological (a+)+b input', () => {
    const evil = Buffer.from('a'.repeat(40) + 'c', 'utf8');
    const t0 = performance.now();
    const matches = nfaFindAll(evil, '(a+)+b', 4);
    const elapsed = performance.now() - t0;
    expect(matches).toEqual([]);
    expect(elapsed).toBeLessThan(100);
  });

  it('rejects malformed or unsupported regex syntax cleanly', () => {
    expect(() => nfaFindAll(Buffer.from('abc'), '')).toThrow(RegexCompileError);
    expect(() => nfaFindAll(Buffer.from('abc'), '(abc')).toThrow(RegexCompileError);
    expect(() => nfaFindAll(Buffer.from('abc'), '*abc')).toThrow(RegexCompileError);
    expect(() => nfaFindAll(Buffer.from('abc'), '(?=abc)')).toThrow(RegexCompileError);
  });
});

describe('Shannon entropy detector', () => {
  it('flags high-entropy secret tokens while ignoring ordinary log lines', () => {
    const log = Buffer.from(
      'INFO starting server on port 8080\nDEBUG secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nINFO done\n',
      'utf8',
    );
    const hits = scanEntropy(log, 4.3, 20);
    expect(hits.length).toBe(1);
    expect(hits[0].token).toContain('wJalrXUtnFEMI');
    expect(hits[0].entropy).toBeGreaterThanOrEqual(4.3);
  });
});
