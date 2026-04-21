/**
 * BriefHeader — top-of-page banner for Today.
 *
 * Renders:
 *   • Time-of-day greeting with date
 *   • Streak chip (localStorage "opened before 9am" counter)
 *   • One-sentence world snapshot
 *   • AI BRIEF button — invokes chat with a compound morning-brief prompt
 */

import { useState, useEffect, useCallback } from 'react';
import { Chip, ToolbarButton } from '../_shared';
import { useSunny } from '../../hooks/useSunny';
import type { TodayBrief } from './api';

// ── Streak helpers ──────────────────────────────────────────────────────────

const STREAK_KEY = 'sunny.today.earlyStreak.v1';
const LAST_OPEN_KEY = 'sunny.today.lastOpenDate.v1';

type StreakData = { count: number; updated: string };

function loadStreak(): StreakData {
  try {
    const raw = localStorage.getItem(STREAK_KEY);
    if (!raw) return { count: 0, updated: '' };
    return JSON.parse(raw) as StreakData;
  } catch {
    return { count: 0, updated: '' };
  }
}

function bumpStreakIfEarly(): number {
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  try {
    const lastOpen = localStorage.getItem(LAST_OPEN_KEY) ?? '';
    localStorage.setItem(LAST_OPEN_KEY, today);
    if (lastOpen === today) return loadStreak().count; // already counted today
    const current = loadStreak();
    const hour = new Date().getHours();
    const newCount = hour < 9 ? current.count + 1 : 0;
    const next: StreakData = { count: newCount, updated: today };
    localStorage.setItem(STREAK_KEY, JSON.stringify(next));
    return newCount;
  } catch {
    return 0;
  }
}

// ── Time-of-day ─────────────────────────────────────────────────────────────

type TimeOfDay = 'night' | 'morning' | 'afternoon' | 'evening' | 'late';

function getTimeOfDay(h: number): TimeOfDay {
  if (h < 5)  return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'late';
}

const GREETINGS: Record<TimeOfDay, string> = {
  night:     'Still up',
  morning:   'Good morning',
  afternoon: 'Good afternoon',
  evening:   'Good evening',
  late:      'Still up',
};

const BANNERS: Record<TimeOfDay, { label: string; accent: 'gold' | 'cyan' | 'amber' | 'violet' }> = {
  night:     { label: 'LATE NIGHT · BRIEF', accent: 'violet' },
  morning:   { label: 'MORNING BRIEF',      accent: 'gold'   },
  afternoon: { label: 'AFTERNOON BRIEF',    accent: 'amber'  },
  evening:   { label: 'EVENING WRAP',       accent: 'cyan'   },
  late:      { label: 'LATE BRIEF',         accent: 'violet' },
};

// ── World sentence ───────────────────────────────────────────────────────────

function worldLine(b: TodayBrief): string | null {
  const w = b.world;
  if (!w) return null;
  const bits: string[] = [];
  const focus = w.focus?.app_name?.trim();
  if (focus) bits.push(`focused on ${focus}`);
  const activity = w.activity === 'unknown' ? null : w.activity;
  if (activity) bits.push(activity);
  if (typeof w.battery_pct === 'number') {
    bits.push(`${Math.round(w.battery_pct)}%${w.battery_charging ? ' charging' : ''}`);
  }
  if (bits.length === 0) return null;
  return `World · ${bits.join(' · ')}.`;
}

// ── Weather line ─────────────────────────────────────────────────────────────

function weatherLine(b: TodayBrief): string | null {
  const w = b.weather;
  if (!w) return null;
  return `${w.city} · ${Math.round(w.temp_c)}°C · ${w.condition}`;
}

// ── Brief prompt builder ──────────────────────────────────────────────────────

function buildBriefPrompt(b: TodayBrief): string {
  const events = b.events.slice(0, 3).map(e =>
    `${new Date(e.start_iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${e.title}`,
  ).join('; ') || 'no events';

  const urgentCount = b.recentMail.filter(m =>
    ['urgent', 'asap', 'deadline', 'overdue', 'today'].some(kw =>
      (m.subject + m.from).toLowerCase().includes(kw),
    ),
  ).length;

  const overdueReminders = b.reminders.filter(r =>
    r.due && new Date(r.due).getTime() < Date.now(),
  ).length;

  const priorities = b.priorities.map(p => p.text.slice(0, 80)).join('; ') || 'none stored';
  const weatherStr = weatherLine(b) ?? 'no weather data';

  return (
    `Give me a crisp spoken morning brief. Use Sunny's British butler voice. ` +
    `AGENDA: ${events}. ` +
    `URGENT: ${urgentCount} urgent mail, ${overdueReminders} overdue reminders, ${b.unreadMail} total unread. ` +
    `CONTEXT: ${weatherStr}. ` +
    `TOP PRIORITIES from my memory: ${priorities}. ` +
    `Summarise in 3-4 sentences. Speak it aloud.`
  );
}

// ── Streak chip label ────────────────────────────────────────────────────────

function streakLabel(count: number): string {
  if (count === 0) return 'NEW STREAK';
  if (count === 1) return '1 DAY';
  if (count < 7)   return `${count} DAYS`;
  if (count < 30)  return `${count} DAY STREAK 🔥`;
  return `${count}D LEGEND`;
}

// ── Component ────────────────────────────────────────────────────────────────

export function BriefHeader({ brief }: { brief: TodayBrief }) {
  const { chat, speak } = useSunny();
  const [briefing, setBriefing] = useState<'idle' | 'loading' | 'done'>('idle');
  const [streak] = useState<number>(() => bumpStreakIfEarly());

  const now = new Date();
  const tod = getTimeOfDay(now.getHours());
  const banner = BANNERS[tod];
  const greeting = GREETINGS[tod];

  const dateStr = now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const world = worldLine(brief);
  const weather = weatherLine(brief);

  const handleBrief = useCallback(async () => {
    if (briefing === 'loading') return;
    setBriefing('loading');
    try {
      const prompt = buildBriefPrompt(brief);
      const response = await chat(prompt);
      await speak(response);
      setBriefing('done');
    } catch {
      setBriefing('idle');
    }
  }, [brief, chat, speak, briefing]);

  // Reset "done" indicator after 4s
  useEffect(() => {
    if (briefing !== 'done') return;
    const h = window.setTimeout(() => setBriefing('idle'), 4_000);
    return () => clearTimeout(h);
  }, [briefing]);

  const accentColor = `var(--${banner.accent})`;

  return (
    <div style={{
      border: '1px solid var(--line-soft)',
      borderLeft: `3px solid ${accentColor}`,
      background: `linear-gradient(90deg, rgba(255,209,102,0.06), transparent 60%)`,
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      position: 'relative',
    }}>
      {/* Top row: banner label + streak chip */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{
          fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.32em',
          color: accentColor, fontWeight: 800,
        }}>
          {banner.label} · {dateStr.toUpperCase()}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {streak > 0 && (
            <Chip tone={streak >= 7 ? 'gold' : 'amber'} style={{ fontSize: 8, letterSpacing: '0.14em' }}>
              {streakLabel(streak)}
            </Chip>
          )}
          {now.getHours() < 9 && (
            <Chip tone="violet" style={{ fontSize: 8, letterSpacing: '0.14em' }} title="Early-bird window (before 9:00)">
              EARLY
            </Chip>
          )}
        </div>
      </div>

      {/* Greeting */}
      <div style={{
        fontFamily: 'var(--label)', fontSize: 20, fontWeight: 600,
        color: 'var(--ink)', lineHeight: 1.2,
      }}>
        {greeting}.
      </div>

      {/* Context lines */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {weather && (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--cyan)',
            letterSpacing: '0.05em', opacity: 0.9,
          }}>
            {weather}
          </div>
        )}
        {world && (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
            letterSpacing: '0.04em', opacity: 0.8,
          }}>
            {world}
          </div>
        )}
      </div>

      {/* AI BRIEF button */}
      <div style={{ marginTop: 4 }}>
        <ToolbarButton
          tone="gold"
          onClick={handleBrief}
          active={briefing === 'done'}
          disabled={briefing === 'loading'}
        >
          {briefing === 'loading' ? 'COMPILING BRIEF…' : briefing === 'done' ? 'BRIEF DELIVERED' : 'AI BRIEF'}
        </ToolbarButton>
      </div>
    </div>
  );
}
