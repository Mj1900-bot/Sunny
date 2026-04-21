import type { CalEvent } from '../types';
import { toISO, buildMonthGrid } from '../utils';

type Props = {
  anchor: Date;
  todayISO: string;
  selectedISO: string;
  eventsByDay: Map<string, CalEvent[]>;
  onSelectISO: (iso: string) => void;
};

export function CalendarMiniMap({ anchor, todayISO, selectedISO, eventsByDay, onSelectISO }: Props) {
  const grid = buildMonthGrid(anchor);
  const weekDayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const CELL = 14;
  const GAP = 2;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '8px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.55)',
        userSelect: 'none',
        width: 'fit-content',
      }}
    >
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: '0.18em',
        color: 'var(--cyan)', marginBottom: 3,
      }}>
        MINI-MAP
      </div>

      {/* weekday headers */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(7, ${CELL}px)`, gap: GAP }}>
        {weekDayLabels.map((l, i) => (
          <div
            key={i}
            style={{
              width: CELL, textAlign: 'center',
              fontFamily: 'var(--mono)', fontSize: 7,
              color: 'var(--ink-dim)', letterSpacing: '0.08em',
            }}
          >
            {l}
          </div>
        ))}
      </div>

      {/* 6-week grid */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(7, ${CELL}px)`, gap: GAP }}>
        {grid.map(d => {
          const iso = toISO(d);
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = iso === todayISO;
          const isSelected = iso === selectedISO;
          const hasEvents = (eventsByDay.get(iso)?.length ?? 0) > 0;

          return (
            <button
              key={iso}
              onClick={() => onSelectISO(iso)}
              title={iso}
              style={{
                all: 'unset',
                cursor: 'pointer',
                width: CELL,
                height: CELL,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--mono)',
                fontSize: 7,
                color: isToday
                  ? 'var(--cyan)'
                  : isSelected
                    ? 'var(--amber)'
                    : inMonth
                      ? 'var(--ink-2)'
                      : 'var(--ink-dim)',
                background: isSelected
                  ? 'rgba(245, 166, 35, 0.25)'
                  : isToday
                    ? 'rgba(57, 229, 255, 0.18)'
                    : 'transparent',
                border: isToday
                  ? '1px solid var(--cyan)'
                  : isSelected
                    ? '1px solid var(--amber)'
                    : '1px solid transparent',
                opacity: inMonth ? 1 : 0.35,
                position: 'relative',
                boxSizing: 'border-box',
              }}
            >
              {d.getDate()}
              {hasEvents && !isSelected && !isToday && (
                <span style={{
                  position: 'absolute',
                  bottom: 1, right: 1,
                  width: 3, height: 3,
                  borderRadius: '50%',
                  background: 'var(--cyan)',
                  opacity: 0.7,
                }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
