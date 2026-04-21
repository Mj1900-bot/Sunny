/**
 * Minimal inline-SVG donut chart for model distribution.
 * No chart library — pure SVG path arcs.
 */
import { useMemo } from 'react';
import type { ModelSlice } from './types';

type Props = {
  readonly slices: ReadonlyArray<ModelSlice>;
};

const SIZE  = 120;
const R     = 44;
const CX    = SIZE / 2;
const CY    = SIZE / 2;
const STROKE = 18;

function polarToXY(angleDeg: number, r: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

function arcPath(startDeg: number, endDeg: number, r: number): string {
  const [sx, sy] = polarToXY(startDeg, r);
  const [ex, ey] = polarToXY(endDeg, r);
  const large     = endDeg - startDeg > 180 ? 1 : 0;
  return `M${sx.toFixed(2)},${sy.toFixed(2)} A${r},${r} 0 ${large} 1 ${ex.toFixed(2)},${ey.toFixed(2)}`;
}

export function DonutChart({ slices }: Props) {
  const arcs = useMemo(() => {
    let offset = 0;
    return slices.map(s => {
      const sweep = (s.pct / 100) * 360;
      const path  = arcPath(offset, offset + sweep, R);
      const result = { ...s, path };
      offset += sweep;
      return result;
    });
  }, [slices]);

  if (slices.length === 0) {
    return (
      <div style={{
        width: SIZE, height: SIZE, display: 'flex', alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        border: '1px dashed var(--line-soft)',
      }}>
        NO DATA
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
      <svg width={SIZE} height={SIZE} role="img" aria-label="Model distribution donut chart">
        {/* Track */}
        <circle cx={CX} cy={CY} r={R} fill="none"
          stroke="rgba(57,229,255,0.07)" strokeWidth={STROKE} />
        {/* Arcs */}
        {arcs.map(a => (
          <path
            key={a.label}
            d={a.path}
            fill="none"
            stroke={a.color}
            strokeWidth={STROKE}
            strokeLinecap="butt"
            opacity={0.85}
          />
        ))}
        {/* Centre label */}
        <text
          x={CX} y={CY - 5}
          textAnchor="middle"
          fontFamily="var(--display)"
          fontSize={9}
          fill="var(--ink-2)"
          letterSpacing="0.15em"
        >MODELS</text>
        <text
          x={CX} y={CY + 9}
          textAnchor="middle"
          fontFamily="var(--mono)"
          fontSize={11}
          fill="var(--ink)"
          fontWeight="600"
        >{slices.reduce((s, a) => s + a.count, 0)}</text>
      </svg>

      {/* Legend */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 6 }}>
        {arcs.map(a => (
          <div key={a.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: 1, background: a.color, flexShrink: 0 }} />
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink)',
              maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }} title={a.label}>
              {a.label}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', marginLeft: 2 }}>
              {a.count} · {a.pct}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
