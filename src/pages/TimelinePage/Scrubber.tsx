import type { EpisodicItem, EpisodicKind } from './api';

/** Tick colours follow the R10 spec where kinds exist in the type union:
 *  perception=cyan, agent_step=violet, user=white, note/answer=gold.
 *  (Backend doesn't emit tool_call/tool_result/answer yet — see report.) */
const KIND_TONE: Record<EpisodicKind, string> = {
  user: 'var(--ink)',
  agent_step: 'var(--violet)',
  perception: 'var(--cyan)',
  reflection: 'var(--pink)',
  note: 'var(--gold)',
  correction: 'var(--red)',
  goal: 'var(--amber)',
  tool_call: 'var(--amber)',
  tool_result: 'var(--green)',
  answer: 'var(--gold)',
};

/** Horizontal density scrubber — each vertical tick is an episodic row.
 *  Hovering reveals the row's time + kind. Clicking a background hour cell
 *  emits `onPick(hour)`; clicking an individual tick emits `onPickRow(id)`
 *  so the detail panel can focus that exact row. Keyboard: Left/Right
 *  arrows on a focused hour cell move the hour filter. */
export function Scrubber({
  items, dayStart, dayEnd, onPick, onPickRow, selectedHour,
}: {
  items: ReadonlyArray<EpisodicItem>;
  dayStart: number;
  dayEnd: number;
  onPick: (hourLocal: number) => void;
  onPickRow?: (id: string) => void;
  selectedHour?: number | null;
}) {
  const duration = Math.max(1, dayEnd - dayStart);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowPct = ((nowSec - dayStart) / duration) * 100;
  const showNow = nowPct >= 0 && nowPct <= 100;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          position: 'relative',
          height: 56,
          border: '1px solid var(--line-soft)',
          background: 'linear-gradient(180deg, rgba(57, 229, 255, 0.04), transparent)',
        }}
      >
        {/* Hour grid */}
        {[0, 3, 6, 9, 12, 15, 18, 21].map(h => (
          <div key={h} style={{
            position: 'absolute',
            left: `${(h / 24) * 100}%`, top: 0, bottom: 0,
            width: 1, background: 'rgba(57, 229, 255, 0.12)',
          }} />
        ))}
        {/* Now marker */}
        {showNow && (
          <div
            title="now"
            style={{
              position: 'absolute',
              left: `${nowPct}%`, top: -2, bottom: -2,
              width: 1.5, background: 'var(--gold)',
              boxShadow: '0 0 8px var(--gold)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        )}
        {/* Clickable hour cells (background — keyboard navigable) */}
        {Array.from({ length: 24 }).map((_, h) => {
          const active = selectedHour === h;
          return (
            <button
              key={h}
              onClick={() => onPick(h)}
              onKeyDown={e => {
                if (e.key === 'ArrowRight') { e.preventDefault(); onPick(Math.min(23, h + 1)); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); onPick(Math.max(0, h - 1)); }
              }}
              aria-label={`Focus hour ${h.toString().padStart(2, '0')}:00`}
              aria-pressed={active}
              title={`${h.toString().padStart(2, '0')}:00`}
              style={{
                all: 'unset', cursor: 'pointer',
                position: 'absolute',
                left: `${(h / 24) * 100}%`, top: 0, bottom: 0,
                width: `${100 / 24}%`,
                background: active ? 'rgba(57, 229, 255, 0.10)' : 'transparent',
              }}
            />
          );
        })}
        {/* Event ticks — clickable when onPickRow is provided. */}
        {items.map(it => {
          const pct = ((it.created_at - dayStart) / duration) * 100;
          if (pct < 0 || pct > 100) return null;
          const color = KIND_TONE[it.kind] ?? 'var(--cyan)';
          const label = `${new Date(it.created_at * 1000).toLocaleTimeString()} · ${it.kind}`;
          return (
            <button
              key={it.id}
              onClick={e => { e.stopPropagation(); onPickRow?.(it.id); }}
              title={label}
              aria-label={label}
              style={{
                all: 'unset', cursor: onPickRow ? 'pointer' : 'default',
                position: 'absolute',
                left: `${pct}%`, top: 10, bottom: 10, width: 2,
                background: color,
                boxShadow: `0 0 4px ${color}`,
              }}
            />
          );
        })}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.08em',
      }}>
        {[0, 6, 12, 18, 24].map(h => (
          <span key={h}>{h.toString().padStart(2, '0')}:00</span>
        ))}
      </div>
    </div>
  );
}
