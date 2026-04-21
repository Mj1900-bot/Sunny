import type { CalEvent, TauriEvent, Tone } from './types';
import { LOCAL_STORAGE_KEY, LEGACY_STORAGE_KEYS, HIDDEN_CAL_KEY } from './constants';

export function isTone(v: unknown): v is Tone {
  return v === 'normal' || v === 'amber' || v === 'now';
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fromISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(n => Number.parseInt(n, 10));
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function toLocalDateTimeISO(d: Date): string {
  return `${toISO(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function sanitizeLocalEvent(raw: unknown): CalEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  if (typeof r.dayISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.dayISO)) return null;
  if (typeof r.time !== 'string' || typeof r.title !== 'string') return null;
  const sub = typeof r.sub === 'string' ? r.sub : '';
  const tone: Tone = isTone(r.tone) ? r.tone : 'normal';
  const source = typeof r.source === 'string' ? r.source : 'LOCAL';
  return { id: r.id, dayISO: r.dayISO, time: r.time, title: r.title, sub, tone, source };
}

export function loadLocalEvents(): CalEvent[] {
  try {
    for (const legacy of LEGACY_STORAGE_KEYS) {
      if (localStorage.getItem(legacy) !== null) localStorage.removeItem(legacy);
    }
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeLocalEvent).filter((e): e is CalEvent => e !== null);
  } catch (error) {
    console.error('Failed to load local events:', error);
    return [];
  }
}

export function saveLocalEvents(events: ReadonlyArray<CalEvent>): void {
  try {
    const onlyLocal = events.filter(e => e.source === 'LOCAL');
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(onlyLocal));
  } catch (error) {
    console.error('Failed to save local events:', error);
  }
}

export function loadHiddenCalendars(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_CAL_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

export function saveHiddenCalendars(hidden: ReadonlySet<string>): void {
  try {
    localStorage.setItem(HIDDEN_CAL_KEY, JSON.stringify(Array.from(hidden)));
  } catch {
    /* ignore */
  }
}

export function makeLocalId(): string {
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function mondayIndex(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 6 : js - 1;
}

export function addDays(base: Date, delta: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + delta);
  return d;
}

export function buildMonthGrid(anchor: Date): ReadonlyArray<Date> {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = mondayIndex(first);
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function buildWeekDays(anchor: Date): ReadonlyArray<Date> {
  const weekStart = addDays(anchor, -mondayIndex(anchor));
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function toneClass(tone: Tone): string {
  return tone === 'normal' ? '' : tone;
}

export function toneColor(tone: Tone): string {
  return tone === 'amber' ? 'var(--amber)' : tone === 'now' ? 'var(--green)' : 'var(--cyan)';
}

/** Deterministic-but-pleasant color for a macOS calendar name. */
export function calendarColor(name: string): string {
  const palette = [
    'var(--cyan)', 'var(--green)', 'var(--amber)', 'var(--violet)',
    '#7dd3fc', '#f9a8d4', '#fca5a5', '#86efac',
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

export function formatTime(date: Date, allDay: boolean): string {
  if (allDay) return 'ALL-DAY';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function toneFromEvent(start: Date, end: Date, now: Date): Tone {
  if (start <= now && end > now) return 'now';
  const lead = (start.getTime() - now.getTime()) / 60_000; // minutes
  if (lead > 0 && lead <= 20) return 'amber';
  return 'normal';
}

export function durationMinutes(startISO: string, endISO: string): number {
  const a = new Date(startISO).getTime();
  const b = new Date(endISO).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 60_000));
}

export function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

export function normalizeTauriEvent(e: TauriEvent, now: Date): CalEvent {
  const start = new Date(e.start);
  const end = new Date(e.end);
  const time = e.all_day ? 'ALL-DAY' : formatTime(start, false);
  const dur = durationMinutes(e.start, e.end);
  const subParts: string[] = [];
  if (e.location) subParts.push(e.location);
  if (!e.all_day && dur > 0) subParts.push(fmtDuration(dur));
  return {
    id: e.id,
    dayISO: toISO(start),
    time,
    title: e.title || '(no title)',
    sub: subParts.join(' · '),
    tone: toneFromEvent(start, end, now),
    source: e.calendar || 'Calendar',
    location: e.location,
    notes: e.notes,
    startISO: e.start,
    endISO: e.end,
  };
}
