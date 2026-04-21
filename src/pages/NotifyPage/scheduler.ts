/**
 * Scheduled notification engine — persisted in localStorage, fired via
 * setInterval while the app is open. Each schedule entry stores the
 * human-authored phrase (e.g. "drink water every 45 min") alongside the
 * resolved interval in milliseconds so we can display it clearly.
 *
 * The engine is intentionally side-effect-free on import: call
 * `startScheduler()` once at app boot (or on first render of NotifyPage).
 */

import { sendMacNotification } from './store';

export type Schedule = {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly body: string;
  readonly intervalMs: number;
  readonly enabled: boolean;
  /** Unix ms of the last fire. */
  readonly lastFired: number;
};

const KEY = 'sunny.notify.schedules.v1';

function load(): Schedule[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Schedule[];
    }
  } catch { /* ignore */ }
  return [];
}

function save(schedules: ReadonlyArray<Schedule>): void {
  try { localStorage.setItem(KEY, JSON.stringify(schedules)); } catch { /* ignore */ }
}

let _schedules: Schedule[] = load();
const _subs = new Set<() => void>();

function notify(): void { _subs.forEach(fn => fn()); }

export function subscribeSchedules(fn: () => void): () => void {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

export function getSchedules(): ReadonlyArray<Schedule> { return _schedules; }

export function addSchedule(s: Omit<Schedule, 'id' | 'lastFired' | 'enabled'>): Schedule {
  const entry: Schedule = {
    ...s,
    id: `s-${Date.now().toString(36)}`,
    enabled: true,
    lastFired: 0,
  };
  _schedules = [entry, ..._schedules];
  save(_schedules);
  notify();
  return entry;
}

export function toggleSchedule(id: string): void {
  _schedules = _schedules.map(s =>
    s.id === id ? { ...s, enabled: !s.enabled, lastFired: Date.now() } : s,
  );
  save(_schedules);
  notify();
}

export function removeSchedule(id: string): void {
  _schedules = _schedules.filter(s => s.id !== id);
  save(_schedules);
  notify();
}

let _timerHandle: ReturnType<typeof setInterval> | null = null;

/** Call once. Checks all enabled schedules every 30s. */
export function startScheduler(): void {
  if (_timerHandle !== null) return;
  _timerHandle = setInterval(() => {
    const now = Date.now();
    _schedules.forEach(s => {
      if (!s.enabled) return;
      if (now - s.lastFired >= s.intervalMs) {
        void sendMacNotification(s.title, s.body, null).catch(() => null);
        _schedules = _schedules.map(x =>
          x.id === s.id ? { ...x, lastFired: now } : x,
        );
        save(_schedules);
        notify();
      }
    });
  }, 30_000);
}

/** Parse a natural-language phrase like "drink water every 45 min". */
export function parseSchedulePhrase(phrase: string): { title: string; body: string; intervalMs: number } | null {
  const lower = phrase.toLowerCase();

  // Extract interval: "every N min[utes]" or "every N hour[s]" or "every N sec[onds]"
  const minMatch = lower.match(/every\s+(\d+)\s*min/);
  const hrMatch  = lower.match(/every\s+(\d+)\s*h(our)?/);
  const secMatch = lower.match(/every\s+(\d+)\s*sec/);

  let intervalMs = 0;
  if (minMatch) intervalMs = Number(minMatch[1]) * 60_000;
  else if (hrMatch) intervalMs = Number(hrMatch[1]) * 3_600_000;
  else if (secMatch) intervalMs = Number(secMatch[1]) * 1_000;

  if (intervalMs < 10_000) return null; // < 10 s is nonsensical

  // Extract message: everything before "every"
  const everyIdx = lower.indexOf('every');
  const rawTitle = everyIdx > 0
    ? phrase.slice(0, everyIdx).trim().replace(/^(send me|remind me|tell me|notify me)\s+/i, '').trim()
    : phrase.trim();

  const title = rawTitle
    ? rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1)
    : 'Reminder';

  return { title, body: '', intervalMs };
}
