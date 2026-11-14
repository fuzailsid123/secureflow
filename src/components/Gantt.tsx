'use client';
import { fmtMs } from '@/lib/format';
import type { Segment } from '@/lib/live';

const WIDTH = 940;
const LEFT = 64;
const ROW = 28;
const TOP = 8;

export default function Gantt({
  segments,
  workers,
  now,
  makespan,
}: {
  segments: Segment[];
  workers: number;
  now: number;
  makespan: number;
}) {
  const total = Math.max(1, makespan, now, ...segments.map((s) => s.end ?? s.start));
  const x = (t: number) => LEFT + (t / total) * (WIDTH - LEFT - 12);
  const height = TOP + workers * ROW + 30;
  const ticks = Array.from({ length: 6 }, (_, i) => (total * i) / 5);
  return (
    <div>
      <div className="svgbox">
        <svg width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Worker timeline">
          {ticks.map((t, i) => (
            <g key={t}>
              <line className="gridline" x1={x(t)} x2={x(t)} y1={TOP} y2={TOP + workers * ROW} />
              <text className="tick" x={x(t)} y={TOP + workers * ROW + 16} textAnchor={i === ticks.length - 1 ? 'end' : 'middle'}>
                {fmtMs(t)}
              </text>
            </g>
          ))}
          {Array.from({ length: workers }, (_, w) => (
            <text key={w} className="tick" x={LEFT - 10} y={TOP + w * ROW + ROW / 2 + 3} textAnchor="end">
              worker {w + 1}
            </text>
          ))}
          <line className="axis" x1={LEFT} x2={LEFT} y1={TOP} y2={TOP + workers * ROW} />
          {segments.map((s) => {
            const x1 = x(s.start);
            const x2 = x(s.end ?? now);
            const w = Math.max(2, x2 - x1);
            const y = TOP + s.worker * ROW + 3;
            return (
              <g key={`${s.taskId}-${s.start}`}>
                <title>{`${s.taskId}: ${fmtMs(s.start)} \u2192 ${s.end === null ? 'running' : fmtMs(s.end)} (${s.state})`}</title>
                <rect className={`bar-${s.state}`} x={x1} y={y} width={w} height={ROW - 6} rx={4} />
                {w > 46 && (
                  <text className="bar-label" x={x1 + 6} y={y + (ROW - 6) / 2 + 4}>
                    {s.taskId.length > Math.floor(w / 7) ? `${s.taskId.slice(0, Math.max(1, Math.floor(w / 7) - 1))}\u2026` : s.taskId}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        <span><i style={{ background: 'rgba(94,176,255,.55)' }} />running</span>
        <span><i style={{ background: 'rgba(61,220,151,.6)' }} />completed</span>
        <span><i style={{ background: 'rgba(255,107,107,.75)' }} />quarantined (stopped early)</span>
      </div>
    </div>
  );
}
