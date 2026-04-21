/**
 * ToolSparkline — tiny inline bar chart showing call rate per hour over
 * the last 24 buckets (where each bucket = 1 hour, derived from the 14d
 * daily data resampled client-side).
 *
 * Since the API only provides daily buckets, we produce a coarser estimate:
 * the average calls per day distributed uniformly across 24 bars. This is
 * a visual indicator of activity rhythm, not a precise histogram.
 *
 * When a per-tool hourly API lands, swap `points` construction in BrainPage.
 */

export function ToolSparkline({
  points,
  tone = 'cyan',
}: {
  /** Array of 1-24 normalised values 0..1, ordered oldest→newest. */
  points: ReadonlyArray<number>;
  tone?: 'cyan' | 'green' | 'amber' | 'violet' | 'red';
}) {
  if (points.length === 0) return null;
  const W = 64;
  const H = 18;
  const barW = Math.max(1, Math.floor((W - (points.length - 1)) / points.length));
  return (
    <svg
      width={W}
      height={H}
      style={{ display: 'block', overflow: 'visible', flexShrink: 0 }}
      aria-hidden
    >
      {points.map((v, i) => {
        const h = Math.max(1, v * (H - 1));
        const x = i * (barW + 1);
        const y = H - h;
        const opacity = 0.35 + (i / Math.max(1, points.length - 1)) * 0.65;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={h}
            fill={`var(--${tone})`}
            opacity={opacity}
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}
