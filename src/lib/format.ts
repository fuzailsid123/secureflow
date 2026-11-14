export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export const fmtNum = (n: number): string => n.toLocaleString('en-US');

/** Sub-millisecond-aware duration for algorithm timings. */
export const fmtFast = (ms: number): string => (ms < 1 ? `${(ms * 1000).toFixed(0)} \u00b5s` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`);
