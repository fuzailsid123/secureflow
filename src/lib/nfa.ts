/**
 * Linear-time Thompson NFA regular-expression scanner and Shannon entropy secret detector.
 *
 * Unlike backtracking regex engines (which can suffer exponential ReDoS on patterns like
 * `(a+)+b`), Thompson NFA simulation maintains a deduplicated active-state set per input byte,
 * guaranteeing O(N * M) worst-case scan time across arbitrary chunk boundaries.
 */

export class RegexCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegexCompileError';
  }
}

export interface NFAMatch {
  pattern: string;
  start: number;
  end: number;
}

export interface EntropyFinding {
  start: number;
  end: number;
  entropy: number;
  token: string;
}

export interface SnippetContext {
  before: string;
  match: string;
  after: string;
}

type BytePredicate = (b: number) => boolean;

interface NFAState {
  eps: number[];
  onByte?: BytePredicate;
  next?: number;
  isAccept?: boolean;
}

interface Fragment {
  start: number;
  accept: number;
}

const MAX_NFA_STATES = 2048;
const MAX_REPEAT_EXPAND = 64;

function makeClassPredicate(ranges: Array<[number, number]>, negated: boolean): BytePredicate {
  const table = new Uint8Array(256);
  for (const [lo, hi] of ranges) {
    for (let b = lo; b <= hi; b++) table[b] = 1;
  }
  if (negated) {
    for (let b = 0; b < 256; b++) table[b] = table[b] ? 0 : 1;
  }
  return (b: number) => table[b] === 1;
}

function escapeRanges(ch: string): Array<[number, number]> | null {
  switch (ch) {
    case 'd':
      return [[0x30, 0x39]];
    case 'D':
      return [[0x00, 0x2f], [0x3a, 0xff]];
    case 'w':
      return [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
    case 'W':
      return [[0x00, 0x2f], [0x3a, 0x40], [0x5b, 0x5e], [0x60, 0x60], [0x7b, 0xff]];
    case 's':
      return [[0x09, 0x0d], [0x20, 0x20]];
    case 'S':
      return [[0x00, 0x08], [0x0e, 0x1f], [0x21, 0xff]];
    case 'n':
      return [[0x0a, 0x0a]];
    case 'r':
      return [[0x0d, 0x0d]];
    case 't':
      return [[0x09, 0x09]];
    default:
      return null;
  }
}

class NFABuilder {
  readonly states: NFAState[] = [];

  newState(init: Partial<NFAState> = {}): number {
    if (this.states.length >= MAX_NFA_STATES) {
      throw new RegexCompileError(`Regex expands beyond ${MAX_NFA_STATES} NFA states`);
    }
    const id = this.states.length;
    this.states.push({ eps: [], ...init });
    return id;
  }

  atom(pred: BytePredicate): Fragment {
    const start = this.newState();
    const accept = this.newState();
    this.states[start].onByte = pred;
    this.states[start].next = accept;
    return { start, accept };
  }

  empty(): Fragment {
    const start = this.newState();
    const accept = this.newState();
    this.states[start].eps.push(accept);
    return { start, accept };
  }

  concat(a: Fragment, b: Fragment): Fragment {
    this.states[a.accept].eps.push(b.start);
    return { start: a.start, accept: b.accept };
  }

  alternate(a: Fragment, b: Fragment): Fragment {
    const start = this.newState({ eps: [a.start, b.start] });
    const accept = this.newState();
    this.states[a.accept].eps.push(accept);
    this.states[b.accept].eps.push(accept);
    return { start, accept };
  }

  opt(a: Fragment): Fragment {
    const start = this.newState({ eps: [a.start] });
    const accept = this.newState();
    start !== accept && this.states[start].eps.push(accept);
    this.states[a.accept].eps.push(accept);
    return { start, accept };
  }

  star(a: Fragment): Fragment {
    const start = this.newState({ eps: [a.start] });
    const accept = this.newState();
    this.states[start].eps.push(accept);
    this.states[a.accept].eps.push(a.start, accept);
    return { start, accept };
  }

  plus(a: Fragment): Fragment {
    const start = this.newState({ eps: [a.start] });
    const accept = this.newState();
    this.states[a.accept].eps.push(a.start, accept);
    return { start, accept };
  }
}

/** Recursive-descent parser building a Thompson NFA directly (AST-free single pass). */
class RegexCompiler {
  private pos = 0;
  readonly builder = new NFABuilder();

  constructor(private readonly src: string) {}

  compile(): { states: NFAState[]; start: number } {
    if (this.src.length === 0) throw new RegexCompileError('Regex pattern must not be empty');
    const frag = this.parseAlt();
    if (this.pos !== this.src.length) {
      throw new RegexCompileError(`Unexpected character "${this.src[this.pos]}" at position ${this.pos}`);
    }
    this.builder.states[frag.accept].isAccept = true;
    return { states: this.builder.states, start: frag.start };
  }

  private parseAlt(): Fragment {
    let left = this.parseSeq();
    while (this.pos < this.src.length && this.src[this.pos] === '|') {
      this.pos++;
      const right = this.parseSeq();
      left = this.builder.alternate(left, right);
    }
    return left;
  }

  private parseSeq(): Fragment {
    const startPos = this.pos;
    let cur: Fragment | null = null;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === ')' || ch === '|') break;
      const piece = this.parseQuantified();
      cur = cur ? this.builder.concat(cur, piece) : piece;
    }
    if (!cur) {
      if (this.pos === startPos) return this.builder.empty();
    }
    return cur ?? this.builder.empty();
  }

  private parseQuantified(): Fragment {
    const atomStart = this.pos;
    let frag = this.parseAtom();
    while (this.pos < this.src.length) {
      const q = this.src[this.pos];
      if (q === '*') {
        this.pos++;
        if (this.src[this.pos] === '?') this.pos++;
        frag = this.builder.star(frag);
      } else if (q === '+') {
        this.pos++;
        if (this.src[this.pos] === '?') this.pos++;
        frag = this.builder.plus(frag);
      } else if (q === '?') {
        this.pos++;
        if (this.src[this.pos] === '?') this.pos++;
        frag = this.builder.opt(frag);
      } else if (q === '{') {
        const rep = this.parseBraceQuantifier();
        if (!rep) break;
        const [min, max] = rep;
        const atomSrc = this.src.slice(atomStart, this.pos - rep[2]);
        frag = this.expandRepeat(atomSrc, min, max);
      } else {
        break;
      }
    }
    return frag;
  }

  private expandRepeat(atomSrc: string, min: number, max: number | null): Fragment {
    if (min > MAX_REPEAT_EXPAND || (max !== null && max > MAX_REPEAT_EXPAND)) {
      throw new RegexCompileError(`Quantifier {${min},${max ?? ''}} exceeds max expansion ${MAX_REPEAT_EXPAND}`);
    }
    const cloneAtom = () => {
      const b = this.builder;
      // Compile atom inside the shared builder to get fresh states.
      const origStatesLen = b.states.length;
      const subComp = new RegexCompilerWithBuilder(atomSrc, b);
      const f = subComp.parseAtomDirect();
      if (b.states.length === origStatesLen) return b.empty();
      return f;
    };

    let out: Fragment | null = null;
    for (let i = 0; i < min; i++) {
      const part = cloneAtom();
      out = out ? this.builder.concat(out, part) : part;
    }
    if (max === null) {
      const starPart = this.builder.star(cloneAtom());
      out = out ? this.builder.concat(out, starPart) : starPart;
    } else {
      for (let i = min; i < max; i++) {
        const optPart = this.builder.opt(cloneAtom());
        out = out ? this.builder.concat(out, optPart) : optPart;
      }
    }
    return out ?? this.builder.empty();
  }

  private parseBraceQuantifier(): [number, number | null, number] | null {
    const start = this.pos;
    const m = /^\{(\d+)(?:,(\d*))?\}/.exec(this.src.slice(this.pos));
    if (!m) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[2] === '' ? null : Number(m[2]);
    if (max !== null && max < min) {
      throw new RegexCompileError(`Invalid quantifier range ${m[0]}`);
    }
    this.pos += m[0].length;
    if (this.src[this.pos] === '?') this.pos++;
    return [min, max, this.pos - start];
  }

  parseAtom(): Fragment {
    const ch = this.src[this.pos];
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      throw new RegexCompileError(`Nothing to repeat at position ${this.pos}`);
    }
    if (ch === '(') {
      this.pos++;
      if (this.src[this.pos] === '?') {
        if (this.src[this.pos + 1] === ':') {
          this.pos += 2;
        } else {
          throw new RegexCompileError(`Unsupported group construct "(?${this.src[this.pos + 1] ?? ''}" at ${this.pos}`);
        }
      }
      const inner = this.parseAlt();
      if (this.src[this.pos] !== ')') throw new RegexCompileError('Unclosed "(" group');
      this.pos++;
      return inner;
    }
    if (ch === '[') {
      return this.parseCharClass();
    }
    if (ch === '.') {
      this.pos++;
      return this.builder.atom((b) => b !== 0x0a);
    }
    if (ch === '\\') {
      this.pos++;
      if (this.pos >= this.src.length) throw new RegexCompileError('Trailing backslash in regex');
      const esc = this.src[this.pos++];
      const ranges = escapeRanges(esc);
      if (ranges) return this.builder.atom(makeClassPredicate(ranges, false));
      const bytes = Buffer.from(esc, 'utf8');
      return this.literalBytes(bytes);
    }
    // Regular UTF-8 character (support multi-byte characters cleanly as a byte sequence).
    const cp = this.src.codePointAt(this.pos)!;
    const charLen = cp > 0xffff ? 2 : 1;
    const charStr = this.src.slice(this.pos, this.pos + charLen);
    this.pos += charLen;
    return this.literalBytes(Buffer.from(charStr, 'utf8'));
  }

  private literalBytes(bytes: Uint8Array): Fragment {
    let frag = this.builder.atom((b) => b === bytes[0]);
    for (let i = 1; i < bytes.length; i++) {
      const expected = bytes[i];
      frag = this.builder.concat(frag, this.builder.atom((b) => b === expected));
    }
    return frag;
  }

  private parseCharClass(): Fragment {
    this.pos++; // skip '['
    let negated = false;
    if (this.src[this.pos] === '^') {
      negated = true;
      this.pos++;
    }
    const ranges: Array<[number, number]> = [];
    let first = true;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === ']' && !first) {
        this.pos++;
        return this.builder.atom(makeClassPredicate(ranges, negated));
      }
      first = false;
      const lo = this.readClassItem(ranges);
      if (lo !== null && this.src[this.pos] === '-' && this.src[this.pos + 1] !== ']') {
        this.pos++; // skip '-'
        const hi = this.readClassSingleByte();
        if (hi < lo) throw new RegexCompileError(`Out-of-order character range in class`);
        ranges.push([lo, hi]);
      } else if (lo !== null) {
        ranges.push([lo, lo]);
      }
    }
    throw new RegexCompileError('Unclosed "[" character class');
  }

  private readClassItem(rangesOut: Array<[number, number]>): number | null {
    const ch = this.src[this.pos];
    if (ch === '\\') {
      this.pos++;
      if (this.pos >= this.src.length) throw new RegexCompileError('Trailing backslash in character class');
      const esc = this.src[this.pos++];
      const escR = escapeRanges(esc);
      if (escR) {
        rangesOut.push(...escR);
        return null;
      }
      return esc.charCodeAt(0) & 0xff;
    }
    this.pos++;
    return ch.charCodeAt(0) & 0xff;
  }

  private readClassSingleByte(): number {
    const ch = this.src[this.pos];
    if (ch === '\\') {
      this.pos++;
      if (this.pos >= this.src.length) throw new RegexCompileError('Trailing backslash in character class');
      const esc = this.src[this.pos++];
      if (esc === 'n') return 0x0a;
      if (esc === 'r') return 0x0d;
      if (esc === 't') return 0x09;
      return esc.charCodeAt(0) & 0xff;
    }
    this.pos++;
    return ch.charCodeAt(0) & 0xff;
  }
}

class RegexCompilerWithBuilder extends RegexCompiler {
  override readonly builder: NFABuilder;
  constructor(src: string, shared: NFABuilder) {
    super(src);
    this.builder = shared;
  }
  parseAtomDirect(): Fragment {
    return this.parseAtom();
  }
}

/**
 * Streaming Thompson NFA scanner. Tracks leftmost-longest non-overlapping matches across
 * arbitrary chunk boundaries in strict O(N * M) worst-case time.
 */
export class NFAScanner {
  readonly pattern: string;
  private readonly states: NFAState[];
  private readonly start: number;
  private readonly seenGen: Int32Array;
  private gen = 1;
  private active = new Map<number, number>(); // stateId -> earliest startOffset
  private pending: { start: number; end: number } | null = null;
  private offset = 0;

  constructor(pattern: string) {
    this.pattern = pattern;
    const compiled = new RegexCompiler(pattern).compile();
    this.states = compiled.states;
    this.start = compiled.start;
    this.seenGen = new Int32Array(compiled.states.length);
  }

  reset(): void {
    this.active.clear();
    this.pending = null;
    this.offset = 0;
  }

  private addEpsilon(target: Map<number, number>, stateId: number, startOffset: number): void {
    const stack = [stateId];
    const g = ++this.gen;
    this.seenGen[stateId] = g;
    while (stack.length > 0) {
      const s = stack.pop()!;
      const prev = target.get(s);
      if (prev === undefined || startOffset < prev) {
        target.set(s, startOffset);
      }
      for (const nxt of this.states[s].eps) {
        if (this.seenGen[nxt] !== g) {
          this.seenGen[nxt] = g;
          stack.push(nxt);
        }
      }
    }
  }

  /** Feed a chunk of UTF-8 bytes; returns completed leftmost-longest matches. */
  feed(chunk: Uint8Array): NFAMatch[] {
    const out: NFAMatch[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      const pos = this.offset + i;
      // Seed a fresh candidate starting at `pos` only if no earlier pending match is still extending,
      // or let active threads run and handle overlap after stepping.
      this.addEpsilon(this.active, this.start, pos);

      const nextMap = new Map<number, number>();
      let minActiveStart = Infinity;

      for (const [s, sOffset] of this.active) {
        const st = this.states[s];
        if (st.onByte && st.next !== undefined && st.onByte(byte)) {
          this.addEpsilon(nextMap, st.next, sOffset);
        }
      }

      for (const [, sOffset] of nextMap) {
        if (sOffset < minActiveStart) minActiveStart = sOffset;
      }

      if (this.pending && (nextMap.size === 0 || minActiveStart > this.pending.start)) {
        out.push({ pattern: this.pattern, start: this.pending.start, end: this.pending.end });
        const cut = this.pending.end;
        this.pending = null;
        // Drop threads that started before the committed match end so matches stay non-overlapping.
        for (const [s, sOffset] of [...nextMap.entries()]) {
          if (sOffset < cut) nextMap.delete(s);
        }
      }

      let bestAcceptStart = Infinity;
      for (const [s, sOffset] of nextMap) {
        if (this.states[s].isAccept && sOffset < bestAcceptStart) {
          bestAcceptStart = sOffset;
        }
      }

      if (bestAcceptStart < Infinity) {
        if (!this.pending || bestAcceptStart < this.pending.start) {
          this.pending = { start: bestAcceptStart, end: pos + 1 };
        } else if (bestAcceptStart === this.pending.start) {
          this.pending.end = pos + 1;
        }
      }

      this.active = nextMap;
    }
    this.offset += chunk.length;
    return out;
  }

  /** Flush any trailing match at end-of-stream. */
  end(): NFAMatch[] {
    if (!this.pending) return [];
    const m: NFAMatch = { pattern: this.pattern, start: this.pending.start, end: this.pending.end };
    this.pending = null;
    this.active.clear();
    return [m];
  }
}

export function nfaFindAll(text: Uint8Array, pattern: string, chunkBytes = 0): NFAMatch[] {
  const scanner = new NFAScanner(pattern);
  const matches: NFAMatch[] = [];
  if (chunkBytes > 0) {
    for (let pos = 0; pos < text.length; pos += chunkBytes) {
      matches.push(...scanner.feed(text.subarray(pos, pos + chunkBytes)));
    }
  } else {
    matches.push(...scanner.feed(text));
  }
  matches.push(...scanner.end());
  return matches;
}

/** Computes Shannon entropy (bits per byte) of an ASCII/UTF-8 byte slice. */
export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const freq = new Int32Array(256);
  for (let i = 0; i < bytes.length; i++) freq[bytes[i]]++;
  let h = 0;
  const n = bytes.length;
  for (let i = 0; i < 256; i++) {
    if (freq[i] === 0) continue;
    const p = freq[i] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Scans whitespace/quote/equals-delimited tokens in `bytes` and flags high-entropy secret-like
 * tokens (>= minEntropy bits/char and >= minLength bytes, containing mixed character classes).
 */
export function scanEntropy(
  bytes: Uint8Array,
  minEntropy = 4.3,
  minLength = 20,
  maxFindings = 200,
): EntropyFinding[] {
  const findings: EntropyFinding[] = [];
  const isTokenByte = (b: number) =>
    (b >= 0x30 && b <= 0x39) || // 0-9
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    b === 0x2b || b === 0x2f || b === 0x3d || b === 0x5f || b === 0x2d || b === 0x2e; // +/= _-.

  let i = 0;
  while (i < bytes.length && findings.length < maxFindings) {
    if (!isTokenByte(bytes[i])) {
      i++;
      continue;
    }
    const start = i;
    let hasUpper = false;
    let hasLower = false;
    let hasDigit = false;
    while (i < bytes.length && isTokenByte(bytes[i])) {
      const b = bytes[i];
      if (b >= 0x41 && b <= 0x5a) hasUpper = true;
      else if (b >= 0x61 && b <= 0x7a) hasLower = true;
      else if (b >= 0x30 && b <= 0x39) hasDigit = true;
      i++;
    }
    const len = i - start;
    if (len >= minLength && len <= 256 && hasDigit && (hasUpper || hasLower)) {
      const slice = bytes.subarray(start, i);
      const entropy = shannonEntropy(slice);
      if (entropy >= minEntropy) {
        findings.push({
          start,
          end: i,
          entropy: Number(entropy.toFixed(2)),
          token: Buffer.from(slice).toString('utf8'),
        });
      }
    }
  }
  return findings;
}

/** Extracts a bounded single-line context snippet around a byte match. */
export function extractSnippet(
  bytes: Uint8Array,
  byteOffset: number,
  matchBytes: number,
  lineStart: number,
  lineEnd: number,
): SnippetContext {
  const before = Buffer.from(bytes.subarray(Math.max(lineStart, byteOffset - 40), byteOffset)).toString('utf8');
  const match = Buffer.from(bytes.subarray(byteOffset, Math.min(bytes.length, byteOffset + matchBytes))).toString('utf8');
  const after = Buffer.from(
    bytes.subarray(Math.min(bytes.length, byteOffset + matchBytes), Math.min(lineEnd, byteOffset + matchBytes + 60)),
  ).toString('utf8');
  return { before, match, after };
}
