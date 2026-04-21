import type { ReactNode } from 'react';
import type { CalEvent } from '../types';
import { fromISO } from '../utils';
import { CalendarEventRow } from './CalendarEventRow';

type Props = {
  selectedISO: string;
  selectedEvents: ReadonlyArray<CalEvent>;
  weekStats: { total: number; amber: number; now: number; };
  formOpen: boolean;
  onOpenForm: () => void;
  onDeleteEvent: (ev: CalEvent) => void;
  formElement: ReactNode;
};

export function CalendarRightPane({
  selectedISO, selectedEvents, weekStats, formOpen,
  onOpenForm, onDeleteEvent, formElement
}: Props) {
  return (
    <div
      className="section"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', minWidth: 280, maxWidth: 340, minHeight: 0 }}
    >
      <div style={{
        fontFamily: 'var(--display)', fontSize: 11, letterSpacing: '0.2em',
        color: 'var(--cyan)', fontWeight: 700, marginBottom: 10,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>{fromISO(selectedISO).toDateString().toUpperCase()}</span>
        <span style={{ color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 10 }}>
          {selectedEvents.length} ITEM{selectedEvents.length === 1 ? '' : 'S'}
        </span>
      </div>

      <button className="primary" onClick={onOpenForm} style={{ marginBottom: 10, width: '100%' }}>
        + NEW EVENT
      </button>

      {formOpen && formElement}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {selectedEvents.length === 0 ? (
          <div style={{ color: 'var(--ink-dim)', fontFamily: 'var(--mono)', fontSize: 11, padding: '12px 2px' }}>
            No events scheduled.
          </div>
        ) : (
          <div className="cal">
            {selectedEvents.map(ev => (
              <CalendarEventRow key={ev.id} ev={ev} onDelete={onDeleteEvent} />
            ))}
          </div>
        )}
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
