import { AhoCorasickScanner } from '@/lib/ahoCorasick';
import { badRequest, json } from '@/lib/http';
import { KMPScanner } from '@/lib/kmp';
import { LIMITS } from '@/lib/limits';
import { NFAScanner, scanEntropy } from '@/lib/nfa';
import type { RuleKind, ScannerMode } from '@/lib/types';
import {
  validateEntropyThreshold,
  validatePatternList,
  validateRegexList,
  validateScannerMode,
} from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface StreamMatch {
  pattern: string;
  ruleKind: RuleKind;
  entropy?: number;
  byteOffset: number;
  line: number;
  column: number;
  before: string;
  match: string;
  after: string;
}

class RollingLineTracker {
  private checkpoints: Array<{ offset: number; line: number }> = [{ offset: 0, line: 1 }];
  private totalLine = 1;
  private absOffset = 0;

  feed(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        this.totalLine++;
        this.checkpoints.push({ offset: this.absOffset + i + 1, line: this.totalLine });
      }
    }
    this.absOffset += chunk.length;
    // Bound checkpoint memory for huge multi-million-line streams while keeping recent offsets exact.
    if (this.checkpoints.length > 50_000) {
      this.checkpoints = this.checkpoints.slice(-25_000);
    }
  }

  locate(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.checkpoints.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.checkpoints[mid].offset <= offset) lo = mid;
      else hi = mid - 1;
    }
    const cp = this.checkpoints[lo];
    return { line: cp.line, column: Math.max(1, offset - cp.offset + 1) };
  }
}

async function auditReadableStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: {
    patterns: string[];
    regexPatterns: string[];
    entropyThreshold?: number;
    scanner: ScannerMode;
  },
) {
  const t0 = performance.now();
  const ac = opts.scanner === 'aho-corasick' && opts.patterns.length > 0 ? new AhoCorasickScanner(opts.patterns) : null;
  const kmps = opts.scanner === 'kmp' ? opts.patterns.map((p) => new KMPScanner(p)) : [];
  const nfas = opts.regexPatterns.map((r) => new NFAScanner(r));
  const counts = new Map<string, { count: number; ruleKind: RuleKind; comparisons: number }>();
  for (const p of opts.patterns) counts.set(p, { count: 0, ruleKind: 'literal', comparisons: 0 });
  for (const r of opts.regexPatterns) counts.set(r, { count: 0, ruleKind: 'regex', comparisons: 0 });
  const entLabel =
    opts.entropyThreshold !== undefined ? `HIGH_ENTROPY(H>=${opts.entropyThreshold.toFixed(1)})` : null;
  if (entLabel) counts.set(entLabel, { count: 0, ruleKind: 'entropy', comparisons: 0 });

  const tracker = new RollingLineTracker();
  const matches: StreamMatch[] = [];
  let totalMatches = 0;
  let totalBytes = 0;
  let tail: Buffer = Buffer.alloc(0);

  const recordHit = (
    pattern: string,
    ruleKind: RuleKind,
    byteOffset: number,
    matchLen: number,
    windowBuf: Buffer,
    windowStartOffset: number,
    entropy?: number,
  ) => {
    totalMatches++;
    const entry = counts.get(pattern);
    if (entry) entry.count++;
    if (matches.length >= LIMITS.maxAuditMatches) return;
    const loc = tracker.locate(byteOffset);
    const rel = byteOffset - windowStartOffset;
    const before =
      rel >= 0
        ? windowBuf.subarray(Math.max(0, rel - 32), rel).toString('utf8').replace(/\r?\n/g, ' ')
        : '';
    const matchStr =
      rel >= 0 && rel + matchLen <= windowBuf.length
        ? windowBuf.subarray(rel, rel + matchLen).toString('utf8')
        : pattern;
    const after =
      rel >= 0 && rel + matchLen <= windowBuf.length
        ? windowBuf.subarray(rel + matchLen, Math.min(windowBuf.length, rel + matchLen + 32)).toString('utf8').replace(/\r?\n/g, ' ')
        : '';
    matches.push({
      pattern,
      ruleKind,
      entropy,
      byteOffset,
      line: loc.line,
      column: loc.column,
      before,
      match: matchStr,
      after,
    });
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (totalBytes + value.length > LIMITS.maxStreamAuditBytes) {
        await reader.cancel().catch(() => undefined);
        return { error: `Stream exceeds ${LIMITS.maxStreamAuditBytes} bytes limit` };
      }

      const chunkBuf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const windowStartOffset = totalBytes - tail.length;
      const windowBuf = tail.length > 0 ? Buffer.concat([tail, chunkBuf]) : chunkBuf;
      tracker.feed(chunkBuf);

      if (ac) {
        for (const h of ac.feed(chunkBuf)) {
          recordHit(
            h.pattern,
            'literal',
            h.byteOffset,
            ac.patternLengths[h.patternIndex],
            windowBuf,
            windowStartOffset,
          );
        }
      } else {
        for (const k of kmps) {
          for (const off of k.feed(chunkBuf)) {
            recordHit(k.pattern, 'literal', off, k.length, windowBuf, windowStartOffset);
          }
        }
      }

      for (const n of nfas) {
        for (const m of n.feed(chunkBuf)) {
          recordHit(m.pattern, 'regex', m.start, Math.max(1, m.end - m.start), windowBuf, windowStartOffset);
        }
      }

      if (opts.entropyThreshold !== undefined && entLabel) {
        for (const eh of scanEntropy(chunkBuf, opts.entropyThreshold, 20, LIMITS.maxAuditMatches)) {
          recordHit(
            entLabel,
            'entropy',
            totalBytes + eh.start,
            eh.end - eh.start,
            windowBuf,
            windowStartOffset,
            eh.entropy,
          );
        }
      }

      totalBytes += chunkBuf.length;
      tail = windowBuf.subarray(Math.max(0, windowBuf.length - 320));
    }

    for (const n of nfas) {
      for (const m of n.end()) {
        recordHit(
          m.pattern,
          'regex',
          m.start,
          Math.max(1, m.end - m.start),
          tail,
          Math.max(0, totalBytes - tail.length),
        );
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (ac) {
    for (const p of opts.patterns) {
      const c = counts.get(p);
      if (c) c.comparisons = ac.comparisons;
    }
  } else {
    for (const k of kmps) {
      const c = counts.get(k.pattern);
      if (c) c.comparisons = k.comparisons;
    }
  }
  for (const r of opts.regexPatterns) {
    const c = counts.get(r);
    if (c) c.comparisons = totalBytes;
  }
  if (entLabel) {
    const c = counts.get(entLabel);
    if (c) c.comparisons = totalBytes;
  }

  matches.sort((a, b) => a.byteOffset - b.byteOffset || a.pattern.localeCompare(b.pattern));

  return {
    bytes: totalBytes,
    scanner: opts.scanner,
    totalMatches,
    truncated: totalMatches > matches.length,
    perPattern: [...counts.entries()].map(([pattern, v]) => ({
      pattern,
      ruleKind: v.ruleKind,
      count: v.count,
      kmpComparisons: v.comparisons,
    })),
    matches: matches.slice(0, LIMITS.maxAuditMatches),
    kmpMs: performance.now() - t0,
  };
}

/**
 * Streaming log audit supporting multipart file upload (`file` field) or raw binary `req.body`
 * streams up to 50 MB without buffering the entire file in memory.
 */
export async function POST(req: Request) {
  const ct = req.headers.get('content-type') ?? '';
  const url = new URL(req.url);

  let rawPatterns: unknown;
  let rawRegex: unknown;
  let rawScanner: unknown;
  let rawEntropy: unknown;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return badRequest(['multipart form must include a "file" field']);
    if (file.size > LIMITS.maxStreamAuditBytes) {
      return badRequest([`File exceeds ${LIMITS.maxStreamAuditBytes} bytes`]);
    }
    const pStr = String(form.get('patterns') ?? '');
    rawPatterns = pStr
      .split(/\r?\n/)
      .map((s) => s.trimEnd())
      .filter((s) => s.length > 0);
    const rStr = String(form.get('regexPatterns') ?? '');
    rawRegex = rStr
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    rawScanner = form.get('scanner') ?? 'aho-corasick';
    const eStr = form.get('entropyThreshold');
    rawEntropy = eStr ? Number(eStr) : undefined;
    reader = file.stream().getReader();
  } else {
    const pParam = url.searchParams.getAll('pattern');
    rawPatterns = pParam;
    rawRegex = url.searchParams.getAll('regex');
    rawScanner = url.searchParams.get('scanner') ?? 'aho-corasick';
    const eParam = url.searchParams.get('entropy');
    rawEntropy = eParam ? Number(eParam) : undefined;
    if (!req.body) return badRequest(['Request body stream is required']);
    reader = req.body.getReader();
  }

  const scn = validateScannerMode(rawScanner);
  if (!scn.ok) {
    await reader.cancel().catch(() => undefined);
    return badRequest(scn.errors);
  }
  const rx = validateRegexList(rawRegex);
  if (!rx.ok) {
    await reader.cancel().catch(() => undefined);
    return badRequest(rx.errors);
  }
  const ent = validateEntropyThreshold(rawEntropy);
  if (!ent.ok) {
    await reader.cancel().catch(() => undefined);
    return badRequest(ent.errors);
  }

  const hasExtra = rx.value.length > 0 || ent.value !== undefined;
  let patterns: string[] = [];
  if (Array.isArray(rawPatterns) && rawPatterns.length === 0 && hasExtra) {
    patterns = [];
  } else {
    const pats = validatePatternList(rawPatterns);
    if (!pats.ok) {
      await reader.cancel().catch(() => undefined);
      return badRequest(pats.errors);
    }
    patterns = pats.value;
  }

  const res = await auditReadableStream(reader, {
    patterns,
    regexPatterns: rx.value,
    entropyThreshold: ent.value,
    scanner: scn.value,
  });
  if ('error' in res && typeof res.error === 'string') return badRequest([res.error]);
  return json(res);
}
