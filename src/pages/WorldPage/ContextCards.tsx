/**
 * ContextCards — a 2×2 grid of focus, calendar, mail, and host context
 * cards. Each card uses the shared `Card` primitive with accent borders
 * and subtle gradient backgrounds.
 */

import { useEffect, useState } from 'react';
import { Card, Chip } from '../_shared';
import { ACTIVITY_TONE, type WorldState } from './types';
import { nextEventStartsIn } from './worldUtils';

// ---------------------------------------------------------------------------
// Focus Card
// ---------------------------------------------------------------------------

function FocusCard({ world }: { world: WorldState }) {
  const focus = world.focus;
  const tone = ACTIVITY_TONE[world.activity];

  if (!focus) {
    return (
      <Card accent="cyan" style={{ flex: 1 }}>
        <CardHeader label="FOCUS" tone="cyan" />
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
          padding: '8px 0',
        }}>
          No focus detected
        </div>
      </Card>
    );
  }

  return (
    <Card accent={tone} style={{ flex: 1 }}>
      <CardHeader label="FOCUS" tone={tone} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        {/* App colour dot */}
        <div style={{
          width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
          background: `linear-gradient(135deg, var(--${tone}) 10%, rgba(6, 14, 22, 0.8) 140%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--display)', fontSize: 13, fontWeight: 800,
          color: '#050a10',
          boxShadow: `0 0 8px var(--${tone})44`,
        }}>
          {focus.app_name.charAt(0).toUpperCase()}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{
            fontFamily: 'var(--label)', fontSize: 13, fontWeight: 600,
            color: 'var(--ink)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {focus.app_name}
          </span>
          {focus.bundle_id && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {focus.bundle_id}
            </span>
          )}
        </div>
      </div>
      {focus.window_title && (
        <div
          title={focus.window_title}
          style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginTop: 6, padding: '4px 0',
            borderTop: '1px solid var(--line-soft)',
          }}
        >
          {focus.window_title}
        </div>
      )}
      <div style={{
        display: 'flex', gap: 6, marginTop: 6, alignItems: 'center',
      }}>
        <Chip tone={tone}>{world.activity}</Chip>
        {world.focused_duration_secs > 0 && (
          <Chip tone="dim">{humanDur(world.focused_duration_secs)} focused</Chip>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Calendar Card
// ---------------------------------------------------------------------------

function CalendarCard({ world }: { world: WorldState }) {
  const ev = world.next_event;
  const [, setTick] = useState(0);

  // Tick every 30s so countdown stays fresh
  useEffect(() => {
    const h = window.setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(h);
  }, []);

  const startsIn = ev ? nextEventStartsIn(ev.start_iso) : null;
  const eventTime = ev ? new Date(ev.start_iso).toLocaleTimeString(
    undefined, { hour: '2-digit', minute: '2-digit' },
  ) : null;

  // Urgency colouring
  let urgencyTone: 'green' | 'amber' | 'red' | 'cyan' = 'cyan';
  if (ev) {
    const diffMs = new Date(ev.start_iso).getTime() - Date.now();
    const diffMin = diffMs / 60_000;
    if (diffMin < 0) urgencyTone = 'red';
    else if (diffMin < 5) urgencyTone = 'red';
    else if (diffMin < 30) urgencyTone = 'amber';
    else urgencyTone = 'green';
  }

  return (
    <Card accent={ev ? urgencyTone : 'cyan'} style={{ flex: 1 }}>
      <CardHeader label="CALENDAR" tone={ev ? urgencyTone : 'cyan'} />
      {ev ? (
        <div style={{ marginTop: 4 }}>
          <div style={{
            fontFamily: 'var(--label)', fontSize: 13, fontWeight: 600,
            color: 'var(--ink)', lineHeight: 1.4,
          }}>
            {ev.title}
          </div>
          <div style={{
            display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <Chip tone={urgencyTone}>
              {startsIn ?? eventTime}
            </Chip>
            {eventTime && startsIn && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
              }}>@ {eventTime}</span>
            )}
          </div>
          {ev.location && (
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
              marginTop: 4,
            }}>
              📍 {ev.location}
            </div>
          )}
          {ev.calendar_name && (
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
              marginTop: 2,
            }}>
              {ev.calendar_name}
            </div>
          )}
        </div>
      ) : (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
          padding: '8px 0',
        }}>
          No upcoming events
        </div>
      )}
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
        marginTop: 6, paddingTop: 4, borderTop: '1px solid var(--line-soft)',
      }}>
        {world.events_today} event{world.events_today !== 1 ? 's' : ''} today
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mail Card
// ---------------------------------------------------------------------------

function MailCard({ world }: { world: WorldState }) {
  const count = world.mail_unread;
  const tone = count == null ? 'cyan' as const
    : count > 10 ? 'red' as const
    : count > 3 ? 'amber' as const
    : 'green' as const;

  return (
    <Card accent={tone} style={{ flex: 1 }}>
      <CardHeader label="MAIL" tone={tone} />
      <div style={{
        fontFamily: 'var(--display)', fontSize: 28, fontWeight: 800,
        color: `var(--${tone})`, letterSpacing: '0.04em',
        padding: '6px 0 2px',
        textShadow: `0 0 12px var(--${tone})33`,
      }}>
        {count == null ? '—' : count}
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
      }}>
        {count == null ? 'mail access unavailable' : 'unread messages'}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Host Card
// ---------------------------------------------------------------------------

function HostCard({ world }: { world: WorldState }) {
  return (
    <Card accent="cyan" style={{ flex: 1 }}>
      <CardHeader label="SYSTEM" tone="cyan" />
      <div style={{
        fontFamily: 'var(--label)', fontSize: 13, fontWeight: 600,
        color: 'var(--ink)', marginTop: 4,
      }}>
        {world.host}
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        marginTop: 2,
      }}>
        {world.os_version}
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
        marginTop: 6, paddingTop: 4, borderTop: '1px solid var(--line-soft)',
      }}>
        {new Date(world.timestamp_ms).toLocaleString()}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared header
// ---------------------------------------------------------------------------

function CardHeader({ label, tone }: { label: string; tone: string }) {
  return (
    <div style={{
      fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.28em',
      color: `var(--${tone})`, fontWeight: 700,
      marginBottom: 2,
    }}>
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanDur(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Public grid
// ---------------------------------------------------------------------------

export function ContextCards({ world }: { world: WorldState }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(2, 1fr)',
      gap: 10,
    }}>
      <FocusCard world={world} />
      <CalendarCard world={world} />
      <MailCard world={world} />
      <HostCard world={world} />
    </div>
  );
}
