'use client';

export interface Series {
  name: string;
  color: string;
  points: { x: number; y: number }[];
}

const W = 560;
const H = 280;
const L = 62;
const R = 16;
const T = 14;
const B = 44;

function nice(max: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(max || 1)));
  const f = max / e;
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  return (steps.find((x) => f <= x + 1e-9) ?? 10) * e;
}

const compact = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(1)}`;

export default function LineChart({
  series,
  xLabel,
  yLabel,
}: {
  series: Series[];
  xLabel: string;
  yLabel: string;
}) {
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const xMax = Math.max(1, ...xs);
  const yMax = nice(Math.max(1, ...ys));
  const sx = (v: number) => L + (v / xMax) * (W - L - R);
  const sy = (v: number) => H - B - (v / yMax) * (H - T - B);
  const yTicks = Array.from({ length: 5 }, (_, i) => (yMax * i) / 4);
  const xTicks = Array.from({ length: 5 }, (_, i) => (xMax * i) / 4);
  return (
    <div>
      <div className="svgbox">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${yLabel} versus ${xLabel}`}>
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line className="gridline" x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} />
              <text className="tick" x={L - 8} y={sy(v) + 3} textAnchor="end">{compact(v)}</text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={`x${v}`} className="tick" x={sx(v)} y={H - B + 16} textAnchor="middle">{compact(v)}</text>
          ))}
          <line className="axis" x1={L} x2={W - R} y1={H - B} y2={H - B} />
          <line className="axis" x1={L} x2={L} y1={T} y2={H - B} />
          <text className="tick" x={(L + W - R) / 2} y={H - 8} textAnchor="middle">{xLabel}</text>
          <text className="tick" transform={`translate(12 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>
          {series.map((s) => (
            <g key={s.name}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={2.4}
                points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
              />
              {s.points.map((p, i) => (
                <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3.5} fill={s.color}>
                  <title>{`${s.name}: ${compact(p.y)} at ${compact(p.x)}`}</title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        {series.map((s) => (
          <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
    </div>
  );
}
