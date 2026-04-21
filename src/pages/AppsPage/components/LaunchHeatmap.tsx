/**
 * LaunchHeatmap — 7-day × 24-hour activity grid shown at the top of AppsPage.
 *
 * Grid layout: columns = 24 hours (0–23), rows = 7 days (oldest top → today bottom).
 * Cell color intensity maps linearly from 0 → peak, using var(--cyan) at full opacity.
 * Compact: 24 × 7 = 168 cells, each 8 × 8 px with 1 px gap = 184 × 64 px rendered area.
 */
import { useMemo } from 'react';
import type { CSSProperties } from 'react';

type Props = {
  /** Flat 168-element grid from buildHeatmap(). */
  readonly grid: readonly number[];
};

const DAYS = ['7d', '6d', '5d', '4d', '3d', '2d', '1d'];
const CELL = 8;
const GAP = 1;

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '10px 2px 6px',
};

const labelRowStyle: CSSProperties = {
  display: 'flex',
  gap: GAP,
  fontFamily: 'var(--mono)',
  fontSize: 8,
  letterSpacing: '0.04em',
  color: 'var(--ink-dim)',
  paddingLeft: 28,
  marginBottom: 2,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP,
};

const dayLabelStyle: CSSProperties = {
  width: 24,
  fontFamily: 'var(--mono)',
  fontSize: 8,
  color: 'var(--ink-dim)',
  letterSpacing: '0.06em',
  textAlign: 'right',
  flexShrink: 0,
};

export function LaunchHeatmap({ grid }: Props) {
  const peak = useMemo(() => Math.max(1, ...grid), [grid]);

  const cells = useMemo(() => {
    return Array.from({ length: 7 }, (_, dayIdx) =>
      Array.from({ length: 24 }, (__, hourIdx) => {
        const count = grid[dayIdx * 24 + hourIdx] ?? 0;
        const intensity = count / peak;
        return { count, intensity };
      }),
    );
  }, [grid, peak]);

  const totalLaunches = useMemo(() => grid.reduce((s, v) => s + v, 0), [grid]);

  if (totalLaunches === 0) return null;

  return (
    <div style={wrapStyle}>
      <div style={labelRowStyle}>
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} style={{ width: CELL, textAlign: 'center', flexShrink: 0 }}>
            {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
          </div>
        ))}
      </div>
      {cells.map((row, dayIdx) => (
        <div key={dayIdx} style={rowStyle}>
          <span style={dayLabelStyle}>{DAYS[dayIdx]}</span>
          {row.map(({ count, intensity }, hourIdx) => (
            <div
              key={hourIdx}
              title={count > 0 ? `${count} launch${count === 1 ? '' : 'es'}` : undefined}
              style={{
                width: CELL,
                height: CELL,
                flexShrink: 0,
                background:
                  count === 0
                    ? 'rgba(57, 229, 255, 0.04)'
                    : `rgba(57, 229, 255, ${0.12 + intensity * 0.78})`,
                border: '1px solid rgba(57, 229, 255, 0.1)',
                transition: 'background 0.2s ease',
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
