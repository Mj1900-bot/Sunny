/**
 * Last-100-turns per-turn latency sparkline.
 * Y-axis is log-scale: values are log10-transformed before plotting
 * so both 50ms and 15000ms turns coexist without the fast ones
 * collapsing to zero.
 */
import { useMemo } from 'react';
import type { TelemetryEvent } from './types';

type Props = {
  readonly events: ReadonlyArray<TelemetryEvent>;
};

const W = 300;
const H = 60;

function logScale(ms: number): number {
  return Math.log10(Math.max(1, ms));
}

export function LatencySparkline({ events }: Props) {
  const { d, area, yMin, yMax } = useMemo(() => {
    const last100 = events.slice(-100);
    if (last100.length < 2) {
      return { d: `M0,${H}`, area: `M0,${H} L${W},${H} Z`, yMin: 0, yMax: 0 };
    }
    const logVals = last100.map(e => logScale(e.duration_ms));
    const minV    = Math.min(...logVals);
    const maxV    = Math.max(...logVals);
    const range   = maxV - minV || 1;
    const dx      = W / (last100.length - 1);
    const pts     = logVals.map((v, i) => {
      const x = i * dx;
      const y = H - ((v - minV) / range) * (H - 4) - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return {
      d:    `M${pts.join(' L')}`,
      area: `M0,${H} L${pts.join(' L')} L${W},${H} Z`,
      yMin: Math.pow(10, minV),
      yMax: Math.pow(10, maxV),
    };
  }, [events]);

  if (events.length < 2) {
    return (
      <div style={{
        height: H + 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        border: '1px dashed var(--line-soft)',
      }}>
        NO LATENCY DATA YET
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height={H}
        style={{ display: 'block', overflow: 'visible' }}
        role="img"
        aria-label="Per-turn latency sparkline (log scale)"
      >
        <path d={area} fill="rgba(57,229,255,0.06)" stroke="none" />
        <path d={d} fill="none" stroke="var(--cyan)" strokeWidth={1.5}
          strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {/* Y-axis labels */}
      <div style={{
        position: 'absolute', top: 0, right: 0,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        height: H, pointerEvents: 'none',
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)' }}>
          {yMax >= 1000 ? `${(yMax / 1000).toFixed(1)}s` : `${Math.round(yMax)}ms`}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)' }}>
          {yMin >= 1000 ? `${(yMin / 1000).toFixed(1)}s` : `${Math.round(yMin)}ms`}
        </span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
        marginTop: 3,
      }}>
        <span>-{Math.min(events.length, 100)} turns</span>
        <span>now</span>
      </div>
    </div>
  );
}
