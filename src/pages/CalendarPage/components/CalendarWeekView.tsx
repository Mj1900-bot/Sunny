import { useCallback, useRef, useState } from 'react';
import type { CalEvent, DragCreate } from '../types';
import { WEEKDAYS } from '../constants';
import { toISO, mondayIndex, toneColor, calendarColor, addDays, pad2 } from '../utils';
import { navBtnStyle } from '../styles';
import { EventHoverCard } from './EventHoverCard';

type Props = {
  weekDays: ReadonlyArray<Date>;
  todayISO: string;
  selectedISO: string;
  eventsByDay: Map<string, CalEvent[]>;
  onSelect: (iso: string) => void;
  onSetAnchor: (updater: (prev: Date) => Date) => void;
  onQuickCreate: (dayISO: string, startHour: number, endHour: number) => void;
};

const HOUR_H = 48; // px per hour row
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function minutesToPx(minutes: number): number {
  return (minutes / 60) * HOUR_H;
}

function hasConflict(ev: CalEvent, others: CalEvent[]): boolean {
  if (!ev.startISO || !ev.endISO) return false;
  const aS = new Date(ev.startISO).getTime();
  const aE = new Date(ev.endISO).getTime();
  return others.some(o => {
    if (o.id === ev.id || !o.startISO || !o.endISO) return false;
    const bS = new Date(o.startISO).getTime();
    const bE = new Date(o.endISO).getTime();
    return aS < bE && aE > bS;
  });
}

export function CalendarWeekView({
  weekDays, todayISO, selectedISO, eventsByDay,
  onSelect, onSetAnchor, onQuickCreate
}: Props) {
  const [drag, setDrag] = useState<DragCreate | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const weekStart = weekDays[0];
  const weekEnd = weekDays[6];

  const getHourFromY = useCallback((clientY: number): number => {
    if (!gridRef.current) return 0;
    const rect = gridRef.current.getBoundingClientRect();
    const y = clientY - rect.top + gridRef.current.scrollTop;
    return Math.max(0, Math.min(23, Math.floor(y / HOUR_H)));
  }, []);

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>, iso: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    const hour = getHourFromY(e.clientY);
    setDrag({ dayISO: iso, startHour: hour, endHour: hour + 1 });
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!drag) return;
    const hour = getHourFromY(e.clientY);
    setDrag(prev => prev ? { ...prev, endHour: Math.max(prev.startHour + 1, hour + 1) } : prev);
  }

  function handleMouseUp() {
    if (!drag) return;
    onSelect(drag.dayISO);
    onQuickCreate(drag.dayISO, drag.startHour, drag.endHour);
    setDrag(null);
  }

  return (
    <div
      className="section"
      style={{ padding: 10, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 10, fontFamily: 'var(--display)', fontSize: 11,
        letterSpacing: '0.2em', color: 'var(--cyan)', fontWeight: 700, flexShrink: 0,
      }}>
        <span>
          WEEK · {weekStart.toDateString().slice(4).toUpperCase()} — {weekEnd.toDateString().slice(4).toUpperCase()}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => onSetAnchor(prev => addDays(prev, -7))} style={navBtnStyle}>← PREV</button>
          <button onClick={() => onSetAnchor(prev => addDays(prev, 7))} style={navBtnStyle}>NEXT →</button>
        </div>
      </div>

      {/* day-header row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '36px repeat(7, 1fr)',
        gap: 2, marginBottom: 2, flexShrink: 0,
      }}>
        <div />
        {weekDays.map(d => {
          const iso = toISO(d);
          const isToday = iso === todayISO;
          const isSelected = iso === selectedISO;
          return (
            <div
              key={iso}
              style={{
                textAlign: 'center', padding: '4px 2px',
                fontFamily: 'var(--display)', fontSize: 10,
                letterSpacing: '0.18em', fontWeight: 700,
                color: isToday ? 'var(--cyan)' : isSelected ? 'var(--amber)' : 'var(--ink-2)',
                cursor: 'pointer',
                borderBottom: isToday
                  ? '2px solid var(--cyan)'
                  : isSelected
                    ? '2px solid var(--amber)'
                    : '1px solid var(--line-soft)',
              }}
              onClick={() => onSelect(iso)}
            >
              <span>{WEEKDAYS[mondayIndex(d)]}</span>
              <span style={{ marginLeft: 4, fontFamily: 'var(--mono)', fontSize: 11 }}>{d.getDate()}</span>
            </div>
          );
        })}
      </div>

      {/* 24h scroll area */}
      <div
        ref={gridRef}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => setDrag(null)}
      >
        <div style={{
          display: 'grid',
          gridTemplateColumns: '36px repeat(7, 1fr)',
          gap: 2,
          position: 'relative',
        }}>
          {/* hour labels */}
          {HOURS.map(h => (
            <div
              key={`h${h}`}
              style={{
                height: HOUR_H,
                gridColumn: 1,
                display: 'flex',
                alignItems: 'flex-start',
                paddingTop: 2,
                fontFamily: 'var(--mono)',
                fontSize: 8,
                color: 'var(--ink-dim)',
                letterSpacing: '0.06em',
                flexShrink: 0,
              }}
            >
              {pad2(h)}:00
            </div>
          ))}

          {/* day columns */}
          {weekDays.map(d => {
            const iso = toISO(d);
            const isToday = iso === todayISO;
            const isSelected = iso === selectedISO;
            const dayEvents = (eventsByDay.get(iso) ?? []).filter(e => e.time !== 'ALL-DAY');
            const allDayEvents = (eventsByDay.get(iso) ?? []).filter(e => e.time === 'ALL-DAY');
            const isDragging = drag?.dayISO === iso;

            return (
              <div
                key={iso}
                style={{
                  gridRow: '1 / span 24',
                  position: 'relative',
                  background: isToday
                    ? 'rgba(57, 229, 255, 0.04)'
                    : isSelected
                      ? 'rgba(245, 166, 35, 0.03)'
                      : 'rgba(4, 10, 16, 0.25)',
                  borderLeft: isToday
                    ? '1px solid rgba(57, 229, 255, 0.3)'
                    : '1px solid var(--line-soft)',
                  cursor: 'crosshair',
                  minHeight: HOUR_H * 24,
                }}
                onMouseDown={e => handleMouseDown(e, iso)}
              >
                {/* hour grid lines */}
                {HOURS.map(h => (
                  <div
                    key={h}
                    style={{
                      position: 'absolute', top: h * HOUR_H, left: 0, right: 0,
                      height: 1, background: 'rgba(57, 229, 255, 0.05)',
                    }}
                  />
                ))}

                {/* drag preview */}
                {isDragging && drag && (
                  <div style={{
                    position: 'absolute',
                    top: drag.startHour * HOUR_H,
                    height: (drag.endHour - drag.startHour) * HOUR_H,
                    left: 2, right: 2,
                    background: 'rgba(57, 229, 255, 0.12)',
                    border: '1px dashed var(--cyan)',
                    pointerEvents: 'none',
                  }} />
                )}

                {/* all-day chips at top */}
                {allDayEvents.map(ev => {
                  const color = ev.source === 'LOCAL' ? toneColor(ev.tone) : calendarColor(ev.source);
                  return (
                    <EventHoverCard key={ev.id} ev={ev}>
                      <div style={{
                        marginBottom: 2, padding: '2px 4px',
                        borderLeft: `2px solid ${color}`,
                        background: 'rgba(6,14,22,0.6)',
                        fontFamily: 'var(--mono)', fontSize: 8,
                        color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {ev.title}
                      </div>
                    </EventHoverCard>
                  );
                })}

                {/* timed events */}
                {dayEvents.map(ev => {
                  const color = ev.source === 'LOCAL' ? toneColor(ev.tone) : calendarColor(ev.source);
                  const conflict = hasConflict(ev, dayEvents);
                  let topPx = 0, heightPx = HOUR_H;
                  if (ev.startISO) {
                    const s = new Date(ev.startISO);
                    topPx = minutesToPx(s.getHours() * 60 + s.getMinutes());
                    if (ev.endISO) {
                      const e2 = new Date(ev.endISO);
                      const diffMin = (e2.getTime() - s.getTime()) / 60_000;
                      heightPx = Math.max(20, minutesToPx(diffMin));
                    }
                  } else {
                    const [hh, mm] = ev.time.split(':').map(Number);
                    if (!Number.isNaN(hh)) topPx = minutesToPx((hh || 0) * 60 + (mm || 0));
                  }
                  return (
                    <EventHoverCard key={ev.id} ev={ev}>
                      <div
                        style={{
                          position: 'absolute',
                          top: topPx,
                          left: 2,
                          right: 2,
                          height: heightPx,
                          padding: '2px 4px',
                          borderLeft: `2px solid ${color}`,
                          background: 'rgba(6,14,22,0.75)',
                          overflow: 'hidden',
                          cursor: 'pointer',
                          boxSizing: 'border-box',
                        }}
                      >
                        {conflict && (
                          <span style={{
                            position: 'absolute', top: 3, right: 3,
                            width: 6, height: 6, borderRadius: '50%',
                            background: 'var(--red)',
                            boxShadow: '0 0 4px var(--red)',
                          }} />
                        )}
                        <div style={{
                          fontFamily: 'var(--mono)', fontSize: 8.5,
                          color, letterSpacing: '0.06em', lineHeight: 1.3,
                        }}>
                          {ev.time}
                        </div>
                        <div style={{
                          fontFamily: 'var(--mono)', fontSize: 9,
                          color: 'var(--ink)', fontWeight: 600,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {ev.title}
                        </div>
                      </div>
                    </EventHoverCard>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
