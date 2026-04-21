/**
 * 7 days × 24 hours heatmap grid.
 * Rows = days (today top), columns = hours 0–23.
 * Cell opacity scales with focused minutes logged in that slot.
 */

const DAY_LABELS = ['TODAY', 'YEST', '-2', '-3', '-4', '-5', '-6'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MAX_MINS = 60; // at or above this → full opacity

function opacityFor(mins: number): number {
  if (mins <= 0) return 0;
  return Math.min(1, 0.12 + (mins / MAX_MINS) * 0.88);
}

type Props = {
  /** matrix[dayIndex][hour] = focused minutes */
  matrix: ReadonlyArray<ReadonlyArray<number>>;
};

export function SessionHeatmap({ matrix }: Props) {
  void Math.max(1, ...matrix.flat());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Hour axis */}
      <div style={{ display: 'flex', marginLeft: 44 }}>
        {HOURS.map(h => (
          <div
            key={h}
            style={{
              flex: 1, textAlign: 'center',
              fontFamily: 'var(--mono)', fontSize: 7, color: 'var(--ink-dim)',
              opacity: h % 3 === 0 ? 1 : 0,
            }}
          >
            {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
          </div>
        ))}
      </div>

      {/* Day rows */}
      {matrix.map((row, dayIdx) => (
        <div key={dayIdx} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{
            width: 36, flexShrink: 0, textAlign: 'right',
            fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--ink-dim)',
            letterSpacing: '0.06em',
          }}>
            {DAY_LABELS[dayIdx]}
          </div>
          <div style={{ display: 'flex', flex: 1, gap: 1 }}>
            {row.map((mins, hour) => {
              const opacity = opacityFor(mins);
              return (
                <div
                  key={hour}
                  title={mins > 0 ? `${mins}m focused` : undefined}
                  style={{
                    flex: 1, height: 14, borderRadius: 1,
                    background: opacity > 0
                      ? `rgba(125, 255, 154, ${opacity})`
                      : 'rgba(125, 255, 154, 0.04)',
                    transition: 'background 200ms ease',
                  }}
                />
              );
            })}
          </div>
          <div style={{
            width: 28, flexShrink: 0,
            fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--ink-dim)',
            textAlign: 'right',
          }}>
            {row.reduce((a, b) => a + b, 0) > 0
              ? `${row.reduce((a, b) => a + b, 0)}m`
              : ''}
          </div>
        </div>
      ))}

      {/* Legend */}
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end',
        marginTop: 4,
        fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--ink-dim)',
      }}>
        <span>0m</span>
        {[0.12, 0.35, 0.6, 0.85, 1].map((op, i) => (
          <div key={i} style={{ width: 10, height: 10, borderRadius: 1, background: `rgba(125, 255, 154, ${op})` }} />
        ))}
        <span>{MAX_MINS}m+</span>
      </div>
    </div>
  );
}
