import type { CSSProperties, JSX } from 'react';

/**
 * Minimal inline-SVG sparkline — two stacked polylines.
 *
 * Design choices:
 *   • **No external dep.** SVG path math is simple enough that pulling
 *     in a charting library would cost kilobytes for no real benefit.
 *   • **Two series per sparkline**: total calls (subtle) + successes
 *     (foreground green). The ratio is visible at a glance — no legend
 *     needed because the colours repeat the Tools-tab conventions.
 *   • **Fixed width/height**: renders cleanly inside a table row,
 *     doesn't reflow when data points change.
 *   • **Zero-days rendered as zeros**: caller pads with zero-count
 *     DailyBuckets so every sparkline is the same width regardless of
 *     how sparsely the tool was invoked.
 *   • **Empty series → greyed bar** instead of a collapsed path so rows
 *     without data still line up in the layout.
 */

export type SparklinePoint = {
  /** Day bucket (unix seconds, midnight-aligned). */
  readonly day_ts: number;
  readonly count: number;
  readonly ok_count: number;
};

type Props = {
  readonly points: ReadonlyArray<SparklinePoint>;
  readonly width?: number;
  readonly height?: number;
  /** Optional title (accessibility + tooltip). */
  readonly title?: string;
};

const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 22;

export function Sparkline({
  points,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  title,
}: Props): JSX.Element {
  if (points.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={title ?? 'no data'}
        style={baseSvgStyle}
      >
        <line
          x1={0}
          x2={width}
          y1={height - 2}
          y2={height - 2}
          stroke="var(--line-soft)"
          strokeWidth={1}
        />
      </svg>
    );
  }

  // Max count across all buckets sets the vertical scale. If every bucket
  // is zero we'd divide by zero; the early-return above handles empty,
  // and max < 1 → use 1 so the line sits at the baseline cleanly.
  const maxCount = Math.max(1, ...points.map(p => p.count));

  const stepX = points.length <= 1 ? width : width / Math.max(1, points.length - 1);

  const project = (i: number, value: number): [number, number] => {
    const x = i * stepX;
    const y = height - 2 - (value / maxCount) * (height - 4);
    return [x, y];
  };

  const countPath = points
    .map((p, i) => {
      const [x, y] = project(i, p.count);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const okPath = points
    .map((p, i) => {
      const [x, y] = project(i, p.ok_count);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const total = points.reduce((sum, p) => sum + p.count, 0);
  const totalOk = points.reduce((sum, p) => sum + p.ok_count, 0);
  const label =
    title ?? `${totalOk}/${total} ok across ${points.length} days`;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={label}
      style={baseSvgStyle}
    >
      <title>{label}</title>
      {/* Baseline for visual anchor */}
      <line
        x1={0}
        x2={width}
        y1={height - 2}
        y2={height - 2}
        stroke="var(--line-soft)"
        strokeWidth={1}
        opacity={0.4}
      />
      {/* Calls (background) */}
      <path
        d={countPath}
        fill="none"
        stroke="var(--ink-dim)"
        strokeWidth={1}
        opacity={0.65}
      />
      {/* Successes (foreground) — drawn on top with a fatter stroke so
          the trend is legible even on a 22-pixel tall canvas */}
      <path
        d={okPath}
        fill="none"
        stroke="var(--green)"
        strokeWidth={1.5}
      />
    </svg>
  );
}

const baseSvgStyle: CSSProperties = {
  display: 'block',
  overflow: 'visible',
};

// ---------------------------------------------------------------------------
// Padding helper — fills zero-count days so the sparkline renders at a
// stable width regardless of data density. Called by ToolsTab after
// fetching `tool_usage_daily_buckets`.
// ---------------------------------------------------------------------------

/**
 * Densify a sparse day-bucket series. Pads missing days with
 * `{count: 0, ok_count: 0}` so the resulting array has exactly `days`
 * entries ending at `end_day_ts` (midnight-aligned). Caller gets a
 * stable-width sparkline.
 */
export function padBuckets(
  raw: ReadonlyArray<SparklinePoint>,
  days: number,
  endDayTs: number,
): SparklinePoint[] {
  const dayMap = new Map<number, SparklinePoint>();
  for (const p of raw) dayMap.set(p.day_ts, p);
  const out: SparklinePoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const ts = endDayTs - i * 86_400;
    const hit = dayMap.get(ts);
    out.push(hit ?? { day_ts: ts, count: 0, ok_count: 0 });
  }
  return out;
}

/** Midnight-align a unix-seconds timestamp (UTC-aligned; matches the
 *  Rust `(created_at / 86400) * 86400` bucketing). */
export function alignToDay(tsSecs: number): number {
  return Math.floor(tsSecs / 86_400) * 86_400;
}
