# SecureFlow

Dependency-aware task scheduler and streaming log security auditor built full-stack on **Next.js (App Router + Route Handlers)** and **TypeScript**, backed by built-in **SQLite (`node:sqlite`)** and zero external runtime dependencies.

SecureFlow combines graph scheduling algorithms with streaming pattern-matching and secret-detection engines. Tasks are ordered by dependency, executed concurrently across a worker pool (either via a real-time async `ReadableStream` runner with `AbortController` mid-stream cancellation or a deterministic discrete-event simulator), and audited chunk-by-chunk as bytes arrive. Any task whose log leaks a forbidden pattern, regex match, or high-entropy secret is **quarantined** immediately, every downstream dependent task is **cancelled**, and unrelated tasks keep running.

---

## Algorithms Implemented

| Algorithm | Module | Complexity | Role |
|---|---|---|---|
| **Topological sort, source removal (Kahn)** | `src/lib/topo.ts` | $O(V + E)$ | Orders tasks, groups parallel levels, detects cycles and extracts an exact cycle |
| **Iterative DFS (`descendants`)** | `src/lib/topo.ts` | $O(V + E)$ | Cancels every downstream task reachable from a quarantined node (stack-safe to 5,000+ depth) |
| **Critical Path (longest DAG path)** | `src/lib/topo.ts` | $O(V + E)$ | Computes the minimum theoretical makespan and critical task chain |
| **Tarjan's SCC & Feedback-Arc Heuristic** | `src/lib/scc.ts` | $O(V + E)$ | Iterative Tarjan decomposition finding **all** cyclic components and suggesting edges to break |
| **Bottom-Level Criticality (`bottomLevels`)** | `src/lib/scc.ts` | $O(V + E)$ | Reverse-topological DP computing longest remaining path to a sink for Critical-Path-First scheduling |
| **Knuth-Morris-Pratt (streaming bytes)** | `src/lib/kmp.ts` | $O(N + M)$ | Byte-level streaming scanner (`KMPScanner`) carrying only prefix length `j` across chunk boundaries |
| **Aho-Corasick Automaton (streaming bytes)** | `src/lib/ahoCorasick.ts` | $O(N + Z)$ | Multi-pattern DFA trie + failure/output links scanning all $k$ patterns in a single pass |
| **Thompson NFA Regex Engine** | `src/lib/nfa.ts` | $O(N \cdot M)$ | Linear-time NFA regex matching (`NFAScanner`) immune to catastrophic backtracking (ReDoS) |
| **Shannon Entropy Secret Detector** | `src/lib/nfa.ts` | $O(N)$ | Flags high-entropy tokens (configurable bits/byte threshold) without needing known pattern names |
| **Line Index (`LineIndex`)** | `src/lib/kmp.ts` | $O(N)$ build, $O(\log L)$ lookup | Maps raw byte offsets to 1-based `line:column` and extracts surrounding context snippets |
| **Barycenter Layer Ordering** | `src/components/GraphView.tsx` | $O(V + E)$ | Reduces visual edge crossings between topological levels in the SVG DAG view |

---

## Execution Modes & Scheduling Policies

### Execution Modes
* **`live` (Async `ReadableStream` + `AbortController`):** `LiveRunManager` (`src/lib/runner.ts`) dispatches tasks onto an async worker pool. Each task streams `4,096`-byte chunks over time through the configured scanner. On the first violation, an `AbortController` aborts the task stream immediately, quarantines the task, cancels all downstream tasks, and pushes live events to connected SSE clients. Active live runs can also be aborted via `POST /api/runs/:id/cancel`.
* **`simulate` (Deterministic Discrete-Event Replay):** `simulateRun` (`src/lib/simulate.ts`) computes the exact virtual-time schedule synchronously using a binary `PriorityHeap`, persists the event timeline, and replays it over SSE paced by `?speed=`.

### Scheduling Policies
* **`topo-fifo`:** Dispatches ready tasks in Kahn topological order.
* **`critical-path`:** Prioritizes ready tasks with the largest `bottomLevels` (longest remaining path to a sink), reducing makespan on asymmetric DAGs.
* **`shortest-first`:** Dispatches ready tasks by ascending `durationMs`.

### Incremental Subgraph Recovery
When a run stops with quarantined or cancelled tasks, `POST /api/workflows/:id/runs/:runId/resume` reuses all `completed` tasks from the previous run and re-schedules only the quarantined task(s) and their downstream subgraph (optionally allowlisting false-positive literal patterns).

---

## Architecture

```
React Client (Next.js App Router)
  ├── /                       Workflow list, sample loader, JSON/GitHub Actions YAML import, Stress DAG generator
  ├── /workflows/[id]         Editor, live DAG (Tarjan SCC break hints), Run controls, Gantt, Event log, Findings + SARIF/Resume
  ├── /audit                  Textarea or 50 MB streaming file upload, KMP/Aho-Corasick/NFA/Entropy, SARIF/JSON export
  └── /benchmark              Aho-Corasick vs k*KMP vs Naive, KMP vs Naive (adversarial & random), Topo sort scaling
        │
        ▼ fetch / multipart / EventSource (SSE)
Next.js Route Handlers (src/app/api/**)
  ├── Core Libraries (src/lib/*): topo.ts, scc.ts, kmp.ts, ahoCorasick.ts, nfa.ts, simulate.ts, runner.ts, import.ts, generator.ts, sarif.ts
  └── Persistence (src/lib/store.ts) ──► SQLite (node:sqlite) at ${DATA_DIR}/secureflow.db
                                         Tables: workflows, runs, run_events, findings
```

---

## Quick Start

### Prerequisites
* **Node.js `>= 22.13`** (tested on **Node `v22.17.0`**; uses built-in `node:sqlite`, so no C++ compiler or native build tools are required).

### Run Locally

```bash
npm install
npm run dev            # http://localhost:3000
```

Production build & start:

```bash
npm run build
npm start
```

Typecheck & full test suite:

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run (12 test files, 82 tests)
```

Click **Load sample pipeline** on `/`, or try **Import JSON / GitHub Actions YAML** or **Generate Stress DAG**, then run the workflow in **Live async stream** or **Simulated replay** mode.

---

## Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `./.data` | Directory where `secureflow.db` is stored. If a legacy `store.json` exists in `DATA_DIR` and the DB is empty, it is migrated automatically on first access. |
| `SECUREFLOW_API_KEY` | *(unset)* | Optional API key guard for mutating endpoints (`POST`/`PUT`/`DELETE`). When set, requests must supply `Authorization: Bearer <key>` or `x-api-key: <key>`. |
| `PORT` | `3000` | HTTP port for `next start`. |

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows` | List workflow summaries sorted by `updatedAt` |
| `POST` | `/api/workflows` | Create workflow (`{ sample: true }`, `{ importText }`, `{ generate }`, or workflow JSON) |
| `GET, PUT, DELETE` | `/api/workflows/:id` | Read, validate & update, or cascade-delete a workflow and its runs |
| `GET` | `/api/workflows/:id/runs` | List run summaries for a workflow (retains newest 20) |
| `POST` | `/api/workflows/:id/runs` | Start a run (`{ workers, mode, policy, scanner, speed, regexPatterns, entropyThreshold }`); returns `409 CIRCULAR_DEPENDENCY` with `cycle`, `sccs`, and `suggestedBreaks` on cycles |
| `POST` | `/api/workflows/:id/runs/:runId/resume` | Incremental subgraph resume reusing completed tasks (supports `allowlistPatterns`) |
| `GET` | `/api/runs/:id` | Get full run (live in-memory state if running, otherwise from SQLite) |
| `GET` | `/api/runs/:id/stream` | SSE stream: live events for active runs, or paced replay (`?speed=1..10000` or `instant`) for finished runs |
| `POST` | `/api/runs/:id/cancel` | Abort an active `live` run mid-stream |
| `POST` | `/api/schedule` | Stateless DAG analysis: `levels`, `order`, `criticalPath`, `bottomLevels`, or `cycle` + `sccs` + `suggestedBreaks` |
| `POST` | `/api/audit` | In-memory log audit (`{ text, patterns, regexPatterns?, entropyThreshold?, scanner?, compare?, format? }`); supports `format: "sarif"` |
| `POST` | `/api/audit/stream` | Streaming `multipart/form-data` file upload or raw binary body audit up to 50 MB |
| `POST` | `/api/benchmark` | Reproducible seeded benchmarks (Aho-Corasick vs KMP vs Naive, adversarial & random search, topological sort scaling) |

---

## Constraints & Limits (`src/lib/limits.ts`)

| Constraint | Value |
|---|---|
| Tasks / Dependencies | Up to `5,000` tasks / `20,000` edges (SVG graph view renders up to `150` tasks) |
| Workers | `1` to `16` |
| Literal / Regex Patterns | Up to `20` literal patterns (`<= 256` bytes each) + `20` Thompson NFA regex patterns |
| Task & Workflow Logs | Up to `1 MB` per task, `5 MB` per workflow, scanned in `4,096`-byte chunks |
| Audit Payload | Up to `5 MB` (`POST /api/audit`) or `50 MB` (`POST /api/audit/stream`), up to `1,000` returned matches |
| Run Retention | Newest `20` runs per workflow |

---

## Notes & Scope

* **Sandboxed execution:** Task logs are provided text or generated streams rather than arbitrary OS shell commands, avoiding Remote Code Execution (RCE) exposure from the web UI while keeping chunked byte-stream scanning and `AbortController` cancellation authentic.
* **SQLite runtime note:** On Node 22.17, importing `node:sqlite` prints Node's standard `ExperimentalWarning: SQLite is an experimental feature` notice once on process startup.
* **Tests:** `npm test` runs 12 suites (82 tests) covering algorithm fuzzing against brute-force oracles, ReDoS linear-time bounds, iterative 5,000-node stack safety, live async cancellation, subgraph resume, SQLite migration, streaming file uploads, YAML/JSON import, and SARIF output.
