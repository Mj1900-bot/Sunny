/**
 * FocusHeatmap — a compact grid of coloured blocks showing relative
 * time spent in each app, derived from `recent_switches`. Each cell's
 * opacity reflects dwell-time intensity.
 */

import { useMemo } from 'react';
import type { AppSwitch } from './types';

type AppDwell = {
  app: string;
  seconds: number;
  fraction: number; // 0..1 relative to longest
};

function deriveDwell(switches: ReadonlyArray<AppSwitch>): AppDwell[] {
  if (switches.length < 2) {
    if (switches.length === 1) {
      return [{ app: switches[0].to_app, seconds: 1, fraction: 1 }];
    }
    return [];
  }

  const map = new Map<string, number>();

  // Switches are newest-first. Walk backwards for chronological order.
  for (let i = switches.length - 1; i > 0; i--) {
    const curr = switches[i];
    const next = switches[i - 1];
    const dt = Math.max(0, next.at_secs - curr.at_secs);
    map.set(curr.to_app, (map.get(curr.to_app) ?? 0) + dt);
  }
  // Last switch — add a nominal 15s (can't know real duration)
  const last = switches[0];
  map.set(last.to_app, (map.get(last.to_app) ?? 0) + 15);

  const entries = Array.from(map.entries())
    .map(([app, seconds]) => ({ app, seconds, fraction: 0 }))
    .sort((a, b) => b.seconds - a.seconds);

  const maxSec = Math.max(1, entries[0]?.seconds ?? 1);
  for (const e of entries) {
    e.fraction = e.seconds / maxSec;
  }
  return entries;
}

function formatDwell(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

// Deterministic hue from app name
function appHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export function FocusHeatmap({ switches }: { switches: ReadonlyArray<AppSwitch> }) {
  const data = useMemo(() => deriveDwell(switches), [switches]);

  if (data.length === 0) {
    return (
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        padding: '12px 0', textAlign: 'center',
      }}>
        No switch data yet — heatmap will build as you work.
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${Math.min(data.length, 4)}, 1fr)`,
      gap: 6,
    }}>
      {data.slice(0, 8).map(d => {
        const hue = appHue(d.app);
        const bg = `hsla(${hue}, 70%, 55%, ${0.08 + d.fraction * 0.22})`;
        const border = `hsla(${hue}, 70%, 55%, ${0.2 + d.fraction * 0.5})`;
        const glow = `0 0 ${Math.round(d.fraction * 8)}px hsla(${hue}, 70%, 55%, ${d.fraction * 0.4})`;
        return (
          <div
            key={d.app}
            title={`${d.app} · ${formatDwell(d.seconds)}`}
            style={{
              padding: '10px 8px',
              background: bg,
              border: `1px solid ${border}`,
              boxShadow: glow,
              display: 'flex', flexDirection: 'column', gap: 3,
              transition: 'box-shadow 300ms ease, background 300ms ease',
              cursor: 'default',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = `hsla(${hue}, 70%, 55%, ${0.12 + d.fraction * 0.28})`;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = bg;
            }}
          >
            <span style={{
              fontFamily: 'var(--label)', fontSize: 11, fontWeight: 600,
              color: `hsla(${hue}, 70%, 75%, 1)`,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {d.app}
            </span>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9,
              color: 'var(--ink-dim)',
            }}>
              {formatDwell(d.seconds)}
            </span>
            {/* Intensity bar */}
            <div style={{
              height: 3, background: 'rgba(255,255,255,0.06)',
              overflow: 'hidden', marginTop: 2,
            }}>
              <div style={{
                height: '100%',
                width: `${Math.round(d.fraction * 100)}%`,
                background: `hsla(${hue}, 70%, 55%, 0.7)`,
                boxShadow: `0 0 4px hsla(${hue}, 70%, 55%, 0.5)`,
                transition: 'width 400ms ease',
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
