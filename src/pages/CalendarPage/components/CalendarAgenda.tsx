import type { ReactNode } from 'react';
import type { CalEvent } from '../types';
import { CalendarEventRow } from './CalendarEventRow';

export type AgendaGroup = {
  iso: string;
  date: Date;
  events: ReadonlyArray<CalEvent>;
};

type Props = {
  agendaGroups: ReadonlyArray<AgendaGroup>;
  todayISO: string;
  weekStats: { total: number; amber: number; now: number; };
  formOpen: boolean;
  onOpenForm: () => void;
  onDeleteEvent: (ev: CalEvent) => void;
  formElement: ReactNode;
};

export function CalendarAgenda({
  agendaGroups, todayISO, weekStats, formOpen,
  onOpenForm, onDeleteEvent, formElement
}: Props) {
  return (
    <div className="section" style={{ padding: 12, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        fontFamily: 'var(--display)', fontSize: 11, letterSpacing: '0.2em',
        color: 'var(--cyan)', fontWeight: 700, marginBottom: 10,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>UPCOMING — NEXT 14 DAYS</span>
        <button className="primary" onClick={onOpenForm}>+ NEW EVENT</button>
      </div>

      {formOpen && formElement}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {agendaGroups.length === 0 ? (
          <div style={{ color: 'var(--ink-dim)', fontFamily: 'var(--mono)', fontSize: 11, padding: '12px 2px' }}>
            No events in the next 14 days.
          </div>
        ) : agendaGroups.map(group => {
          const isToday = group.iso === todayISO;
          return (
            <div key={group.iso}>
              <div style={{
                fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.22em',
                color: isToday ? 'var(--cyan)' : 'var(--ink-2)', fontWeight: 700,
                padding: '4px 0', borderBottom: `1px solid ${isToday ? 'var(--cyan)' : 'var(--line-soft)'}`,
                marginBottom: 6, display: 'flex', justifyContent: 'space-between',
              }}>
                <span>{group.date.toDateString().toUpperCase()}{isToday ? ' · TODAY' : ''}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)' }}>
                  {group.events.length} EVENT{group.events.length === 1 ? '' : 'S'}
                </span>
              </div>
              <div className="cal">
                {group.events.map(ev => (
                  <CalendarEventRow key={ev.id} ev={ev} onDelete={onDeleteEvent} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{
        marginTop: 10, padding: '8px 10px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.55)',
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.14em',
        color: 'var(--ink-2)',
        display: 'flex', gap: 8, flexWrap: 'wrap',
      }}>
        <span style={{ color: 'var(--cyan)' }}>THIS WEEK:</span>
        <span>{weekStats.total} EVENTS</span>
        <span style={{ color: 'var(--ink-dim)' }}>·</span>
        <span style={{ color: 'var(--amber)' }}>{weekStats.amber} AMBER</span>
        <span style={{ color: 'var(--ink-dim)' }}>·</span>
        <span style={{ color: 'var(--green)' }}>{weekStats.now} NOW</span>
      </div>
    </div>
  );
}
