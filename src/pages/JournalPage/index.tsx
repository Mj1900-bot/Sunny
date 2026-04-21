/**
 * JOURNAL — AI-written daily diary built from episodic memory.
 *
 * Features:
 *   • Mood chip row in the composer — saved as mood:<id> tag
 *   • Word count + read time displayed below textarea
 *   • Streak indicator — consecutive calendar days with a note entry
 *   • DayGroup shows dominant mood glyph in the section header
 *   • WEEK DIGEST and MONTH DIGEST AI buttons
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, EmptyState, StatBlock, ScrollList, Toolbar, ToolbarButton, Chip,
  usePoll,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { useView } from '../../store/view';
import { DayGroup } from './DayGroup';
import { MOOD_OPTIONS } from './moods';
import { addJournalEntry, listEpisodic, type EpisodicItem } from './api';

const DRAFT_KEY = 'sunny.journal.draft';
const MOOD_KEY  = 'sunny.journal.mood';
const AVG_WPM   = 200;

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return 'TODAY';
  if (diff === 1) return 'YESTERDAY';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function groupByDay(items: ReadonlyArray<EpisodicItem>): Array<[string, EpisodicItem[]]> {
  const map = new Map<string, EpisodicItem[]>();
  for (const it of items) {
    const key = dayLabel(it.created_at);
    const arr = map.get(key) ?? [];
    arr.push(it);
    map.set(key, arr);
  }
  return Array.from(map.entries());
}

/** Compute consecutive days with at least one 'note' entry, ending today. */
function computeStreak(items: ReadonlyArray<EpisodicItem>): number {
  const noteDays = new Set(
    items
      .filter(it => it.kind === 'note')
      .map(it => {
        const d = new Date(it.created_at * 1000);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      }),
  );

  let streak = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let cursor = today.getTime();

  while (noteDays.has(cursor)) {
    streak++;
    cursor -= 86_400_000;
  }
  return streak;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function JournalPage() {
  const [text, setText] = useState<string>(() => {
    try { return localStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
  });
  const [mood, setMood] = useState<string | null>(() => {
    try { return localStorage.getItem(MOOD_KEY); } catch { return null; }
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [entrySearch, setEntrySearch] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fetchCap = useView(s => s.settings.journalFetchCap);
  const { data: items, loading, error, reload } = usePoll(() => listEpisodic(fetchCap), 30_000, [fetchCap]);

  useEffect(() => {
    try {
      if (text) localStorage.setItem(DRAFT_KEY, text);
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* ignore */ }
  }, [text]);

  // Auto-grow textarea with content (capped so the composer doesn't eat the page).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    const target = Math.min(280, Math.max(84, el.scrollHeight));
    el.style.height = `${target}px`;
  }, [text]);

  useEffect(() => {
    try {
      if (mood) localStorage.setItem(MOOD_KEY, mood);
      else localStorage.removeItem(MOOD_KEY);
    } catch { /* ignore */ }
  }, [mood]);

  const searchItems = useMemo(() => {
    const raw = items ?? [];
    const s = entrySearch.trim().toLowerCase();
    if (!s) return raw;
    return raw.filter(it =>
      it.text.toLowerCase().includes(s) ||
      it.tags.some(t => t.toLowerCase().includes(s)) ||
      it.kind.toLowerCase().includes(s),
    );
  }, [items, entrySearch]);
  const grouped = useMemo(() => groupByDay(searchItems), [searchItems]);
  const todayItems = grouped.find(([d]) => d === 'TODAY')?.[1] ?? [];
  const streak = useMemo(() => computeStreak(items ?? []), [items]);
  const searchActive = entrySearch.trim().length > 0;

  const words = wordCount(text);
  const readTimeSecs = Math.max(1, Math.round((words / AVG_WPM) * 60));
  const readTimeLabel = readTimeSecs < 60
    ? `${readTimeSecs}s read`
    : `${Math.ceil(readTimeSecs / 60)}m read`;

  const submit = async () => {
    if (saving) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    setSaveError(null);
    try {
      const tags = ['journal', ...(mood ? [`mood:${mood}`] : [])];
      await addJournalEntry(trimmed, tags);
      setText('');
      setMood(null);
      try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(MOOD_KEY); } catch { /* ignore */ }
      reload();
      textareaRef.current?.focus();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModuleView title="JOURNAL · EPISODIC">
      <PageGrid>
        {/* Stats row */}
        <PageCell span={12}>
          <Toolbar style={{ marginBottom: 8 }}>
            <ToolbarButton onClick={() => void reload()}>REFRESH</ToolbarButton>
            <input
              value={entrySearch}
              onChange={e => setEntrySearch(e.target.value)}
              placeholder="search entries…"
              aria-label="Search journal entries by text, tag, or kind"
              style={{
                width: 180,
                marginLeft: 4,
                padding: '5px 8px',
                fontFamily: 'var(--mono)', fontSize: 10,
                letterSpacing: '0.06em',
                color: 'var(--ink)',
                background: 'rgba(0,0,0,0.35)',
                border: '1px solid var(--line-soft)',
                outline: 'none',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--cyan)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--line-soft)'; }}
            />
            {searchActive && (
              <>
                <Chip tone="amber" style={{ fontSize: 8 }}>{searchItems.length} match{searchItems.length === 1 ? '' : 'es'}</Chip>
                <ToolbarButton onClick={() => setEntrySearch('')}>CLEAR</ToolbarButton>
              </>
            )}
            <Chip tone="dim" style={{ fontSize: 8 }}>poll · 30s · cap {fetchCap}</Chip>
          </Toolbar>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            <StatBlock
              label={searchActive ? 'MATCHES' : 'TOTAL'}
              value={String(searchActive ? searchItems.length : (items ?? []).length)}
              sub={searchActive ? `${(items ?? []).length} in memory` : undefined}
              tone="cyan"
            />
            <StatBlock label="TODAY"       value={String(todayItems.length)}                                                tone="amber" />
            <StatBlock label="NOTES"       value={String((items ?? []).filter(i => i.kind === 'note').length)}              tone="gold" />
            <StatBlock label="REFLECTIONS" value={String((items ?? []).filter(i => i.kind === 'reflection').length)}        tone="pink" />
            <StatBlock label="STREAK"      value={streak > 0 ? `${streak}d` : '—'} sub={streak > 0 ? 'consecutive days' : 'no streak yet'} tone={streak >= 7 ? 'green' : streak >= 3 ? 'amber' : 'teal'} />
          </div>
        </PageCell>

        {/* Composer */}
        <PageCell span={12}>
          <div style={{
            border: '1px solid var(--line-soft)',
            borderLeft: '3px solid var(--gold)',
            background: 'rgba(255, 209, 102, 0.04)',
            padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{
              fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.26em',
              color: 'var(--gold)', fontWeight: 700,
            }}>NEW ENTRY</div>

            {/* Mood picker */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.1em' }}>
                MOOD
              </span>
              {MOOD_OPTIONS.map(m => (
                <button
                  key={m.id}
                  onClick={() => setMood(prev => prev === m.id ? null : m.id)}
                  title={m.label}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 8px',
                    fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.16em',
                    fontWeight: 700,
                    color: mood === m.id ? '#fff' : `var(--${m.tone})`,
                    border: `1px solid var(--${m.tone})`,
                    background: mood === m.id ? `var(--${m.tone})33` : 'rgba(0,0,0,0.25)',
                    transition: 'background 120ms ease',
                  }}
                >
                  <span>{m.glyph}</span>
                  <span>{m.label}</span>
                </button>
              ))}
            </div>

            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                } else if (e.key === 'Escape') {
                  setText('');
                }
              }}
              disabled={saving}
              placeholder="what happened, how you're feeling, what you noticed…  (⌘↵ to save, Esc to clear)"
              rows={3}
              aria-label="new journal entry"
              style={{
                all: 'unset', boxSizing: 'border-box', width: '100%',
                padding: '10px 12px',
                fontFamily: 'var(--label)', fontSize: 14, lineHeight: 1.55,
                color: 'var(--ink)',
                border: '1px solid var(--line-soft)',
                background: 'rgba(0, 0, 0, 0.35)',
                minHeight: 84,
                maxHeight: 280,
                resize: 'none',
                overflowY: 'auto',
                opacity: saving ? 0.6 : 1,
                transition: 'border-color 140ms ease, background 140ms ease',
              }}
              onFocus={e => {
                e.currentTarget.style.borderColor = 'var(--gold)';
                e.currentTarget.style.background = 'rgba(255, 209, 102, 0.04)';
              }}
              onBlur={e => {
                e.currentTarget.style.borderColor = 'var(--line-soft)';
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.35)';
              }}
            />

            {/* Word count + read time */}
            {words > 0 && (
              <div style={{
                display: 'flex', gap: 12, alignItems: 'center',
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
                letterSpacing: '0.1em',
              }}>
                <span>{words} {words === 1 ? 'word' : 'words'}</span>
                <span style={{ color: 'var(--line-soft)' }}>·</span>
                <span>{readTimeLabel}</span>
              </div>
            )}

            {saveError && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)' }}>
                {saveError}
              </div>
            )}

            <Toolbar>
              <ToolbarButton onClick={() => void submit()} disabled={!text.trim() || saving} tone="amber">
                {saving ? 'SAVING…' : 'SAVE ENTRY'}
              </ToolbarButton>
              {text.length > 0 && (
                <ToolbarButton onClick={() => { setText(''); try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }}>
                  CLEAR DRAFT
                </ToolbarButton>
              )}
              <ToolbarButton
                tone="violet"
                onClick={() => askSunny(
                  `Write a journal entry for today in my voice, summarizing my day from the episodic memory. Keep it 3 short paragraphs: what happened, what I learned, what's next.`,
                  'journal',
                )}
              >AI DIGEST TODAY</ToolbarButton>
              <ToolbarButton
                tone="cyan"
                onClick={() => askSunny(
                  `Write a rich personal journal digest for the past 7 days. Pull from my episodic memory. Structure it as: key wins, struggles, patterns noticed, and one thing I should do differently next week. Keep it personal and direct.`,
                  'journal-week',
                )}
              >WEEK DIGEST</ToolbarButton>
              <ToolbarButton
                tone="teal"
                onClick={() => askSunny(
                  `Write a month-in-review journal entry based on my episodic memory for the past 30 days. Cover: major accomplishments, recurring challenges, emotional arc, and the single most important insight from this month. Be honest and specific.`,
                  'journal-month',
                )}
              >MONTH DIGEST</ToolbarButton>
            </Toolbar>
          </div>
        </PageCell>

        {/* Entry list */}
        <PageCell span={12}>
          {!items && loading ? (
            <EmptyState title="Loading journal" hint="Reading episodic memory…" />
          ) : error && !items ? (
            <EmptyState title="Journal unavailable" hint={error} />
          ) : grouped.length === 0 ? (
            <EmptyState
              title={searchActive ? 'No matches' : 'No entries yet'}
              hint={searchActive
                ? `Nothing in episodic memory matches “${entrySearch.trim()}”. Try another word or clear search.`
                : 'Episodic memory is empty. Either the memory DB hasn\'t initialized or this is a fresh install.'}
            />
          ) : (
            <ScrollList maxHeight={560}>
              {grouped.map(([label, dayItems]) => (
                <DayGroup key={label} label={label} items={dayItems} />
              ))}
            </ScrollList>
          )}
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
