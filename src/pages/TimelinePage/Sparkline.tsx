/**
 * Sparkline — 24-bar activity histogram rendered as an SVG polyline.
 * Each bar represents one hour; bar height is proportional to event count.
 * Visually previews activity density before the user picks an hour.
 */

import type { EpisodicItem } from './api';

const HOURS = 24;
const HEIGHT = 28;
const WIDTH = 600; // viewBox units — scales freely
const BAR_W = WIDTH / HOURS;

type KindTone = {
  readonly kind: string;
  readonly color: string;
};

const KIND_TONES: ReadonlyArray<KindTone> = [
  { kind: 'user', color: 'var(--ink)' },
  { kind: 'agent_step', color: 'var(--violet)' },
  { kind: 'perception', color: 'var(--cyan)' },
  { kind: 'reflection', color: 'var(--pink)' },
  { kind: 'note', color: 'var(--gold)' },
  { kind: 'correction', color: 'var(--red)' },
  { kind: 'goal', color: 'var(--amber)' },
  { kind: 'tool_call', color: 'var(--teal)' },
  { kind: 'tool_result', color: 'var(--green)' },
  { kind: 'answer', color: 'var(--gold)' },
];

function kindColor(kind: string): string {
  return KIND_TONES.find(t => t.kind === kind)?.color ?? 'var(--cyan)';
}

export function Sparkline({
  items,
  dayStart,
  selectedHour,
  onPick,
}: {
  items: ReadonlyArray<EpisodicItem>;
  dayStart: number;
  selectedHour: number | null;
  onPick: (h: number) => void;
}) {
  // Build per-hour bucket counts
  const counts = Array.from({ length: HOURS }, (_, h) => {
    const hs = dayStart + h * 3600;
    const he = hs + 3600;
    return items.filter(r => r.created_at >= hs && r.created_at < he).length;
  });

  const max = Math.max(1, ...counts);

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        width="100%"
        height={HEIGHT}
        style={{ display: 'block', overflow: 'visible' }}
        aria-label="24-hour activity sparkline"
        role="img"
      >
        {counts.map((count, h) => {
          const barH = count === 0 ? 1 : Math.max(2, (count / max) * HEIGHT);
          const active = selectedHour === h;
          const items24 = items.filter(it => {
            const hour = Math.floor((it.created_at - dayStart) / 3600);
            return hour === h;
          });
          // Pick dominant kind color for bar
          const dominantKind = items24.length > 0 ? items24[0].kind : 'user';
          const color = count === 0 ? 'rgba(57,229,255,0.10)' : kindColor(dominantKind);
          return (
            <rect
              key={h}
              x={h * BAR_W + 0.5}
              y={HEIGHT - barH}
              width={BAR_W - 1}
              height={barH}
              fill={color}
              fillOpacity={active ? 1 : 0.55}
              stroke={active ? color : 'none'}
              strokeWidth={active ? 0.8 : 0}
              style={{ cursor: 'pointer', transition: 'fill-opacity 120ms' }}
              onClick={() => onPick(h)}
            >
              <title>{`${String(h).padStart(2, '0')}:00 · ${count} event${count !== 1 ? 's' : ''}`}</title>
            </rect>
          );
        })}
        {/* baseline */}
        <line x1={0} y1={HEIGHT} x2={WIDTH} y2={HEIGHT} stroke="rgba(57,229,255,0.14)" strokeWidth={0.6} />
      </svg>
    </div>
  );
}
