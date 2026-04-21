/**
 * ActivityTimeline — radial 24-hour arc chart showing activity buckets
 * as colour-coded segments around a circle. Builds a client-side history
 * ring from each poll tick so the visualisation grows richer over time.
 *
 * Centre displays the current activity label and focused-duration counter.
 */

import { useMemo } from 'react';
import { ACTIVITY_TONE, type Activity, type WorldState } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ArcSegment = {
  activity: Activity;
  startAngle: number; // degrees, 0 = top (12 o'clock)
  endAngle: number;
  confidence: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanDuration(secs: number): string {
  if (secs < 0) return '0s';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function hourToAngle(hour: number): number {
  return (hour / 24) * 360 - 90; // -90 so 0hr = top
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const startRad = (startDeg * Math.PI) / 180;
  const endRad = (endDeg * Math.PI) / 180;
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy + r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy + r * Math.sin(endRad);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

// Module-level history ring (mirrors BeliefCard pattern)
type HistoryEntry = { activity: Activity; hour: number; confidence: number };
let _activityHistory: HistoryEntry[] = [];
const MAX_ENTRIES = 96; // ~24min at 15s cadence

export function pushActivityHistory(w: WorldState): HistoryEntry[] {
  const d = new Date(w.timestamp_ms);
  const hour = d.getHours() + d.getMinutes() / 60;
  const conf = w.focus ? Math.min(1, w.focused_duration_secs / 120) : 0.3;
  const entry: HistoryEntry = { activity: w.activity, hour, confidence: conf };

  if (_activityHistory.length > 0) {
    const last = _activityHistory[_activityHistory.length - 1];
    if (Math.abs(last.hour - hour) < 0.004) return _activityHistory; // dedup
  }
  const next = [..._activityHistory, entry];
  _activityHistory = next.length > MAX_ENTRIES
    ? next.slice(next.length - MAX_ENTRIES)
    : next;
  return _activityHistory;
}

function buildArcs(history: ReadonlyArray<HistoryEntry>): ArcSegment[] {
  if (history.length < 2) return [];
  const arcs: ArcSegment[] = [];
  for (let i = 0; i < history.length - 1; i++) {
    const curr = history[i];
    const next = history[i + 1];
    arcs.push({
      activity: curr.activity,
      startAngle: hourToAngle(curr.hour),
      endAngle: hourToAngle(next.hour),
      confidence: curr.confidence,
    });
  }
  return arcs;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SIZE = 200;
const CX = SIZE / 2;
const CY = SIZE / 2;
const OUTER_R = 88;
const INNER_R = 68;
const STROKE = OUTER_R - INNER_R;

export function ActivityTimeline({
  world,
  history,
}: {
  world: WorldState;
  history: ReadonlyArray<HistoryEntry>;
}) {
  const arcs = useMemo(() => buildArcs(history), [history]);
  const now = new Date(world.timestamp_ms);
  const currentHourAngle = hourToAngle(now.getHours() + now.getMinutes() / 60);

  // Hour markers
  const hourMarkers = useMemo(() => {
    const markers: { x: number; y: number; label: string }[] = [];
    for (let h = 0; h < 24; h += 6) {
      const angle = hourToAngle(h);
      const rad = (angle * Math.PI) / 180;
      const r = OUTER_R + 10;
      markers.push({
        x: CX + r * Math.cos(rad),
        y: CY + r * Math.sin(rad),
        label: `${h}:00`,
      });
    }
    return markers;
  }, []);

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      }}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{ display: 'block' }}
      >
        {/* Background ring */}
        <circle
          cx={CX} cy={CY} r={(OUTER_R + INNER_R) / 2}
          fill="none"
          stroke="rgba(57, 229, 255, 0.06)"
          strokeWidth={STROKE}
        />

        {/* Tick marks for hours */}
        {Array.from({ length: 24 }).map((_, h) => {
          const angle = (hourToAngle(h) * Math.PI) / 180;
          const r1 = OUTER_R - 1;
          const r2 = h % 6 === 0 ? OUTER_R + 4 : OUTER_R + 1;
          return (
            <line
              key={h}
              x1={CX + r1 * Math.cos(angle)}
              y1={CY + r1 * Math.sin(angle)}
              x2={CX + r2 * Math.cos(angle)}
              y2={CY + r2 * Math.sin(angle)}
              stroke="rgba(57, 229, 255, 0.15)"
              strokeWidth={h % 6 === 0 ? 1.5 : 0.7}
            />
          );
        })}

        {/* Activity arcs */}
        {arcs.map((arc, i) => {
          const span = arc.endAngle - arc.startAngle;
          if (Math.abs(span) < 0.5) return null;
          const midR = (OUTER_R + INNER_R) / 2;
          const tone = ACTIVITY_TONE[arc.activity];
          return (
            <path
              key={i}
              d={describeArc(CX, CY, midR, arc.startAngle, arc.endAngle)}
              fill="none"
              stroke={`var(--${tone})`}
              strokeWidth={STROKE - 4}
              strokeLinecap="round"
              opacity={0.35 + arc.confidence * 0.6}
              style={{
                filter: `drop-shadow(0 0 3px var(--${tone}))`,
              }}
            >
              <title>{`${arc.activity} · ${Math.round(arc.confidence * 100)}%`}</title>
            </path>
          );
        })}

        {/* Now indicator — glowing dot on the outer ring */}
        {(() => {
          const rad = (currentHourAngle * Math.PI) / 180;
          const dotR = (OUTER_R + INNER_R) / 2;
          return (
            <circle
              cx={CX + dotR * Math.cos(rad)}
              cy={CY + dotR * Math.sin(rad)}
              r={4}
              fill="var(--cyan)"
              style={{
                filter: 'drop-shadow(0 0 6px var(--cyan))',
                animation: 'pulseDot 2s ease-in-out infinite',
              }}
            />
          );
        })()}

        {/* Hour labels */}
        {hourMarkers.map(m => (
          <text
            key={m.label}
            x={m.x} y={m.y}
            textAnchor="middle" dominantBaseline="central"
            style={{
              fontFamily: 'var(--mono)', fontSize: 8,
              fill: 'var(--ink-dim)', letterSpacing: '0.06em',
            }}
          >
            {m.label}
          </text>
        ))}

        {/* Centre text */}
        <text
          x={CX} y={CY - 10}
          textAnchor="middle" dominantBaseline="central"
          style={{
            fontFamily: 'var(--display)', fontSize: 10,
            fill: `var(--${ACTIVITY_TONE[world.activity]})`,
            letterSpacing: '0.2em', fontWeight: 700,
          }}
        >
          {world.activity.toUpperCase()}
        </text>
        <text
          x={CX} y={CY + 8}
          textAnchor="middle" dominantBaseline="central"
          style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            fill: 'var(--ink-dim)',
          }}
        >
          {humanDuration(world.focused_duration_secs)}
        </text>
      </svg>
    </div>
  );
}
