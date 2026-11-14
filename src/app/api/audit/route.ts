import { ahoCorasickFindAll } from '@/lib/ahoCorasick';
import { badRequest, json, readJson } from '@/lib/http';
import { toSarifReport } from '@/lib/sarif';
import { kmpFindAll, LineIndex, naiveFindAll } from '@/lib/kmp';
import { LIMITS } from '@/lib/limits';
import { extractSnippet, nfaFindAll, scanEntropy } from '@/lib/nfa';
import type { RuleKind } from '@/lib/types';
import {
  validateEntropyThreshold,
  validatePatternList,
  validateRegexList,
  validateScannerMode,
} from '@/lib/validate';

export const dynamic = 'force-dynamic';

/** Standalone log audit: report every match of literal/regex/entropy rules with line/column and context. */
export async function POST(req: Request) {
  const body = (await readJson(req)) as
    | {
        text?: unknown;
        patterns?: unknown;
        regexPatterns?: unknown;
        entropyThreshold?: unknown;
        scanner?: unknown;
        compare?: unknown;
        format?: unknown;
      }
    | undefined;
  if (!body || typeof body.text !== 'string') return badRequest(['text must be a string']);

  const scn = validateScannerMode(body.scanner);
  if (!scn.ok) return badRequest(scn.errors);
  const rx = validateRegexList(body.regexPatterns);
  if (!rx.ok) return badRequest(rx.errors);
  const ent = validateEntropyThreshold(body.entropyThreshold);
  if (!ent.ok) return badRequest(ent.errors);

  const hasExtraRules = rx.value.length > 0 || ent.value !== undefined;
  let literalPatterns: string[] = [];
  if (Array.isArray(body.patterns) && body.patterns.length === 0 && hasExtraRules) {
    literalPatterns = [];
  } else {
    const pats = validatePatternList(body.patterns);
    if (!pats.ok) return badRequest(pats.errors);
    literalPatterns = pats.value;
  }

  const bytes = Buffer.from(body.text, 'utf8');
  if (bytes.length > LIMITS.maxAuditBytes) return badRequest([`text exceeds ${LIMITS.maxAuditBytes} bytes`]);
  const compare = body.compare === true;

  const perPattern: {
    pattern: string;
    ruleKind: RuleKind;
    count: number;
    kmpComparisons: number;
    naiveComparisons?: number;
  }[] = [];
  const hits: { pattern: string; offset: number; length: number; ruleKind: RuleKind; entropy?: number }[] = [];
  let kmpMs = 0;
  let acMs = 0;
  let acComparisons: number | undefined;
  let naiveMs = 0;

  if (scn.value === 'aho-corasick' && literalPatterns.length > 0) {
    const t0 = performance.now();
    const ac = ahoCorasickFindAll(bytes, literalPatterns, LIMITS.chunkBytes);
    acMs = performance.now() - t0;
    acComparisons = ac.comparisons;

    const counts = new Map<string, number>();
    for (const p of literalPatterns) counts.set(p, 0);
    for (const m of ac.matches) {
      counts.set(m.pattern, (counts.get(m.pattern) ?? 0) + 1);
      hits.push({
        pattern: m.pattern,
        offset: m.byteOffset,
        length: Buffer.byteLength(m.pattern, 'utf8'),
        ruleKind: 'literal',
      });
    }
    for (const pattern of literalPatterns) {
      let naiveComparisons: number | undefined;
      if (compare) {
        const t1 = performance.now();
        const nv = naiveFindAll(bytes, pattern);
        naiveMs += performance.now() - t1;
        naiveComparisons = nv.comparisons;
      }
      perPattern.push({
        pattern,
        ruleKind: 'literal',
        count: counts.get(pattern) ?? 0,
        kmpComparisons: ac.comparisons,
        naiveComparisons,
      });
    }
  } else {
    for (const pattern of literalPatterns) {
      const t0 = performance.now();
      const k = kmpFindAll(bytes, pattern, LIMITS.chunkBytes);
      kmpMs += performance.now() - t0;
      let naiveComparisons: number | undefined;
      if (compare) {
        const t1 = performance.now();
        const nv = naiveFindAll(bytes, pattern);
        naiveMs += performance.now() - t1;
        naiveComparisons = nv.comparisons;
      }
      perPattern.push({
        pattern,
        ruleKind: 'literal',
        count: k.offsets.length,
        kmpComparisons: k.comparisons,
        naiveComparisons,
      });
      const plen = Buffer.byteLength(pattern, 'utf8');
      for (const offset of k.offsets) hits.push({ pattern, offset, length: plen, ruleKind: 'literal' });
    }
  }

  for (const rPat of rx.value) {
    const t0 = performance.now();
    const matches = nfaFindAll(bytes, rPat, LIMITS.chunkBytes);
    kmpMs += performance.now() - t0;
    perPattern.push({
      pattern: rPat,
      ruleKind: 'regex',
      count: matches.length,
      kmpComparisons: bytes.length,
    });
    for (const m of matches) {
      hits.push({ pattern: rPat, offset: m.start, length: Math.max(1, m.end - m.start), ruleKind: 'regex' });
    }
  }

  if (ent.value !== undefined) {
    const entHits = scanEntropy(bytes, ent.value, 20, LIMITS.maxAuditMatches);
    if (entHits.length > 0 || literalPatterns.length + rx.value.length === 0) {
      perPattern.push({
        pattern: `HIGH_ENTROPY(H>=${ent.value.toFixed(1)})`,
        ruleKind: 'entropy',
        count: entHits.length,
        kmpComparisons: bytes.length,
      });
    }
    for (const eh of entHits) {
      hits.push({
        pattern: `HIGH_ENTROPY(H>=${ent.value.toFixed(1)})`,
        offset: eh.start,
        length: eh.end - eh.start,
        ruleKind: 'entropy',
        entropy: eh.entropy,
      });
    }
  }

  hits.sort((a, b) => a.offset - b.offset || a.pattern.localeCompare(b.pattern));
  const index = new LineIndex(bytes);
  const shown = hits.slice(0, LIMITS.maxAuditMatches).map((h) => {
    const loc = index.locate(h.offset);
    const snip = extractSnippet(bytes, h.offset, h.length, loc.lineStart, loc.lineEnd);
    return {
      pattern: h.pattern,
      ruleKind: h.ruleKind,
      entropy: h.entropy,
      byteOffset: h.offset,
      line: loc.line,
      column: loc.column,
      before: snip.before,
      match: snip.match,
      after: snip.after,
    };
  });

  if (body.format === 'sarif') {
    return json(
      toSarifReport({
        toolRunName: 'audit',
        findings: shown.map((m) => ({
          pattern: m.pattern,
          byteOffset: m.byteOffset,
          line: m.line,
          column: m.column,
          ruleKind: m.ruleKind,
          entropy: m.entropy,
          context: { before: m.before, match: m.match, after: m.after },
        })),
      }),
    );
  }

  return json({
    bytes: bytes.length,
    scanner: scn.value,
    totalMatches: hits.length,
    truncated: hits.length > shown.length,
    perPattern,
    matches: shown,
    kmpMs: scn.value === 'aho-corasick' ? acMs : kmpMs,
    acMs: scn.value === 'aho-corasick' ? acMs : undefined,
    acComparisons,
    naiveMs: compare ? naiveMs : undefined,
  });
}
