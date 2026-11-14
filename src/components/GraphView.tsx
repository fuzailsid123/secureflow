'use client';
import { LIMITS } from '@/lib/limits';
import type { Edge, TaskState } from '@/lib/types';

const W = 150;
const H = 34;
const GX = 58;
const GY = 18;
const PAD = 16;
const LANE = 7;
const MAX_LANES = 12;

interface Props {
  ids: string[];
  edges: Edge[];
  /** Topological levels (columns). Null when the graph has a cycle. */
  levels: string[][] | null;
  /** The exact cycle (first id repeated at the end), when there is one. */
  cycle: string[] | null;
  states: Record<string, TaskState>;
  onSelectTask?: (id: string) => void;
}

/** One-pass barycenter ordering within topological levels to reduce edge crossings. */
function orderLevelsByBarycenter(levels: string[][], edges: Edge[]): string[][] {
  if (levels.length <= 1) return levels;
  const preds = new Map<string, string[]>();
  for (const [a, b] of edges) {
    const arr = preds.get(b);
    if (arr) arr.push(a);
    else preds.set(b, [a]);
  }
  const ordered: string[][] = [levels[0].slice()];
  const rowIndex = new Map<string, number>();
  ordered[0].forEach((id, i) => rowIndex.set(id, i));

  for (let li = 1; li < levels.length; li++) {
    const cur = levels[li].map((id, origIdx) => {
      const ps = preds.get(id);
      if (!ps || ps.length === 0) return { id, score: origIdx, origIdx };
      let sum = 0;
      let cnt = 0;
      for (const p of ps) {
        const r = rowIndex.get(p);
        if (r !== undefined) {
          sum += r;
          cnt++;
        }
      }
      return { id, score: cnt > 0 ? sum / cnt : origIdx, origIdx };
    });
    cur.sort((a, b) => a.score - b.score || a.origIdx - b.origIdx);
    const layer = cur.map((x) => x.id);
    layer.forEach((id, i) => rowIndex.set(id, i));
    ordered.push(layer);
  }
  return ordered;
}

export default function GraphView({ ids, edges, levels, cycle, states, onSelectTask }: Props) {
  if (ids.length === 0) return <div className="empty">Add tasks to see the dependency graph.</div>;
  if (ids.length > LIMITS.maxGraphRenderTasks) {
    return (
      <div className="empty">
        Graph view is limited to {LIMITS.maxGraphRenderTasks} tasks ({ids.length} in this workflow). Scheduling and runs
        still work.
      </div>
    );
  }

  const orderedLevels = levels ? orderLevelsByBarycenter(levels, edges) : null;
  const pos = new Map<string, { x: number; y: number }>();
  const levelOf = new Map<string, number>();
  if (orderedLevels) orderedLevels.forEach((lv, li) => lv.forEach((id) => levelOf.set(id, li)));

  const isLong = (a: string, b: string) =>
    orderedLevels !== null && a !== b && (levelOf.get(b) ?? 0) - (levelOf.get(a) ?? 0) > 1;
  const longCount = orderedLevels ? edges.filter(([a, b]) => isLong(a, b)).length : 0;
  const lanes = Math.min(longCount, MAX_LANES);
  const topPad = PAD + (lanes > 0 ? lanes * LANE + 8 : 0);

  let width: number;
  let height: number;
  if (orderedLevels) {
    orderedLevels.forEach((lv, li) =>
      lv.forEach((id, ri) => pos.set(id, { x: PAD + li * (W + GX), y: topPad + ri * (H + GY) })),
    );
    width = PAD * 2 + orderedLevels.length * (W + GX) - GX;
    height = topPad + PAD + Math.max(...orderedLevels.map((l) => l.length)) * (H + GY) - GY;
  } else {
    const n = ids.length;
    const rx = Math.max(150, (n * (W + 30)) / (2 * Math.PI));
    const ry = Math.max(95, (n * (H + 30)) / (2 * Math.PI) + 45);
    const cx = rx + W / 2 + PAD;
    const cy = ry + H / 2 + PAD;
    ids.forEach((id, i) => {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      pos.set(id, { x: cx + rx * Math.cos(a) - W / 2, y: cy + ry * Math.sin(a) - H / 2 });
    });
    width = Math.ceil(cx * 2);
    height = Math.ceil(cy * 2);
  }

  const cycleEdges = new Set<string>();
  const cycleNodes = new Set<string>();
  if (cycle) {
    for (let i = 0; i < cycle.length - 1; i++) cycleEdges.add(`${cycle[i]}>${cycle[i + 1]}`);
    cycle.forEach((c) => cycleNodes.add(c));
  }

  let laneIdx = 0;
  return (
    <div className="svgbox">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Task dependency graph">
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#5a7099" />
          </marker>
          <marker id="arr-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#ff6b6b" />
          </marker>
        </defs>
        {edges.map(([a, b], i) => {
          const p = pos.get(a);
          const q = pos.get(b);
          if (!p || !q) return null;
          const bad = cycleEdges.has(`${a}>${b}`);
          const cls = bad ? 'edge-cycle' : 'edge';
          const mk = `url(#${bad ? 'arr-red' : 'arr'})`;
          if (a === b) {
            const x = p.x + W / 2;
            const y = p.y;
            return (
              <path
                key={i}
                className={cls}
                markerEnd={mk}
                d={`M${x - 14} ${y} C ${x - 30} ${y - 34}, ${x + 30} ${y - 34}, ${x + 14} ${y}`}
              />
            );
          }
          if (orderedLevels) {
            const x1 = p.x + W;
            const y1 = p.y + H / 2;
            const x2 = q.x;
            const y2 = q.y + H / 2;
            if (isLong(a, b)) {
              const laneY = PAD / 2 + 4 + (laneIdx++ % MAX_LANES) * LANE;
              const g1 = x1 + 22;
              const g2 = x2 - 22;
              return (
                <path
                  key={i}
                  className={cls}
                  markerEnd={mk}
                  d={`M${x1} ${y1} H${g1 - 8} Q${g1} ${y1} ${g1} ${y1 - 8} V${laneY + 8} Q${g1} ${laneY} ${g1 + 8} ${laneY} H${g2 - 8} Q${g2} ${laneY} ${g2} ${laneY + 8} V${y2 - 8} Q${g2} ${y2} ${g2 + 8} ${y2} H${x2}`}
                />
              );
            }
            const dx = Math.max(24, (x2 - x1) / 2);
            return <path key={i} className={cls} markerEnd={mk} d={`M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`} />;
          }
          const x1 = p.x + W / 2;
          const y1 = p.y + H / 2;
          const x2 = q.x + W / 2;
          const y2 = q.y + H / 2;
          const len = Math.hypot(x2 - x1, y2 - y1) || 1;
          const ux = (x2 - x1) / len;
          const uy = (y2 - y1) / len;
          const t = Math.min((W / 2 + 3) / Math.max(Math.abs(ux), 1e-6), (H / 2 + 3) / Math.max(Math.abs(uy), 1e-6));
          const sx = x1 + ux * t;
          const sy = y1 + uy * t;
          const ex = x2 - ux * t;
          const ey = y2 - uy * t;
          return <path key={i} className={cls} markerEnd={mk} d={`M${sx} ${sy} L${ex} ${ey}`} />;
        })}
        {ids.map((id) => {
          const p = pos.get(id);
          if (!p) return null;
          const st = states[id];
          const cls = st ? `node node-${st}` : cycleNodes.has(id) ? 'node node-incycle' : 'node';
          const label = id.length > 18 ? `${id.slice(0, 17)}\u2026` : id;
          return (
            <g
              key={id}
              className={cls}
              transform={`translate(${p.x} ${p.y})`}
              onClick={onSelectTask ? () => onSelectTask(id) : undefined}
              style={onSelectTask ? { cursor: 'pointer' } : undefined}
            >
              <title>{`${id}${st ? ` (${st})` : ''}`}</title>
              <rect className="underlay" width={W} height={H} rx={8} />
              <rect width={W} height={H} rx={8} />
              <text x={W / 2} y={H / 2 + 4} textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
