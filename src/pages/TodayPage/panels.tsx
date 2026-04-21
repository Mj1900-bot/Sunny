/**
 * Hero grid panels for TodayPage.
 *
 * Four bordered panels with dashed-border empty states and personality copy:
 *   - AgendaPanel   (next 3 events with time chip)
 *   - UrgentPanel   (mail keyword scan + overdue reminders merged)
 *   - ContextPanel  (weather + world one-liner)
 *   - PriorityPanel (memory_search priority entries)
 *
 * Each panel is self-contained — receives only what it needs from TodayBrief.
 */

import type { CSSProperties, ReactNode } from 'react';
import { Section, Chip, Row, EmptyState, NavLink } from '../_shared';
import type { TodayBrief, CalendarEvent, MailMessage, Reminder } from './api';
import { isUrgentMail } from './api';

// ── Shared panel chrome ──────────────────────────────────────────────────────

function HeroPanel({
  children,
  accent = 'cyan',
  style,
}: {
  children: ReactNode;
  accent?: 'cyan' | 'amber' | 'gold' | 'violet';
  style?: CSSProperties;
}) {
  return (
    <div style={{
      border: `1px dashed rgba(57,229,255,0.18)`,
      borderLeft: `2px solid var(--${accent})`,
      background: 'rgba(6, 14, 22, 0.45)',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      height: '100%',
      minHeight: 148,
      ...style,
    }}>
      {children}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function isOverdue(r: Reminder): boolean {
  return !!r.due && new Date(r.due).getTime() < Date.now();
}

function relMin(iso: string, nowMs: number): string {
  const m = Math.round((new Date(iso).getTime() - nowMs) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `in ${h}h ${rem}m` : `in ${h}h`;
}

// ── AGENDA panel ─────────────────────────────────────────────────────────────

export function AgendaPanel({
  events,
  nowMs,
  onOpen,
}: {
  events: ReadonlyArray<CalendarEvent>;
  nowMs: number;
  onOpen: () => void;
}) {
  const upcoming = events.filter(e => new Date(e.end_iso).getTime() > nowMs);
  const next3 = upcoming.slice(0, 3);

  return (
    <HeroPanel accent="amber">
      <Section title="AGENDA" right={<NavLink tone="amber" onClick={onOpen}>calendar</NavLink>}>
        {next3.length === 0
          ? <EmptyState title="Clear sky ahead" hint="No upcoming events — enjoy the breathing room." />
          : next3.map(e => {
            const live = nowMs >= new Date(e.start_iso).getTime() && nowMs < new Date(e.end_iso).getTime();
            return (
              <Row
                key={e.id}
                label={
                  <Chip tone={live ? 'green' : 'amber'} style={{ fontSize: 8 }}>
                    {fmtTime(e.start_iso)}
                  </Chip>
                }
                value={<b style={{ fontSize: 12 }}>{e.title}</b>}
                right={live
                  ? <Chip tone="green">NOW</Chip>
                  : <span style={{ fontSize: 9, color: 'var(--ink-dim)' }}>{relMin(e.start_iso, nowMs)}</span>}
                tone={live ? 'green' : undefined}
              />
            );
          })}
      </Section>
    </HeroPanel>
  );
}

// ── URGENT panel ─────────────────────────────────────────────────────────────

type UrgentItem =
  | { kind: 'mail'; id: string; label: string; detail: string }
  | { kind: 'task'; id: string; label: string; detail: string };

function buildUrgentItems(
  mail: ReadonlyArray<MailMessage>,
  reminders: ReadonlyArray<Reminder>,
): UrgentItem[] {
  const urgentMail: UrgentItem[] = mail
    .filter(isUrgentMail)
    .slice(0, 3)
    .map(m => ({
      kind: 'mail',
      id: m.id,
      label: m.from.split(' <')[0].slice(0, 20),
      detail: m.subject.slice(0, 48),
    }));

  const overdueTasks: UrgentItem[] = reminders
    .filter(isOverdue)
    .slice(0, 3)
    .map(r => ({
      kind: 'task',
      id: r.id,
      label: r.list.slice(0, 16),
      detail: r.title.slice(0, 48),
    }));

  return [...urgentMail, ...overdueTasks];
}

export function UrgentPanel({
  mail,
  reminders,
  onOpenMail,
  onOpenTasks,
}: {
  mail: ReadonlyArray<MailMessage>;
  reminders: ReadonlyArray<Reminder>;
  onOpenMail: () => void;
  onOpenTasks: () => void;
}) {
  const items = buildUrgentItems(mail, reminders);

  return (
    <HeroPanel accent="gold">
      <Section
        title="URGENT"
        right={
          <span style={{ display: 'flex', gap: 4 }}>
            <NavLink tone="gold" onClick={onOpenMail}>mail</NavLink>
            <NavLink tone="gold" onClick={onOpenTasks}>tasks</NavLink>
          </span>
        }
      >
        {items.length === 0
          ? <EmptyState title="Nothing screaming" hint="No urgent mail or overdue reminders. Well done." />
          : items.map(item => (
            <Row
              key={item.id}
              label={
                <Chip tone={item.kind === 'mail' ? 'gold' : 'amber'} style={{ fontSize: 8 }}>
                  {item.kind === 'mail' ? 'MAIL' : 'OVERDUE'}
                </Chip>
              }
              value={item.detail}
              right={<span style={{ fontSize: 9, color: 'var(--ink-dim)' }}>{item.label}</span>}
              tone="amber"
            />
          ))}
      </Section>
    </HeroPanel>
  );
}

// ── CONTEXT panel ─────────────────────────────────────────────────────────────

export function ContextPanel({ brief }: { brief: TodayBrief }) {
  const w = brief.weather;
  const world = brief.world;

  const hasContent = w || world;

  return (
    <HeroPanel accent="cyan">
      <Section title="CONTEXT">
        {!hasContent
          ? <EmptyState title="Reading the room" hint="Weather + system context loading." />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {w && (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  padding: '8px 10px',
                  border: '1px solid rgba(57,229,255,0.12)',
                  background: 'rgba(57,229,255,0.03)',
                }}>
                  <div style={{
                    fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.24em',
                    color: 'var(--ink-dim)', fontWeight: 700,
                  }}>WEATHER · {w.city.toUpperCase()}</div>
                  <div style={{
                    fontFamily: 'var(--display)', fontSize: 22, fontWeight: 800,
                    color: 'var(--cyan)', letterSpacing: '0.04em', lineHeight: 1.1,
                  }}>
                    {Math.round(w.temp_c)}°C
                  </div>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
                  }}>
                    {w.condition}
                    {w.humidity != null ? ` · ${w.humidity}% humidity` : ''}
                  </div>
                </div>
              )}
              {world && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {world.focus?.app_name && (
                    <Row
                      label="FOCUS"
                      value={world.focus.app_name}
                      tone="green"
                    />
                  )}
                  {world.activity && world.activity !== 'unknown' && (
                    <Row label="ACTIVITY" value={world.activity} />
                  )}
                  {typeof world.battery_pct === 'number' && (
                    <Row
                      label="BATTERY"
                      value={`${Math.round(world.battery_pct)}%${world.battery_charging ? ' charging' : ''}`}
                      right={
                        world.battery_pct < 20
                          ? <Chip tone="red">LOW</Chip>
                          : world.battery_charging
                            ? <Chip tone="green">CHG</Chip>
                            : undefined
                      }
                    />
                  )}
                </div>
              )}
            </div>
          )}
      </Section>
    </HeroPanel>
  );
}

// ── PRIORITIES panel ──────────────────────────────────────────────────────────

export function PriorityPanel({
  priorities,
  onOpen,
}: {
  priorities: TodayBrief['priorities'];
  onOpen: () => void;
}) {
  return (
    <HeroPanel accent="violet">
      <Section
        title="TOP PRIORITIES"
        right={<NavLink tone="violet" onClick={onOpen}>memory</NavLink>}
      >
        {priorities.length === 0
          ? <EmptyState title="No priorities logged" hint={`Tag memories with #priority to surface them here.`} />
          : priorities.map((p, i) => (
            <Row
              key={p.id}
              label={
                <Chip tone="violet" style={{ fontSize: 8 }}>P{i + 1}</Chip>
              }
              value={p.text.slice(0, 72)}
            />
          ))}
      </Section>
    </HeroPanel>
  );
}
