'use client';
import { useState } from 'react';
import { Badge } from '@/components/Badge';
import { api, downloadJson, errorText } from '@/lib/client';
import { fmtBytes, fmtFast, fmtNum } from '@/lib/format';
import { LIMITS } from '@/lib/limits';
import { toSarifReport } from '@/lib/sarif';
import type { RuleKind, ScannerMode } from '@/lib/types';

interface AuditResponse {
  bytes: number;
  scanner?: ScannerMode;
  totalMatches: number;
  truncated: boolean;
  perPattern: {
    pattern: string;
    ruleKind?: RuleKind;
    count: number;
    kmpComparisons: number;
    naiveComparisons?: number;
  }[];
  matches: {
    pattern: string;
    ruleKind?: RuleKind;
    entropy?: number;
    byteOffset: number;
    line: number;
    column: number;
    before: string;
    match: string;
    after: string;
  }[];
  kmpMs: number;
  acMs?: number;
  acComparisons?: number;
  naiveMs?: number;
}

const SAMPLE_LOG = `2026-03-01T10:00:01Z INFO  service starting
2026-03-01T10:00:02Z WARN  call to DEPRECATED_CALL legacy_auth() will be removed
2026-03-01T10:00:03Z INFO  loading credentials
2026-03-01T10:00:03Z DEBUG AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY
2026-03-01T10:00:04Z ERROR 401 UNAUTHORIZED_ACCESS to /admin/export by user 17
2026-03-01T10:00:05Z ERROR UNAUTHORIZED_ACCESS UNAUTHORIZED_ACCESS repeated twice on one line
`;

export default function AuditPage() {
  const [text, setText] = useState(SAMPLE_LOG);
  const [patterns, setPatterns] = useState('UNAUTHORIZED_ACCESS\nDEPRECATED_CALL\nAWS_SECRET_ACCESS_KEY');
  const [regexPatterns, setRegexPatterns] = useState('');
  const [scanner, setScanner] = useState<ScannerMode>('aho-corasick');
  const [entropyEnabled, setEntropyEnabled] = useState(false);
  const [entropyThreshold, setEntropyThreshold] = useState(4.3);
  const [compare, setCompare] = useState(true);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [res, setRes] = useState<AuditResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const list = patterns.split('\n').filter((p) => p.length > 0);
      const rList = regexPatterns
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (uploadFile) {
        const form = new FormData();
        form.append('file', uploadFile);
        form.append('patterns', list.join('\n'));
        form.append('regexPatterns', rList.join('\n'));
        form.append('scanner', scanner);
        if (entropyEnabled) form.append('entropyThreshold', String(entropyThreshold));
        const resp = await fetch('/api/audit/stream', { method: 'POST', body: form });
        const data = (await resp.json()) as AuditResponse & { errors?: string[] };
        if (!resp.ok) throw new Error(data.errors?.[0] ?? 'Stream audit failed');
        setRes(data);
      } else {
        setRes(
          await api<AuditResponse>('/api/audit', {
            method: 'POST',
            json: {
              text,
              patterns: list,
              regexPatterns: rList,
              entropyThreshold: entropyEnabled ? entropyThreshold : undefined,
              scanner,
              compare,
            },
          }),
        );
      }
    } catch (e) {
      setError(errorText(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  function loadAdversarial() {
    setUploadFile(null);
    setText('Z'.repeat(60000) + 'A');
    setPatterns('Z'.repeat(63) + 'A');
    setCompare(true);
  }

  function downloadSarif() {
    if (!res) return;
    const sarif = toSarifReport({
      toolRunName: uploadFile ? uploadFile.name : 'pasted-log',
      findings: res.matches.map((m) => ({
        pattern: m.pattern,
        byteOffset: m.byteOffset,
        line: m.line,
        column: m.column,
        ruleKind: m.ruleKind,
        entropy: m.entropy,
        context: { before: m.before, match: m.match, after: m.after },
      })),
    });
    downloadJson('audit-findings.sarif.json', sarif);
  }

  return (
    <div className="page narrow">
      <h1>Log audit</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Paste any log or stream a file up to {fmtBytes(LIMITS.maxStreamAuditBytes)} directly through{' '}
        <b>KMP</b> or <b>Aho-Corasick</b> in {LIMITS.chunkBytes}-byte chunks, with optional{' '}
        <b>Thompson NFA regex</b> and <b>Shannon entropy</b> secret detection.
      </p>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="row small muted" style={{ gap: 6 }}>
            Stream file (optional, bypasses textarea limit):
            <input
              type="file"
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {uploadFile && (
            <>
              <Badge tone="blue">{uploadFile.name} ({fmtBytes(uploadFile.size)})</Badge>
              <button className="ghost icon" onClick={() => setUploadFile(null)}>Clear file</button>
            </>
          )}
        </div>

        <div className="row" style={{ alignItems: 'stretch' }}>
          <label className="field" style={{ flex: 3, minWidth: 280 }}>
            Log text ({uploadFile ? 'file stream selected' : `${fmtBytes(new TextEncoder().encode(text).length)}, max ${fmtBytes(LIMITS.maxAuditBytes)}`})
            <textarea
              rows={11}
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              disabled={!!uploadFile}
            />
          </label>
          <div style={{ flex: 1, minWidth: 220, display: 'grid', gap: 10 }}>
            <label className="field">
              Literal patterns (one per line, max {LIMITS.maxPatterns})
              <textarea rows={5} value={patterns} onChange={(e) => setPatterns(e.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              Thompson NFA Regex (one per line)
              <textarea
                rows={4}
                value={regexPatterns}
                onChange={(e) => setRegexPatterns(e.target.value)}
                placeholder="e.g. AKIA[0-9A-Z]{16}"
                spellCheck={false}
              />
            </label>
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={run} disabled={busy}>
            {busy ? 'Scanning…' : uploadFile ? 'Stream Scan File' : 'Scan'}
          </button>
          <label className="row small muted" style={{ gap: 6 }}>
            Scanner
            <select value={scanner} onChange={(e) => setScanner(e.target.value as ScannerMode)}>
              <option value="aho-corasick">Aho-Corasick O(N+Z)</option>
              <option value="kmp">KMP O(k·N)</option>
            </select>
          </label>
          {!uploadFile && (
            <label className="row small muted" style={{ gap: 6 }}>
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> compare naive
            </label>
          )}
          <label className="row small muted" style={{ gap: 6 }}>
            <input type="checkbox" checked={entropyEnabled} onChange={(e) => setEntropyEnabled(e.target.checked)} />
            Entropy ≥
          </label>
          <input
            type="number"
            step="0.1"
            min={2.5}
            max={7.5}
            value={entropyThreshold}
            onChange={(e) => setEntropyThreshold(Number(e.target.value) || 4.3)}
            style={{ width: 64 }}
            disabled={!entropyEnabled}
          />
          <span className="spacer" />
          <button
            className="ghost"
            onClick={() => {
              setUploadFile(null);
              setText(SAMPLE_LOG);
              setPatterns('UNAUTHORIZED_ACCESS\nDEPRECATED_CALL\nAWS_SECRET_ACCESS_KEY');
            }}
          >
            Load sample log
          </button>
          <button className="ghost" onClick={loadAdversarial}>Load adversarial input (ZZZ…ZA)</button>
        </div>
      </div>

      {error && <div className="alert err">{error}</div>}

      {res && (
        <>
          <div className="card">
            <header>
              <h2>Result</h2>
              <div className="row">
                <Badge tone={res.totalMatches ? 'red' : 'green'}>{fmtNum(res.totalMatches)} matches</Badge>
                <Badge tone="gray">{fmtBytes(res.bytes)} scanned</Badge>
                <Badge tone="violet">{res.scanner ?? 'kmp'} {fmtFast(res.kmpMs)}</Badge>
                {res.naiveMs !== undefined && <Badge tone="amber">naive {fmtFast(res.naiveMs)}</Badge>}
                <button className="ghost icon" onClick={downloadSarif}>Export SARIF</button>
                <button className="ghost icon" onClick={() => downloadJson('audit-result.json', res)}>Export JSON</button>
              </div>
            </header>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pattern</th>
                    <th>Kind</th>
                    <th>Matches</th>
                    <th>Scanner comparisons</th>
                    {!uploadFile && compare && <th>Naive comparisons</th>}
                    {!uploadFile && compare && <th>Naive / Scanner</th>}
                  </tr>
                </thead>
                <tbody>
                  {res.perPattern.map((p) => (
                    <tr key={`${p.ruleKind ?? 'literal'}-${p.pattern}`}>
                      <td className="mono">{p.pattern.length > 40 ? `${p.pattern.slice(0, 40)}…` : p.pattern}</td>
                      <td className="small muted">{p.ruleKind ?? 'literal'}</td>
                      <td>{fmtNum(p.count)}</td>
                      <td>{fmtNum(p.kmpComparisons)}</td>
                      {!uploadFile && compare && (
                        <td>{p.naiveComparisons !== undefined ? fmtNum(p.naiveComparisons) : '-'}</td>
                      )}
                      {!uploadFile && compare && (
                        <td>
                          {p.naiveComparisons !== undefined
                            ? `${(p.naiveComparisons / Math.max(1, p.kmpComparisons)).toFixed(2)}\u00d7`
                            : '-'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <header>
              <h2>Matches</h2>
              {res.truncated && <Badge tone="amber">showing first {LIMITS.maxAuditMatches}</Badge>}
            </header>
            {res.matches.length === 0 ? (
              <div className="empty">No forbidden patterns found.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Line:col</th><th>Byte</th><th>Pattern</th><th>Context</th></tr>
                  </thead>
                  <tbody>
                    {res.matches.map((m, i) => (
                      <tr key={i}>
                        <td className="mono">{m.line}:{m.column}</td>
                        <td className="mono">{fmtNum(m.byteOffset)}</td>
                        <td>
                          <Badge tone="red">{m.pattern.length > 24 ? `${m.pattern.slice(0, 24)}…` : m.pattern}</Badge>
                          {m.entropy !== undefined && <span className="muted small"> H={m.entropy}</span>}
                        </td>
                        <td className="snippet">{m.before}<mark>{m.match.length > 80 ? `${m.match.slice(0, 80)}…` : m.match}</mark>{m.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
