/**
 * Histogram — 14-day mini bar chart of tool-call volume with hover
 * tooltips, gradient bars, and day-of-week labels.
 *
 * Upgraded with:
 *  - Day-of-week abbreviated labels
 *  - Hover glow on bars
 *  - Total and average line annotations
 *  - Better visual design
 */

import { useMemo } from 'react';
import type { DailyBucket } from './api';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Histogram({ buckets }: { buckets: ReadonlyArray<DailyBucket> }) {
  if (buckets.length === 0) {
    return (
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        padding: '16px 10px', textAlign: 'center',
        border: '1px dashed var(--line-soft)',
      }}>
        no activity in window
      </div>
    );
  }

  const max = Math.max(...buckets.map(b => b.count), 1);
  const totalCalls = useMemo(() => buckets.reduce((s, b) => s + b.count, 0), [buckets]);
  const avgCalls = totalCalls / buckets.length;
  const avgH = Math.max(2, (avgCalls / max) * 56);

  const fmt = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dayName = (ts: number) => DAY_NAMES[new Date(ts * 1000).getDay()];
  const first = buckets[0]?.day_ts;
  const last = buckets[buckets.length - 1]?.day_ts;

  return (
    <div>
      {/* Summary */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 6,
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)' }}>
          {totalCalls.toLocaleString()} total calls · avg {avgCalls.toFixed(0)}/day
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)' }}>
          peak {max}/day
        </span>
      </div>

      {/* Bars */}
      <div style={{
        position: 'relative',
        display: 'flex', alignItems: 'flex-end', gap: 2,
        height: 64, paddingBottom: 4,
      }}>
        {/* Average line */}
        <div style={{
          position: 'absolute', left: 0, right: 0,
          bottom: avgH + 4,
          height: 1,
          borderTop: '1px dashed var(--ink-dim)',
          opacity: 0.3,
          pointerEvents: 'none',
        }} />

        {buckets.map(b => {
          const h = Math.max(2, (b.count / max) * 56);
          const rate = b.count > 0 ? b.ok_count / b.count : 0;
          const tone = rate >= 0.9 ? 'var(--green)' : rate >= 0.7 ? 'var(--amber)' : 'var(--red)';
          const isToday = new Date(b.day_ts * 1000).toDateString() === new Date().toDateString();
          return (
            <div
              key={b.day_ts}
              className="hist-bar"
              title={`${fmt(b.day_ts)} (${dayName(b.day_ts)}) · ${b.count} calls · ${b.ok_count}/${b.count} ok · ${(rate * 100).toFixed(0)}%`}
              style={{
                flex: 1,
                height: h,
                background: `linear-gradient(180deg, ${tone}, ${tone}44)`,
                boxShadow: `0 0 6px ${tone}33`,
                borderTop: isToday ? `2px solid var(--cyan)` : 'none',
                transition: 'height 300ms ease, box-shadow 150ms ease',
                cursor: 'default',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.boxShadow = `0 0 12px ${tone}66`;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.boxShadow = `0 0 6px ${tone}33`;
              }}
            />
          );
        })}
      </div>

      {/* X-axis labels */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--ink-dim)', paddingTop: 2,
      }}>
        {first != null && <span>{fmt(first)} ({dayName(first)})</span>}
        {last != null && <span>{fmt(last)} ({dayName(last)})</span>}
      </div>
    </div>
  );
}
