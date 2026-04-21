import { useRef, useState, type CSSProperties } from 'react';
import type { CalEvent } from '../types';
import { WEEKDAYS } from '../constants';
import { toISO, toneColor, calendarColor } from '../utils';
import { EventHoverCard } from './EventHoverCard';

type Props = {
  grid: ReadonlyArray<Date>;
  anchor: Date;
  todayISO: string;
  selectedISO: string;
  eventsByDay: Map<string, CalEvent[]>;
  onSelect: (iso: string) => void;
  onQuickCreate: (dayISO: string, startHour: number, endHour: number) => void;
};

function hasAnyConflict(dayEvents: CalEvent[]): boolean {
  for (let i = 0; i < dayEvents.length; i++) {
    const a = dayEvents[i];
    if (!a.startISO || !a.endISO) continue;
    const aS = new Date(a.startISO).getTime();
    const aE = new Date(a.endISO).getTime();
    for (let j = i + 1; j < dayEvents.length; j++) {
      const b = dayEvents[j];
      if (!b.startISO || !b.endISO) continue;
      const bS = new Date(b.startISO).getTime();
      const bE = new Date(b.endISO).getTime();
      if (aS < bE && aE > bS) return true;
    }
  }
  return false;
}

export function CalendarMonthGrid({ grid, anchor, todayISO, selectedISO, eventsByDay, onSelect, onQuickCreate }: Props) {
  const [dragISO, setDragISO] = useState<string | null>(null);
  const mouseDownISO = useRef<string | null>(null);

  function handleMouseDown(iso: string) {
    mouseDownISO.current = iso;
    setDragISO(iso);
  }

  function handleMouseEnter(iso: string) {
    if (mouseDownISO.current !== null) setDragISO(iso);
  }

  function handleMouseUp(iso: string) {
    if (mouseDownISO.current !== null) {
      onSelect(iso);
      onQuickCreate(iso, 9, 10);
    }
    mouseDownISO.current = null;
    setDragISO(null);
  }

  return (
    <div className="section" style={{ padding: 10, flex: 1, minWidth: 0 }}>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4,
        fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.22em',
        color: 'var(--cyan)', fontWeight: 700, marginBottom: 6,
      }}>
        {WEEKDAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', padding: '4px 0' }}>{d}</div>
        ))}
      </div>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}
        onMouseLeave={() => { mouseDownISO.current = null; setDragISO(null); }}
      >
        {grid.map(d => {
          const iso = toISO(d);
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = iso === todayISO;
          const isSelected = iso === selectedISO;
          const isDrag = iso === dragISO;
          const dayEvents = eventsByDay.get(iso) ?? [];
          const conflict = hasAnyConflict(dayEvents);

          const cellStyle: CSSProperties = {
            all: 'unset', cursor: 'pointer',
            minHeight: 62, padding: '6px 8px',
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
            border: isToday
              ? '2px solid var(--cyan)'
              : isSelected
                ? '2px solid var(--amber)'
                : isDrag
                  ? '2px dashed var(--cyan)'
                  : '1px solid var(--line-soft)',
            background: isSelected
              ? 'rgba(245, 166, 35, 0.1)'
              : isToday
                ? 'rgba(57, 229, 255, 0.08)'
                : isDrag
                  ? 'rgba(57, 229, 255, 0.06)'
                  : 'rgba(4, 10, 16, 0.35)',
            opacity: inMonth ? 1 : 0.3,
            boxShadow: isToday ? '0 0 10px rgba(57, 229, 255, 0.4)' : 'none',
            fontFamily: 'var(--mono)',
            position: 'relative',
            userSelect: 'none',
          };

          return (
            <button
              key={iso}
              style={cellStyle}
              onClick={() => onSelect(iso)}
              onMouseDown={() => handleMouseDown(iso)}
              onMouseEnter={() => handleMouseEnter(iso)}
              onMouseUp={() => handleMouseUp(iso)}
              aria-label={iso}
            >
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700,
                color: isToday ? 'var(--cyan)' : isSelected ? 'var(--amber)' : inMonth ? 'var(--ink)' : 'var(--ink-dim)',
                letterSpacing: '0.05em',
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                {d.getDate()}
                {conflict && (
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'var(--red)',
                    boxShadow: '0 0 4px var(--red)',
                    display: 'inline-block',
                  }} />
                )}
              </div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                {dayEvents.slice(0, 4).map(ev => (
                  <EventHoverCard key={ev.id} ev={ev}>
                    <span
                      title={ev.title}
                      style={{
                        width: 6, height: 6, borderRadius: 1,
                        background: ev.source === 'LOCAL' ? toneColor(ev.tone) : calendarColor(ev.source),
                        boxShadow: ev.tone === 'now' ? '0 0 4px var(--green)' : 'none',
                        display: 'inline-block',
                      }}
                    />
                  </EventHoverCard>
                ))}
                {dayEvents.length > 4 && (
                  <span style={{ fontSize: 9, color: 'var(--ink-2)', marginLeft: 2 }}>+{dayEvents.length - 4}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
