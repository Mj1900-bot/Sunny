/**
 * TODAY — the narrative daily dashboard.
 *
 * R12-A: 4-panel hero grid, AI BRIEF, time-of-day variants, quick actions
 * row, streak chip, and personality-copy empty states.
 *
 * Layout (12-col grid):
 *   [BriefHeader — full width]
 *   [AGENDA 3] [URGENT 3] [CONTEXT 3] [PRIORITIES 3]
 *   [Quick Actions row — full width]
 *   [SCHEDULE 6] [TASKS 6]
 *   [INBOX 6]    [MESSAGES 6]
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useView, type ViewKey } from '../../store/view';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, Row, Chip, EmptyState, StatBlock,
  Toolbar, ToolbarButton, NavLink, DayProgress, ScrollList, usePoll, relTime,
} from '../_shared';
import { BriefHeader } from './BriefHeader';
import { AgendaPanel, UrgentPanel, ContextPanel, PriorityPanel } from './panels';
import { loadTodayBrief } from './api';
import { buildBriefPlainText, stashTimelineJump } from './briefExport';

function fmtClock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

/** Relative minutes until `iso`. Negative = in the past. */
function minutesUntil(iso: string, nowMs: number): number {
  return Math.round((new Date(iso).getTime() - nowMs) / 60_000);
}

/** Human-friendly "in 15m" / "in 2h 10m" / "5m ago". */
function relClock(iso: string, nowMs: number): string {
  const m = minutesUntil(iso, nowMs);
  if (Math.abs(m) < 1) return 'now';
  const sign = m >= 0 ? 'in ' : '';
  const abs = Math.abs(m);
  if (abs < 60) return `${sign}${abs}m${m < 0 ? ' ago' : ''}`;
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  const tail = mm > 0 ? ` ${mm}m` : '';
  return `${sign}${h}h${tail}${m < 0 ? ' ago' : ''}`;
}

// ── Quick actions ─────────────────────────────────────────────────────────────

type QuickAction = {
  label: string;
  tone: 'cyan' | 'amber' | 'gold' | 'violet' | 'green';
  view?: ViewKey;
  tauri?: string;
};

const QUICK_ACTIONS: ReadonlyArray<QuickAction> = [
  { label: 'COMPOSE TASK',  tone: 'amber',  view: 'tasks'   },
  { label: 'LOG JOURNAL',   tone: 'gold',   view: 'journal' },
  { label: 'START FOCUS',   tone: 'green',  view: 'focus'   },
  { label: 'CHECK INBOX',   tone: 'cyan',   view: 'inbox'   },
];

// ── Main component ────────────────────────────────────────────────────────────

export function TodayPage() {
  const setView = useView(s => s.setView);
  const { data: brief, loading, error, reload } = usePoll(loadTodayBrief, 30_000);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copyHint, setCopyHint] = useState<string | null>(null);

  const hasLiveEvent = useMemo(() => !!(brief && brief.events.some(e => {
    const s = new Date(e.start_iso).getTime();
    const en = new Date(e.end_iso).getTime();
    return nowMs >= s && nowMs < en;
  })), [brief, nowMs]);

  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const ms = hasLiveEvent ? 15_000 : 60_000;
    const h = window.setInterval(tick, ms);
    return () => clearInterval(h);
  }, [hasLiveEvent]);

  const nav = useCallback((v: ViewKey) => setView(v), [setView]);

  const localTodayISO = useCallback(() => new Date().toLocaleDateString('en-CA'), []);

  const copyBrief = useCallback(async () => {
    if (!brief) return;
    const text = buildBriefPlainText(brief, nowMs);
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint('COPIED TO CLIPBOARD');
    } catch {
      setCopyHint('COPY FAILED — CHECK PERMISSIONS');
    }
    window.setTimeout(() => setCopyHint(null), 2500);
  }, [brief, nowMs]);

  const openTimelineToday = useCallback(() => {
    stashTimelineJump(localTodayISO());
    setView('timeline');
  }, [setView, localTodayISO]);

  if (!brief && loading) {
    return (
      <ModuleView title="TODAY · BRIEF">
        <EmptyState title="Compiling today" hint="Fetching calendar, mail, reminders, world state, weather…" />
      </ModuleView>
    );
  }

  if (!brief && error) {
    return (
      <ModuleView title="TODAY · BRIEF">
        <EmptyState title="Brief unavailable" hint={`${error} — retrying on next poll.`} />
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
          <ToolbarButton onClick={() => void reload()}>RETRY NOW</ToolbarButton>
        </div>
      </ModuleView>
    );
  }

  if (!brief) {
    return <ModuleView title="TODAY · BRIEF"><EmptyState title="No data" /></ModuleView>;
  }

  const unreadMsgs = brief.messages.reduce((n, m) => n + (m.unread_count || 0), 0);
  const nextEvent = brief.events.find(e => new Date(e.end_iso).getTime() > nowMs);
  const liveEvent = brief.events.find(e =>
    new Date(e.start_iso).getTime() <= nowMs && new Date(e.end_iso).getTime() > nowMs,
  );
  const overdueCount = brief.reminders.filter(r =>
    r.due && new Date(r.due).getTime() < nowMs,
  ).length;

  return (
    <ModuleView title="TODAY · BRIEF">
      <PageGrid>
        {/* ── Brief header + day progress ── */}
        <PageCell span={12}>
          <BriefHeader brief={brief} />
          <DayProgress nowMs={nowMs} tone="gold" />
        </PageCell>

        {/* ── Stat counters ── */}
        <PageCell span={12}>
          <Toolbar style={{ marginBottom: 2 }}>
            <ToolbarButton onClick={() => void reload()}>REFRESH BRIEF</ToolbarButton>
            <ToolbarButton tone="teal" onClick={() => void copyBrief()} title="Plain-text summary for notes or chat">
              COPY BRIEF
            </ToolbarButton>
            <ToolbarButton tone="violet" onClick={openTimelineToday} title="Open Timeline on today’s date">
              TIMELINE · TODAY
            </ToolbarButton>
            <ToolbarButton tone="cyan" onClick={() => nav('calendar')}>CALENDAR</ToolbarButton>
            {copyHint && <Chip tone="green" style={{ fontSize: 8 }}>{copyHint}</Chip>}
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.12em',
            }}>
              auto-sync · 30s · faster tick during live events
            </span>
          </Toolbar>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            <StatBlock
              label="EVENTS"
              value={String(brief.events.length)}
              sub={liveEvent
                ? `now · ${liveEvent.title.slice(0, 18)}`
                : nextEvent
                  ? `next · ${fmtClock(nextEvent.start_iso)} · ${relClock(nextEvent.start_iso, nowMs)}`
                  : 'none scheduled'}
              tone={liveEvent ? 'green' : 'amber'}
              onClick={() => nav('calendar')}
              ariaLabel="Open calendar"
            />
            <StatBlock
              label="TASKS"
              value={String(brief.reminders.length)}
              sub={overdueCount > 0 ? `${overdueCount} overdue` : 'all on track'}
              tone={overdueCount > 0 ? 'red' : 'gold'}
              onClick={() => nav('tasks')}
              ariaLabel="Open tasks"
            />
            <StatBlock
              label="UNREAD MAIL"
              value={String(brief.unreadMail)}
              sub={brief.unreadMail > 0 ? 'needs triage' : 'inbox zero'}
              tone={brief.unreadMail > 10 ? 'red' : 'pink'}
              onClick={() => nav('inbox')}
              ariaLabel="Open inbox"
            />
            <StatBlock
              label="MESSAGES"
              value={String(unreadMsgs)}
              sub={`${brief.messages.length} thread${brief.messages.length === 1 ? '' : 's'}`}
              tone="violet"
              onClick={() => nav('contacts')}
              ariaLabel="Open contacts"
            />
            <StatBlock
              label="ACTIVITY"
              value={brief.world?.activity ?? '—'}
              sub={brief.world?.focus?.app_name ?? 'no focus'}
              tone="cyan"
              onClick={() => nav('world')}
              ariaLabel="Open world state"
            />
          </div>
        </PageCell>

        {/* ── Hero grid: 4 panels ── */}
        <PageCell span={3}>
          <AgendaPanel
            events={brief.events}
            nowMs={nowMs}
            onOpen={() => nav('calendar')}
          />
        </PageCell>
        <PageCell span={3}>
          <UrgentPanel
            mail={brief.recentMail}
            reminders={brief.reminders}
            onOpenMail={() => nav('inbox')}
            onOpenTasks={() => nav('tasks')}
          />
        </PageCell>
        <PageCell span={3}>
          <ContextPanel brief={brief} />
        </PageCell>
        <PageCell span={3}>
          <PriorityPanel
            priorities={brief.priorities}
            onOpen={() => nav('memory')}
          />
        </PageCell>

        {/* ── Quick actions ── */}
        <PageCell span={12}>
          <Section title="QUICK ACTIONS">
            <Toolbar>
              {QUICK_ACTIONS.map(a => (
                <ToolbarButton
                  key={a.label}
                  tone={a.tone}
                  onClick={() => { if (a.view) nav(a.view); }}
                >
                  {a.label}
                </ToolbarButton>
              ))}
            </Toolbar>
          </Section>
        </PageCell>

        {/* ── Schedule ── */}
        <PageCell span={6}>
          <Section
            title="SCHEDULE"
            right={<NavLink onClick={() => nav('calendar')}>calendar</NavLink>}
          >
            {brief.events.length === 0
              ? <EmptyState title="Clear sky ahead" hint="Calendar is wide open — a rare gift." />
              : (
                <ScrollList maxHeight={260}>
                  {brief.events.map(e => {
                    const start = new Date(e.start_iso).getTime();
                    const end = new Date(e.end_iso).getTime();
                    const live = nowMs >= start && nowMs < end;
                    const past = nowMs >= end;
                    const pct = live ? Math.round(((nowMs - start) / (end - start)) * 100) : 0;
                    return (
                      <Row
                        key={e.id}
                        label={fmtClock(e.start_iso)}
                        value={
                          <>
                            <b style={{ color: past ? 'var(--ink-dim)' : 'var(--ink)' }}>{e.title}</b>
                            {e.location
                              ? <span style={{ color: 'var(--ink-dim)' }}> · {e.location}</span>
                              : null}
                          </>
                        }
                        right={
                          live ? <Chip tone="green">NOW · {pct}%</Chip>
                          : past ? <Chip tone="dim">past</Chip>
                          : <span style={{ color: 'var(--ink-dim)' }}>{relClock(e.start_iso, nowMs)}</span>
                        }
                        tone={live ? 'green' : undefined}
                        onClick={() => nav('calendar')}
                        title="Open calendar"
                      />
                    );
                  })}
                </ScrollList>
              )}
          </Section>
        </PageCell>

        {/* ── Tasks ── */}
        <PageCell span={6}>
          <Section
            title="TASKS"
            right={<NavLink onClick={() => nav('tasks')}>tasks</NavLink>}
          >
            {brief.reminders.length === 0
              ? <EmptyState title="Inbox zero" hint="Nothing open in Reminders." />
              : (
                <ScrollList maxHeight={260}>
                  {brief.reminders.slice(0, 8).map(r => {
                    const overdue = !!r.due && new Date(r.due).getTime() < nowMs;
                    const dueTxt = r.due
                      ? (overdue ? 'OVERDUE' : new Date(r.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
                      : null;
                    return (
                      <Row
                        key={r.id}
                        label={r.list}
                        value={r.title}
                        right={
                          dueTxt
                            ? <Chip tone={overdue ? 'red' : 'amber'} style={{ fontSize: 8 }}>{dueTxt}</Chip>
                            : undefined
                        }
                        tone={overdue ? 'amber' : undefined}
                        onClick={() => nav('tasks')}
                        title="Open tasks"
                      />
                    );
                  })}
                </ScrollList>
              )}
          </Section>
        </PageCell>

        {/* ── Inbox ── */}
        <PageCell span={6}>
          <Section
            title="INBOX (UNREAD)"
            right={<NavLink onClick={() => nav('inbox')}>inbox</NavLink>}
          >
            {brief.recentMail.length === 0
              ? <EmptyState title="Quiet on the wire" hint="No unread mail — or Mail.app isn't granted." />
              : (
                <ScrollList maxHeight={260}>
                  {brief.recentMail.slice(0, 6).map(m => (
                    <Row
                      key={m.id}
                      label={m.from.split(' <')[0].slice(0, 22)}
                      value={<b>{m.subject}</b>}
                      right={new Date(m.received).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      onClick={() => nav('inbox')}
                      title="Open inbox"
                    />
                  ))}
                </ScrollList>
              )}
          </Section>
        </PageCell>

        {/* ── Messages ── */}
        <PageCell span={6}>
          <Section
            title="MESSAGES"
            right={<NavLink onClick={() => nav('contacts')}>contacts</NavLink>}
          >
            {brief.messages.length === 0
              ? <EmptyState title="All quiet" hint="No recent iMessage/SMS threads." />
              : (
                <ScrollList maxHeight={260}>
                  {brief.messages.slice(0, 6).map(m => (
                    <Row
                      key={m.handle}
                      label={m.display.slice(0, 18)}
                      value={
                        <span style={{ color: m.unread_count > 0 ? 'var(--ink)' : 'var(--ink-dim)' }}>
                          {m.last_message.slice(0, 60)}
                        </span>
                      }
                      right={
                        <>
                          {m.unread_count > 0 && <Chip tone="pink" style={{ marginRight: 6 }}>{m.unread_count}</Chip>}
                          {relTime(m.last_ts)}
                        </>
                      }
                      onClick={() => nav('contacts')}
                      title="Open contacts"
                    />
                  ))}
                </ScrollList>
              )}
          </Section>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
