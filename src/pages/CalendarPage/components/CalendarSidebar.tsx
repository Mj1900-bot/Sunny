import type { ViewMode } from '../types';
import { MONTH_NAMES } from '../constants';
import { calendarColor } from '../utils';
import { navBtnStyle, sidebarLabel } from '../styles';
import { isTauri } from '../../../lib/tauri';
import { CalendarMiniMap } from './CalendarMiniMap';
import type { CalEvent } from '../types';

type Props = {
  anchor: Date;
  viewMode: ViewMode;
  calendars: ReadonlyArray<string>;
  hiddenCalendars: ReadonlySet<string>;
  remoteErr: string | null;
  eventsByDay: Map<string, CalEvent[]>;
  todayISO: string;
  selectedISO: string;
  onPrevYear: () => void;
  onNextYear: () => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onJumpToday: () => void;
  onSetViewMode: (mode: ViewMode) => void;
  onRefreshRemote: () => Promise<void>;
  onToggleHidden: (name: string) => void;
  onSelectISO: (iso: string) => void;
};

export function CalendarSidebar({
  anchor, viewMode, calendars, hiddenCalendars, remoteErr,
  eventsByDay, todayISO, selectedISO,
  onPrevYear, onNextYear, onPrevMonth, onNextMonth, onJumpToday,
  onSetViewMode, onRefreshRemote, onToggleHidden, onSelectISO,
}: Props) {
  return (
    <div
      className="section"
      style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 180, maxWidth: 204, overflowY: 'auto' }}
    >
      <div>
        <div style={sidebarLabel}>YEAR</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={onPrevYear} style={{ ...navBtnStyle, flex: '0 0 28px' }} aria-label="Previous year">↑</button>
          <div style={{
            flex: 1, textAlign: 'center',
            fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700,
            color: 'var(--cyan)', letterSpacing: '0.1em',
            padding: '4px 0',
          }}>
            {anchor.getFullYear()}
          </div>
          <button onClick={onNextYear} style={{ ...navBtnStyle, flex: '0 0 28px' }} aria-label="Next year">↓</button>
        </div>
      </div>

      <div>
        <div style={sidebarLabel}>MONTH</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={onPrevMonth} style={{ ...navBtnStyle, flex: '0 0 28px' }} aria-label="Previous month">↑</button>
          <div style={{
            flex: 1, textAlign: 'center',
            fontFamily: 'var(--display)', fontSize: 11, fontWeight: 700,
            color: 'var(--cyan)', letterSpacing: '0.18em',
            padding: '4px 0',
          }}>
            {MONTH_NAMES[anchor.getMonth()].slice(0, 3)}
          </div>
          <button onClick={onNextMonth} style={{ ...navBtnStyle, flex: '0 0 28px' }} aria-label="Next month">↓</button>
        </div>
      </div>

      <button
        onClick={onJumpToday}
        style={{ ...navBtnStyle, padding: '7px 8px', borderColor: 'var(--cyan)' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(57, 229, 255, 0.12)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        ◉ JUMP TO TODAY
      </button>

      <div>
        <div style={sidebarLabel}>VIEW</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(['MONTH', 'WEEK', 'AGENDA'] as const).map(mode => {
            const active = viewMode === mode;
            return (
              <button
                key={mode}
                onClick={() => onSetViewMode(mode)}
                style={{
                  ...navBtnStyle,
                  padding: '6px 8px',
                  borderColor: active ? 'var(--cyan)' : 'var(--line-soft)',
                  background: active ? 'rgba(57, 229, 255, 0.1)' : 'transparent',
                  color: active ? 'var(--cyan)' : 'var(--ink-2)',
                  cursor: 'pointer',
                }}
              >
                {mode}
              </button>
            );
          })}
        </div>
      </div>

      {/* Mini-map */}
      <CalendarMiniMap
        anchor={anchor}
        todayISO={todayISO}
        selectedISO={selectedISO}
        eventsByDay={eventsByDay}
        onSelectISO={onSelectISO}
      />

      <div style={{
        padding: '6px 8px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.55)',
        fontFamily: 'var(--mono)', fontSize: 9,
        letterSpacing: '0.1em', color: 'var(--ink-dim)',
        display: 'flex', flexDirection: 'column', gap: 2,
      }}>
        <span style={{ color: 'var(--ink-2)' }}>KEYS</span>
        <span>←/→ DAY · ⇧+←/→ WEEK</span>
        <span>N · NEW &nbsp; T · TODAY</span>
        <span>G · JUMP TO DATE</span>
        <span>ENTER · COMPOSE · ESC · CLOSE</span>
      </div>

      {isTauri && (
        <div>
          <div style={{ ...sidebarLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>CALENDARS</span>
            <button
              onClick={() => void onRefreshRemote()}
              title="Refresh macOS calendar"
              style={{
                all: 'unset', cursor: 'pointer',
                fontFamily: 'var(--mono)', fontSize: 9,
                color: 'var(--cyan)', letterSpacing: '0.12em',
              }}
            >
              ↻
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 180, overflow: 'auto' }}>
            {calendars.length === 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)' }}>
                {remoteErr ? 'denied' : '—'}
              </span>
            )}
            {calendars.map(name => {
              const hidden = hiddenCalendars.has(name);
              const color = calendarColor(name);
              return (
                <button
                  key={name}
                  onClick={() => onToggleHidden(name)}
                  title={hidden ? 'show' : 'hide'}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 6px',
                    border: '1px solid var(--line-soft)',
                    background: hidden ? 'transparent' : 'rgba(57, 229, 255, 0.05)',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    color: hidden ? 'var(--ink-dim)' : 'var(--ink-2)',
                    opacity: hidden ? 0.55 : 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span
                    style={{
                      width: 8, height: 8, borderRadius: 2,
                      background: hidden ? 'transparent' : color,
                      border: `1px solid ${color}`,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
