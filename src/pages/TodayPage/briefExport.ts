/**
 * Plain-text export of the Today brief for clipboard / sharing.
 */

import type { TodayBrief } from './api';

const TIMELINE_JUMP_KEY = 'sunny.timeline.jumpISO';

/** Persist so Timeline opens on this calendar day (YYYY-MM-DD). */
export function stashTimelineJump(isoDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return;
  try {
    sessionStorage.setItem(TIMELINE_JUMP_KEY, isoDate);
  } catch { /* ignore */ }
}

export function readAndClearTimelineJump(): string | null {
  try {
    const v = sessionStorage.getItem(TIMELINE_JUMP_KEY);
    if (v) sessionStorage.removeItem(TIMELINE_JUMP_KEY);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function buildBriefPlainText(brief: TodayBrief, nowMs: number): string {
  const lines: string[] = [];
  const d = new Date(nowMs);
  lines.push(`SUNNY · TODAY BRIEF`);
  lines.push(d.toLocaleString(undefined, { weekday: 'long', dateStyle: 'medium', timeStyle: 'short' }));
  lines.push('');

  if (brief.weather) {
    const w = brief.weather;
    lines.push(`WEATHER · ${w.city} · ${Math.round(w.temp_c)}°C · ${w.condition}`);
    lines.push('');
  }

  if (brief.world) {
    const w = brief.world;
    const bits: string[] = [];
    if (w.focus?.app_name) bits.push(`focus: ${w.focus.app_name}`);
    if (w.activity && w.activity !== 'unknown') bits.push(`activity: ${w.activity}`);
    if (typeof w.battery_pct === 'number') {
      bits.push(`battery: ${Math.round(w.battery_pct)}%${w.battery_charging ? ' (charging)' : ''}`);
    }
    if (bits.length) lines.push(`WORLD · ${bits.join(' · ')}`, '');
  }

  lines.push('— SCHEDULE —');
  if (brief.events.length === 0) lines.push('(no events)');
  else {
    for (const e of brief.events) {
      const loc = e.location ? ` @ ${e.location}` : '';
      lines.push(`· ${fmtTime(e.start_iso)}–${fmtTime(e.end_iso)}  ${e.title}${loc}`);
    }
  }
  lines.push('');

  lines.push('— TASKS (open) —');
  if (brief.reminders.length === 0) lines.push('(none)');
  else {
    for (const r of brief.reminders.slice(0, 20)) {
      const due = r.due ? `  due ${r.due}` : '';
      lines.push(`· [${r.list}] ${r.title}${due}`);
    }
  }
  lines.push('');

  lines.push(`— MAIL · ${brief.unreadMail} unread —`);
  if (brief.recentMail.length === 0) lines.push('(no recent unread in list)');
  else {
    for (const m of brief.recentMail.slice(0, 8)) {
      lines.push(`· ${m.from.split(' <')[0]} — ${m.subject}`);
    }
  }
  lines.push('');

  lines.push('— MESSAGES —');
  if (brief.messages.length === 0) lines.push('(none)');
  else {
    for (const m of brief.messages.slice(0, 8)) {
      lines.push(`· ${m.display}  (${m.unread_count} unread) — ${m.last_message.slice(0, 120)}`);
    }
  }
  lines.push('');

  lines.push('— PRIORITIES —');
  if (brief.priorities.length === 0) lines.push('(none tagged)');
  else {
    for (const p of brief.priorities) lines.push(`· ${p.text}`);
  }

  return lines.join('\n');
}
