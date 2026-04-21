import type { CalEvent } from '../types';
import { calendarColor, toneClass, toneColor } from '../utils';
import { EventHoverCard } from './EventHoverCard';

type Props = {
  ev: CalEvent;
  onDelete: (ev: CalEvent) => void;
};

export function CalendarEventRow({ ev, onDelete }: Props) {
  const color = ev.source === 'LOCAL' ? toneColor(ev.tone) : calendarColor(ev.source);
  return (
    <EventHoverCard ev={ev}>
      <div key={ev.id} className={`ev ${toneClass(ev.tone)}`} style={{ position: 'relative' }}>
        <div className="time">{ev.time}</div>
        <div className="tx">
          {ev.title}
          <small>
            {ev.sub}
            {ev.sub && ' · '}
            <span style={{ color, letterSpacing: '0.12em' }}>
              {ev.source === 'LOCAL' ? 'LOCAL' : ev.source.toUpperCase()}
            </span>
          </small>
        </div>
        <span
          style={{
            width: 8, height: 8, borderRadius: 2,
            background: color,
            alignSelf: 'center', marginLeft: 'auto',
            boxShadow: ev.tone === 'now' ? '0 0 6px var(--green)' : 'none',
            flexShrink: 0,
          }}
        />
        <button
          onClick={() => onDelete(ev)}
          title="Delete"
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '2px 6px',
            marginLeft: 6,
            color: 'var(--ink-dim)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            lineHeight: 1,
            opacity: 0.55,
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--red)';
            (e.currentTarget as HTMLButtonElement).style.opacity = '1';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--ink-dim)';
            (e.currentTarget as HTMLButtonElement).style.opacity = '0.55';
          }}
        >
          ×
        </button>
      </div>
    </EventHoverCard>
  );
}
