/** Single source of truth for every constraint in the specification. */
export const LIMITS = {
  maxTasks: 5000,
  maxEdges: 20000,
  minWorkers: 1,
  maxWorkers: 16,
  maxPatterns: 20,
  maxPatternBytes: 256,
  maxTaskLogBytes: 1_000_000,
  maxTotalLogBytes: 5_000_000,
  maxAuditBytes: 5_000_000,
  maxStreamAuditBytes: 50_000_000,
  maxRegexPatterns: 20,
  maxDurationMs: 3_600_000,
  maxNameLength: 80,
  maxIdLength: 40,
  maxRunsPerWorkflow: 20,
  maxAuditMatches: 1000,
  /** Logs are fed to the KMP scanners in chunks of this many bytes (simulates a stream). */
  chunkBytes: 4096,
  /** The SVG graph view is only drawn up to this many tasks. */
  maxGraphRenderTasks: 150,
} as const;

export const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
