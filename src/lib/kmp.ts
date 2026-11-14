/**
 * Knuth-Morris-Pratt string matching over raw bytes.
 *
 * Working on bytes (not decoded strings) keeps the scanner correct when a multi-byte UTF-8
 * character is split across two stream chunks. The only state carried between chunks is the
 * integer `j` (length of the currently matched pattern prefix), so a match that straddles a
 * chunk boundary is still found and the text is never rewound or buffered.
 */

/** Longest-proper-prefix-which-is-also-suffix table. O(M). */
export function buildLPS(p: Uint8Array): Int32Array {
  const lps = new Int32Array(p.length);
  for (let i = 1, k = 0; i < p.length; ) {
    if (p[i] === p[k]) {
      lps[i++] = ++k;
    } else if (k > 0) {
      k = lps[k - 1];
    } else {
      lps[i++] = 0;
    }
  }
  return lps;
}

export class KMPScanner {
  readonly pattern: string;
  readonly length: number;
  private readonly p: Buffer;
  private readonly lps: Int32Array;
  private j = 0;
  private offset = 0;
  /** Number of text-byte vs pattern-byte comparisons performed (for the benchmark). */
  comparisons = 0;

  constructor(pattern: string) {
    this.p = Buffer.from(pattern, 'utf8');
    if (this.p.length === 0) throw new Error('Pattern must not be empty');
    this.pattern = pattern;
    this.length = this.p.length;
    this.lps = buildLPS(this.p);
  }

  /** Forget stream state (keeps the LPS table so it can be reused for another stream). */
  reset(): void {
    this.j = 0;
    this.offset = 0;
    this.comparisons = 0;
  }

  /** Feed the next chunk. Returns absolute start offsets (in bytes) of matches completed in it. Overlaps are reported. */
  feed(chunk: Uint8Array): number[] {
    const hits: number[] = [];
    const { p, lps, length } = this;
    for (let i = 0; i < chunk.length; i++) {
      for (;;) {
        this.comparisons++;
        if (chunk[i] === p[this.j]) {
          this.j++;
          break;
        }
        if (this.j === 0) break;
        this.j = lps[this.j - 1];
      }
      if (this.j === length) {
        hits.push(this.offset + i - length + 1);
        this.j = lps[this.j - 1];
      }
    }
    this.offset += chunk.length;
    return hits;
  }
}

export interface SearchResult {
  offsets: number[];
  comparisons: number;
}

/** Convenience: scan a whole buffer, optionally in chunks, with KMP. */
export function kmpFindAll(text: Uint8Array, pattern: string, chunkBytes = 0): SearchResult {
  const s = new KMPScanner(pattern);
  const offsets: number[] = [];
  if (chunkBytes > 0) {
    for (let pos = 0; pos < text.length; pos += chunkBytes) {
      offsets.push(...s.feed(text.subarray(pos, pos + chunkBytes)));
    }
  } else {
    offsets.push(...s.feed(text));
  }
  return { offsets, comparisons: s.comparisons };
}

/** Baseline naive search (restarts the comparison for every text position). O(N*M) worst case. */
export function naiveFindAll(text: Uint8Array, pattern: string): SearchResult {
  const p = Buffer.from(pattern, 'utf8');
  if (p.length === 0) throw new Error('Pattern must not be empty');
  const offsets: number[] = [];
  let comparisons = 0;
  for (let i = 0; i + p.length <= text.length; i++) {
    let k = 0;
    while (k < p.length) {
      comparisons++;
      if (text[i + k] !== p[k]) break;
      k++;
    }
    if (k === p.length) offsets.push(i);
  }
  return { offsets, comparisons };
}

/** Maps byte offsets to 1-based line/column numbers in O(N) preprocessing + O(log L) per lookup. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(private readonly bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) this.starts.push(i + 1);
  }
  locate(offset: number): { line: number; column: number; lineStart: number; lineEnd: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = this.starts[lo];
    const next = lo + 1 < this.starts.length ? this.starts[lo + 1] - 1 : this.bytes.length;
    return { line: lo + 1, column: offset - lineStart + 1, lineStart, lineEnd: next };
  }
}
