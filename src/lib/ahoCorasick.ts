/**
 * Streaming byte-level Aho-Corasick multi-pattern automaton, O(N + Z) scan time.
 *
 * Unlike running k independent KMP scanners (O(k * N)), Aho-Corasick compiles all patterns
 * into a single deterministic byte automaton (trie + failure links + dictionary output links).
 * Each input byte triggers exactly one transition lookup regardless of pattern count, and
 * patterns straddling chunk boundaries are matched seamlessly without buffering the input.
 */

export interface ACMatch {
  patternIndex: number;
  pattern: string;
  byteOffset: number;
}

export class AhoCorasickScanner {
  readonly patterns: readonly string[];
  readonly patternLengths: Int32Array;
  private readonly trans: Int32Array; // state * 256 + byte -> nextState
  private readonly outputs: number[][]; // pattern indices ending at each state (including via dict suffix links)
  private state = 0;
  private offset = 0;
  /** Number of byte transitions evaluated (1 per input byte). */
  comparisons = 0;

  constructor(patterns: readonly string[]) {
    if (patterns.length === 0) throw new Error('At least one pattern is required');
    this.patterns = [...patterns];
    const patBytes = patterns.map((p) => {
      const b = Buffer.from(p, 'utf8');
      if (b.length === 0) throw new Error('Pattern must not be empty');
      return b;
    });
    this.patternLengths = Int32Array.from(patBytes, (b) => b.length);

    // Phase 1: build the keyword trie.
    const maxStates = patBytes.reduce((sum, b) => sum + b.length, 1);
    const go = new Int32Array(maxStates * 256).fill(-1);
    const fail = new Int32Array(maxStates).fill(0);
    const directOut: number[][] = Array.from({ length: maxStates }, () => []);
    let stateCount = 1;

    for (let pi = 0; pi < patBytes.length; pi++) {
      const b = patBytes[pi];
      let cur = 0;
      for (let i = 0; i < b.length; i++) {
        const c = b[i];
        const idx = (cur << 8) | c;
        let nxt = go[idx];
        if (nxt === -1) {
          nxt = stateCount++;
          go[idx] = nxt;
        }
        cur = nxt;
      }
      directOut[cur].push(pi);
    }

    // Phase 2: BFS to compute failure links and complete the DFA transition table.
    const queue = new Int32Array(stateCount);
    let head = 0;
    let tail = 0;

    for (let c = 0; c < 256; c++) {
      const nxt = go[c];
      if (nxt !== -1) {
        fail[nxt] = 0;
        queue[tail++] = nxt;
      } else {
        go[c] = 0;
      }
    }

    const outputs: number[][] = Array.from({ length: stateCount }, () => []);
    while (head < tail) {
      const u = queue[head++];
      // Materialize all outputs reachable via failure links so scan-time output is direct.
      const merged = directOut[u].length > 0 || outputs[fail[u]].length > 0
        ? [...directOut[u], ...outputs[fail[u]]]
        : [];
      outputs[u] = merged;

      const baseU = u << 8;
      const baseF = fail[u] << 8;
      for (let c = 0; c < 256; c++) {
        const v = go[baseU | c];
        if (v !== -1) {
          fail[v] = go[baseF | c];
          queue[tail++] = v;
        } else {
          go[baseU | c] = go[baseF | c];
        }
      }
    }

    this.trans = go.subarray(0, stateCount * 256);
    this.outputs = outputs;
  }

  /** Reset stream cursor for reuse on another byte stream (keeps compiled automaton). */
  reset(): void {
    this.state = 0;
    this.offset = 0;
    this.comparisons = 0;
  }

  /** Feed the next chunk of raw UTF-8 bytes; returns all matches completed in this chunk. */
  feed(chunk: Uint8Array): ACMatch[] {
    const hits: ACMatch[] = [];
    const { trans, outputs, patterns, patternLengths } = this;
    let s = this.state;
    const baseOffset = this.offset;

    for (let i = 0; i < chunk.length; i++) {
      s = trans[(s << 8) | chunk[i]];
      const out = outputs[s];
      if (out.length > 0) {
        const endPos = baseOffset + i + 1;
        for (let j = 0; j < out.length; j++) {
          const pi = out[j];
          hits.push({
            patternIndex: pi,
            pattern: patterns[pi],
            byteOffset: endPos - patternLengths[pi],
          });
        }
      }
    }

    this.state = s;
    this.offset = baseOffset + chunk.length;
    this.comparisons += chunk.length;
    return hits;
  }
}

export interface MultiSearchResult {
  matches: ACMatch[];
  comparisons: number;
}

/** Convenience: scan a full buffer in chunks using Aho-Corasick. */
export function ahoCorasickFindAll(
  text: Uint8Array,
  patterns: readonly string[],
  chunkBytes = 0,
): MultiSearchResult {
  const scanner = new AhoCorasickScanner(patterns);
  const matches: ACMatch[] = [];
  if (chunkBytes > 0) {
    for (let pos = 0; pos < text.length; pos += chunkBytes) {
      matches.push(...scanner.feed(text.subarray(pos, pos + chunkBytes)));
    }
  } else {
    matches.push(...scanner.feed(text));
  }
  return { matches, comparisons: scanner.comparisons };
}
