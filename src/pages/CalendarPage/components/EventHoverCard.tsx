import { useState, useRef, useEffect, type ReactNode } from 'react';
import type { CalEvent } from '../types';
import { calendarColor, toneColor, fmtDuration, durationMinutes } from '../utils';

type Props = {
  ev: CalEvent;
  children: ReactNode;
};

export function EventHoverCard({ ev, children }: Props) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const anchorRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const color = ev.source === 'LOCAL' ? toneColor(ev.tone) : calendarColor(ev.source);
  const dur =
    ev.startISO && ev.endISO ? fmtDuration(durationMinutes(ev.startISO, ev.endISO)) : null;

  function show() {
    timerRef.current = setTimeout(() => {
      if (!anchorRef.current) return;
      const r = anchorRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left });
      setVisible(true);
    }, 320);
  }

  function hide() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setVisible(false);
  }

  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); }, []);

  return (
    <div
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      style={{ position: 'relative' }}
    >
      {children}
      {visible && (
        <div
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            zIndex: 9999,
            minWidth: 240,
            maxWidth: 320,
            border: `1px solid ${color}55`,
            borderLeft: `3px solid ${color}`,
            background: 'rgba(4, 10, 16, 0.97)',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            pointerEvents: 'none',
            boxShadow: `0 4px 24px rgba(0,0,0,0.7), 0 0 12px ${color}22`,
          }}
        >
          <div style={{
            fontFamily: 'var(--display)', fontSize: 11, fontWeight: 700,
            color, letterSpacing: '0.14em',
          }}>
            {ev.title}
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9.5,
            color: 'var(--ink-2)', letterSpacing: '0.1em',
            display: 'flex', gap: 8, flexWrap: 'wrap',
          }}>
            <span>{ev.time}{dur ? ` · ${dur}` : ''}</span>
            <span style={{ color: 'var(--ink-dim)' }}>·</span>
            <span style={{ color }}>{ev.source === 'LOCAL' ? 'LOCAL' : ev.source.toUpperCase()}</span>
          </div>
          {ev.location && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-2)' }}>
              <span style={{ color: 'var(--ink-dim)' }}>LOC </span>{ev.location}
            </div>
          )}
          {ev.notes && (
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink)',
              lineHeight: 1.55, borderTop: '1px solid var(--line-soft)',
              paddingTop: 6, maxHeight: 80, overflow: 'hidden',
            }}>
              {ev.notes}
            </div>
          )}
          {ev.attendees && ev.attendees.length > 0 && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.08em' }}>
              <span style={{ color: 'var(--cyan)' }}>ATTENDEES </span>
              {ev.attendees.join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
