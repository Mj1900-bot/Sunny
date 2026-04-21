/**
 * TIMELINE — scrub the day or week.
 *
 * R12-B additions:
 *   • Day / Week toggle (7 columns of 24h each in week mode)
 *   • Kind-filter chips: persisted in URL fragment (#kinds=user,goal)
 *   • Jump-to-date: <input type="date"> + prev/next day arrows
 *   • Dense ticks: hover tooltip (kind + excerpt); click pins the row
 *   • Sparkline at top showing per-hour activity volume
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  Chip,
  EmptyState,
  PageCell,
  PageGrid,
  ScrollList,
  Section,
  StatBlock,
  Toolbar,
  ToolbarButton,
  clockTime,
  usePoll,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { Scrubber } from './Scrubber';
import { Sparkline } from './Sparkline';
import { listDay } from './api';
import type { EpisodicKind, EpisodicItem } from './api';
import { readAndClearTimelineJump } from '../TodayPage/briefExport';

function initialAnchorDate(): Date {
  const iso = readAndClearTimelineJump();
  if (iso) return new Date(`${iso}T12:00:00`);
  return new Date();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_KINDS: ReadonlyArray<EpisodicKind> = [
  'perception', 'tool_call', 'tool_result', 'agent_step', 'user', 'answer', 'goal',
  'note', 'reflection', 'correction',
];

const KIND_TONE: Partial<Record<EpisodicKind, 'cyan' | 'amber' | 'violet' | 'green' | 'red' | 'pink' | 'gold' | 'teal' | 'dim'>> = {
  user: 'cyan',
  agent_step: 'violet',
  perception: 'amber',
  reflection: 'pink',
  note: 'dim',
  correction: 'red',
  goal: 'amber',
  tool_call: 'teal',
  tool_result: 'green',
  answer: 'gold',
};

const HASH_KEY = 'kinds';

// ---------------------------------------------------------------------------
// URL-fragment helpers — no router dep
// ---------------------------------------------------------------------------

function readKindsFromHash(): ReadonlySet<EpisodicKind> | null {
  try {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const raw = params.get(HASH_KEY);
    if (!raw) return null;
    const parsed = raw.split(',').filter((k): k is EpisodicKind =>
      (ALL_KINDS as ReadonlyArray<string>).includes(k),
    );
    return parsed.length > 0 ? new Set(parsed) : null;
  } catch {
    return null;
  }
}

function writeKindsToHash(active: ReadonlySet<EpisodicKind> | null): void {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (!active || active.size === 0) {
    params.delete(HASH_KEY);
  } else {
    params.set(HASH_KEY, [...active].join(','));
  }
  const str = params.toString();
  window.history.replaceState(null, '', str ? `#${str}` : window.location.pathname);
}

// ---------------------------------------------------------------------------
// Day bounds helpers
// ---------------------------------------------------------------------------

function dateToBounds(d: Date): { start: number; end: number; label: string; isoDate: string } {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  const start = Math.floor(copy.getTime() / 1000);
  const end = start + 86_400;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const isoDate = copy.toISOString().slice(0, 10);
  let label: string;
  if (copy.getTime() === today.getTime()) label = 'TODAY';
  else if (copy.getTime() === yesterday.getTime()) label = 'YESTERDAY';
  else label = copy.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase();
  return { start, end, label, isoDate };
}

function weekBounds(anchor: Date): ReadonlyArray<{ start: number; end: number; label: string }> {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(anchor);
    d.setDate(d.getDate() - (6 - i));
    return dateToBounds(d);
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TimelinePage() {
  const [viewMode, setViewMode] = useState<'day' | 'week'>('day');
  const [anchorDate, setAnchorDate] = useState<Date>(() => initialAnchorDate());
  const { start, end, label, isoDate } = useMemo(() => dateToBounds(anchorDate), [anchorDate]);

  // Kind filter — initialised from URL hash
  const [activeKinds, setActiveKinds] = useState<ReadonlySet<EpisodicKind> | null>(
    () => readKindsFromHash(),
  );

  // Persist kind filter to URL hash whenever it changes
  useEffect(() => {
    writeKindsToHash(activeKinds);
  }, [activeKinds]);

  const [hour, setHour] = useState<number | null>(null);
  const [pinnedRowId, setPinnedRowId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Day fetch
  const { data: items, loading, error, reload } = usePoll(
    () => listDay(start, end), 45_000, [start, end],
  );
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const rows = items ?? [];

  // Week fetch — one loader per column, lazily
  const weekDays = useMemo(() => weekBounds(anchorDate), [anchorDate]);
  const [weekData, setWeekData] = useState<ReadonlyArray<ReadonlyArray<EpisodicItem>>>([]);
  useEffect(() => {
    if (viewMode !== 'week') return;
    let alive = true;
    void (async () => {
      const results = await Promise.all(
        weekDays.map(d => listDay(d.start, d.end)),
      );
      if (alive) setWeekData(results);
    })();
    return () => { alive = false; };
  }, [viewMode, weekDays]);

  // Apply kind filter
  const filteredRows = useMemo(() => {
    if (!activeKinds || activeKinds.size === 0) return rows;
    return rows.filter(r => activeKinds.has(r.kind as EpisodicKind));
  }, [rows, activeKinds]);

  const hourRows = useMemo(() => {
    if (hour == null) return filteredRows;
    const hs = start + hour * 3600;
    const he = hs + 3600;
    return filteredRows.filter(r => r.created_at >= hs && r.created_at < he);
  }, [filteredRows, hour, start]);

  // Kind chip toggle
  const toggleKind = (k: EpisodicKind) => {
    setActiveKinds(prev => {
      if (!prev) {
        // Activating first filter: exclude this kind from "all"
        const next = new Set(ALL_KINDS.filter(x => x !== k) as EpisodicKind[]);
        return next.size === ALL_KINDS.length ? null : next.size === 0 ? null : next;
      }
      const next = new Set(prev);
      if (next.has(k)) { next.delete(k); } else { next.add(k); }
      return next.size === 0 ? null : next;
    });
  };

  const clearKinds = () => setActiveKinds(null);

  const shiftDay = useCallback((delta: number) => {
    setAnchorDate(prev => {
      const next = new Date(prev);
      next.setDate(next.getDate() + delta);
      const today = new Date();
      if (next > today) return prev;
      return next;
    });
    setHour(null);
  }, []);

  // Keyboard: ←/→ day (avoid re-binding every render)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') { setHour(null); setPinnedRowId(null); }
      if (e.key === 'ArrowLeft') shiftDay(-1);
      if (e.key === 'ArrowRight') shiftDay(1);
      if (e.key === 'r' || e.key === 'R') {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        reloadRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shiftDay]);

  const isToday = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const anchor = new Date(anchorDate); anchor.setHours(0, 0, 0, 0);
    return anchor.getTime() === today.getTime();
  }, [anchorDate]);

  const handlePickRow = (id: string) => {
    const row = rows.find(r => r.id === id);
    if (!row) return;
    const h = new Date(row.created_at * 1000).getHours();
    setHour(h);
    setPinnedRowId(id);
    queueMicrotask(() => {
      const el = listRef.current?.querySelector(`[data-row-id="${id}"]`);
      if (el && 'scrollIntoView' in el) {
        (el as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  };

  const kindsInData = useMemo(
    () => new Set(rows.map(r => r.kind as EpisodicKind)),
    [rows],
  );

  const visibleKindChips = ALL_KINDS.filter(k => kindsInData.has(k));

  return (
    <ModuleView title={viewMode === 'week' ? 'TIMELINE · WEEK' : 'TIMELINE · DAY'}>
      <PageGrid>
        {/* ---- Toolbar ---- */}
        <PageCell span={12}>
          <Toolbar>
            {/* — Date navigation group — */}
            <ToolbarButton onClick={() => shiftDay(-1)} tone="cyan">◀</ToolbarButton>
            <input
              type="date"
              value={isoDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={e => {
                if (!e.target.value) return;
                setAnchorDate(new Date(e.target.value + 'T12:00:00'));
                setHour(null);
              }}
              style={{
                background: 'rgba(4, 18, 28, 0.6)',
                border: '1px solid var(--line-soft)',
                color: 'var(--cyan)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                padding: '4px 8px',
                letterSpacing: '0.08em',
                cursor: 'pointer',
                colorScheme: 'dark',
              }}
              aria-label="Jump to date"
            />
            <div style={{
              padding: '4px 12px',
              fontFamily: 'var(--display)', fontSize: 11,
              letterSpacing: '0.24em', color: 'var(--cyan)', fontWeight: 800,
              borderLeft: '1px solid var(--line-soft)',
              borderRight: '1px solid var(--line-soft)',
            }}>{label}</div>
            <ToolbarButton onClick={() => shiftDay(1)} disabled={isToday} tone="cyan">▶</ToolbarButton>
            {!isToday && (
              <ToolbarButton onClick={() => { setAnchorDate(new Date()); setHour(null); }} tone="amber">TODAY</ToolbarButton>
            )}

            <div style={{ flex: 1 }} />

            {/* — View mode + AI — */}
            <div style={{
              display: 'inline-flex', gap: 0,
              border: '1px solid var(--line-soft)',
            }}>
              <ToolbarButton active={viewMode === 'day'} onClick={() => setViewMode('day')}>DAY</ToolbarButton>
              <ToolbarButton active={viewMode === 'week'} onClick={() => setViewMode('week')}>WEEK</ToolbarButton>
            </div>
            <ToolbarButton onClick={() => void reload()} title="Refresh (R)">REFRESH</ToolbarButton>
            {viewMode === 'day' && isToday && (
              <ToolbarButton
                tone="green"
                title="Jump the activity list to the current hour"
                onClick={() => {
                  setHour(new Date().getHours());
                  setPinnedRowId(null);
                }}
              >
                NOW
              </ToolbarButton>
            )}
            <ToolbarButton
              tone="violet"
              onClick={() => askSunny(`Summarize what I did on ${label.toLowerCase()} based on my episodic memory rows. Keep it 4 bullets.`, 'timeline')}
            >⬡ AI SUMMARY</ToolbarButton>
          </Toolbar>
        </PageCell>

        {/* ---- Kind-filter chips ---- */}
        <PageCell span={12}>
          <div style={{
            display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
            padding: '6px 10px',
            border: '1px solid var(--line-soft)',
            background: 'rgba(6, 14, 22, 0.35)',
          }}>
            <span style={{ fontFamily: 'var(--display)', fontSize: 8, color: 'var(--ink-dim)', letterSpacing: '0.26em', fontWeight: 700 }}>
              FILTER
            </span>
            {visibleKindChips.length === 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
                no kinds in view
              </span>
            )}
            {visibleKindChips.map(k => {
              const active = !activeKinds || activeKinds.has(k);
              return (
                <button
                  key={k}
                  onClick={() => toggleKind(k)}
                  style={{ all: 'unset', cursor: 'pointer' }}
                  aria-pressed={active}
                  title={active ? `Hide ${k}` : `Show ${k}`}
                >
                  <Chip
                    tone={active ? (KIND_TONE[k] ?? 'cyan') : 'dim'}
                    style={{
                      opacity: active ? 1 : 0.35,
                      transition: 'opacity 140ms, transform 140ms',
                      transform: active ? 'none' : 'scale(0.96)',
                    }}
                  >
                    {k.replace('_', ' ')}
                  </Chip>
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            {activeKinds && activeKinds.size > 0 && (
              <button
                onClick={clearKinds}
                style={{
                  all: 'unset', cursor: 'pointer',
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)',
                  letterSpacing: '0.14em', padding: '1px 6px',
                  border: '1px solid var(--line-soft)',
                }}
                title="Show all kinds"
              >
                × CLEAR
              </button>
            )}
          </div>
        </PageCell>

        {/* ---- Stats ---- */}
        <PageCell span={12}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <StatBlock label="EVENTS" value={String(rows.length)} sub="total on day" tone="cyan" />
            <StatBlock
              label="VISIBLE"
              value={String(filteredRows.length)}
              sub={activeKinds ? `${activeKinds.size} of ${ALL_KINDS.length} kinds` : 'no filter'}
              tone="amber"
            />
            <StatBlock
              label="ACTIVE HOURS"
              value={String(new Set(rows.map(r => Math.floor(r.created_at / 3600))).size)}
              sub="hours with activity"
              tone="violet"
            />
            <StatBlock
              label="FOCUS"
              value={hour != null ? `${hour.toString().padStart(2, '0')}:00` : '—'}
              sub={pinnedRowId ? 'row pinned · esc' : hour != null ? 'esc to clear' : 'click a tick'}
              tone="gold"
            />
          </div>
        </PageCell>

        {/* ---- Sparkline ---- */}
        <PageCell span={12}>
          <Section title="ACTIVITY" right={`${rows.length} events · ${new Set(rows.map(r => Math.floor(r.created_at / 3600))).size} active hours`}>
            <Sparkline
              items={filteredRows}
              dayStart={start}
              selectedHour={hour}
              onPick={h => { setHour(h); setPinnedRowId(null); }}
            />
          </Section>
        </PageCell>

        {/* ---- Week or Day scrubber ---- */}
        <PageCell span={12}>
          {viewMode === 'week' ? (
            <Section title="WEEK VIEW" right="7 days">
              <WeekGrid
                days={weekDays}
                weekData={weekData}
                onJumpDay={d => { setAnchorDate(d); setViewMode('day'); setHour(null); }}
              />
            </Section>
          ) : (
            <Section
              title="DAY"
              right={hour != null
                ? <span>hour {hour.toString().padStart(2, '0')}:00 · <span style={{ color: 'var(--ink-dim)' }}>esc to clear</span></span>
                : (loading && rows.length === 0 ? 'loading…' : 'click hour or tick')}
            >
              {error && rows.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <EmptyState title="Timeline unavailable" hint={error} />
                  <ToolbarButton onClick={reload}>RETRY</ToolbarButton>
                </div>
              ) : (
                <Scrubber
                  items={filteredRows}
                  dayStart={start}
                  dayEnd={end}
                  onPick={h => { setHour(h); setPinnedRowId(null); }}
                  onPickRow={handlePickRow}
                  selectedHour={hour}
                />
              )}
            </Section>
          )}
        </PageCell>

        {/* ---- Event list ---- */}
        {viewMode === 'day' && (
          <PageCell span={12}>
            <Section title={hour != null ? `HOUR ${hour.toString().padStart(2, '0')}:00` : 'ALL EVENTS'} right={`${hourRows.length}`}>
              {hourRows.length === 0 ? (
                <EmptyState
                  title="Nothing in this window"
                  hint={loading && rows.length === 0
                    ? 'Loading episodic rows…'
                    : hour != null
                      ? 'Pick another hour or press esc to clear the filter.'
                      : 'No episodic rows for this day.'}
                />
              ) : (
                <div ref={listRef}>
                  <ScrollList maxHeight={320}>
                    {hourRows.map(r => {
                      const pinned = r.id === pinnedRowId;
                      const tone = KIND_TONE[r.kind as EpisodicKind] ?? 'cyan';
                      const accentColor = tone === 'dim' ? 'var(--ink-dim)' : `var(--${tone})`;
                      return (
                        <div
                          key={r.id}
                          data-row-id={r.id}
                          onClick={() => setPinnedRowId(prev => prev === r.id ? null : r.id)}
                          style={{
                            display: 'flex', gap: 10,
                            padding: '7px 12px',
                            border: '1px solid var(--line-soft)',
                            borderLeft: `2px solid ${pinned ? 'var(--gold)' : accentColor}`,
                            background: pinned ? 'rgba(255, 209, 102, 0.06)' : 'transparent',
                            cursor: 'pointer',
                            transition: 'background 120ms',
                          }}
                          title={`${r.kind} · click to pin`}
                        >
                          <span style={{
                            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)',
                            flexShrink: 0, width: 52,
                          }}>{clockTime(r.created_at)}</span>
                          <Chip tone={tone}>{r.kind.replace('_', ' ')}</Chip>
                          <span style={{
                            flex: 1, fontFamily: 'var(--label)', fontSize: 12.5, color: 'var(--ink)',
                            overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                            WebkitLineClamp: pinned ? 6 : 2, WebkitBoxOrient: 'vertical',
                          }}>{r.text}</span>
                          {pinned && (
                            <span style={{ flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--gold)', letterSpacing: '0.14em', alignSelf: 'flex-start', marginTop: 2 }}>
                              PINNED
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </ScrollList>
                </div>
              )}
            </Section>
          </PageCell>
        )}
      </PageGrid>
    </ModuleView>
  );
}

// ---------------------------------------------------------------------------
// Week grid — 7 columns, each shows the day's hourly spark + event count
// ---------------------------------------------------------------------------

function WeekGrid({
  days,
  weekData,
  onJumpDay,
}: {
  days: ReadonlyArray<{ start: number; end: number; label: string }>;
  weekData: ReadonlyArray<ReadonlyArray<{ created_at: number; kind: string; id: string }>>;
  onJumpDay: (d: Date) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
      {days.map((day, i) => {
        const dayRows = weekData[i] ?? [];
        const counts = Array.from({ length: 24 }, (_, h) => {
          const hs = day.start + h * 3600;
          const he = hs + 3600;
          return dayRows.filter(r => r.created_at >= hs && r.created_at < he).length;
        });
        const max = Math.max(1, ...counts);
        const d = new Date(day.start * 1000);
        const dayLabel = d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
        const dayNum = d.getDate();
        return (
          <button
            key={day.start}
            onClick={() => onJumpDay(d)}
            style={{
              all: 'unset', cursor: 'pointer',
              border: '1px solid var(--line-soft)',
              background: 'rgba(6,14,22,0.55)',
              padding: '8px 6px',
              display: 'flex', flexDirection: 'column', gap: 6,
              transition: 'border-color 140ms',
            }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = 'var(--cyan)'); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = 'var(--line-soft)'); }}
            title={`${day.label} · ${dayRows.length} events — click to drill in`}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.2em', color: 'var(--cyan)' }}>{dayLabel}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)' }}>{dayNum}</span>
            </div>
            {/* mini bar chart */}
            <svg viewBox={`0 0 24 16`} width="100%" height={16} preserveAspectRatio="none" style={{ display: 'block' }}>
              {counts.map((c, h) => {
                const barH = c === 0 ? 0.5 : Math.max(1, (c / max) * 16);
                return (
                  <rect
                    key={h}
                    x={h} y={16 - barH} width={0.8} height={barH}
                    fill={c === 0 ? 'rgba(57,229,255,0.08)' : 'var(--cyan)'}
                    fillOpacity={0.7}
                  />
                );
              })}
            </svg>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)', textAlign: 'center' }}>
              {dayRows.length}
            </div>
          </button>
        );
      })}
    </div>
  );
}
