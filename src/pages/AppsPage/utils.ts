import type { Category, SortKey, ViewMode } from './types';
import {
  SYS_PAT,
  DEV_PAT,
  DESIGN_PAT,
  MEDIA_PAT,
  GAMES_PAT,
  PROD_PAT,
  UTIL_PAT,
  LAUNCHES_KEY,
  VIEW_KEY,
  SORT_KEY,
  RECENT_MAX,
} from './constants';

export function classify(name: string): Category {
  if (SYS_PAT.test(name)) return 'SYSTEM';
  if (DEV_PAT.test(name)) return 'DEVELOPER';
  if (DESIGN_PAT.test(name)) return 'DESIGN';
  if (MEDIA_PAT.test(name)) return 'MEDIA';
  if (GAMES_PAT.test(name)) return 'GAMES';
  if (PROD_PAT.test(name)) return 'PRODUCTIVITY';
  if (UTIL_PAT.test(name)) return 'UTILITIES';
  return 'OTHER';
}

export function loadStringList(key: string, max: number): readonly string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, max);
  } catch (err) {
    console.error(`Failed to load ${key}`, err);
    return [];
  }
}

export function saveStringList(key: string, list: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch (err) {
    console.error(`Failed to save ${key}`, err);
  }
}

export function loadLaunchCounts(): Readonly<Record<string, number>> {
  try {
    const raw = localStorage.getItem(LAUNCHES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLaunchCounts(counts: Readonly<Record<string, number>>): void {
  try {
    localStorage.setItem(LAUNCHES_KEY, JSON.stringify(counts));
  } catch {
    /* ignore */
  }
}

export function loadView(): ViewMode {
  const raw = localStorage.getItem(VIEW_KEY);
  return raw === 'list' ? 'list' : 'grid';
}

export function loadSort(): SortKey {
  const raw = localStorage.getItem(SORT_KEY);
  return raw === 'recent' || raw === 'launches' ? raw : 'name';
}

export function pushRecent(prev: readonly string[], name: string): readonly string[] {
  const filtered = prev.filter(n => n !== name);
  return [name, ...filtered].slice(0, RECENT_MAX);
}

export function toggleFav(prev: readonly string[], name: string): readonly string[] {
  return prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
}

export function initialsOf(name: string): string {
  return name
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .toLowerCase();
}

export function matches(name: string, path: string, q: string): boolean {
  if (!q) return true;
  const lower = name.toLowerCase();
  if (lower.includes(q)) return true;
  if (initialsOf(name).includes(q)) return true;
  if (path.toLowerCase().includes(q)) return true;
  return false;
}

// ── Timed launch events (heatmap + weekly chip) ────────────────────────────

import {
  LAUNCH_EVENTS_KEY,
  LAUNCH_EVENTS_MAX,
  WEEKLY_WINDOW_DAYS,
} from './constants';

/** A single recorded launch event stored as a compact pair [name, unixMs]. */
export type LaunchEvent = readonly [string, number];

export function loadLaunchEvents(): readonly LaunchEvent[] {
  try {
    const raw = localStorage.getItem(LAUNCH_EVENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is LaunchEvent =>
        Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number',
    );
  } catch {
    return [];
  }
}

export function saveLaunchEvents(events: readonly LaunchEvent[]): void {
  try {
    localStorage.setItem(LAUNCH_EVENTS_KEY, JSON.stringify(events));
  } catch {
    /* ignore */
  }
}

export function appendLaunchEvent(
  prev: readonly LaunchEvent[],
  name: string,
): readonly LaunchEvent[] {
  const next: LaunchEvent[] = [[name, Date.now()], ...prev];
  return next.slice(0, LAUNCH_EVENTS_MAX);
}

/**
 * Returns a count of launches for `name` within the last N days.
 */
export function weeklyCount(
  events: readonly LaunchEvent[],
  name: string,
  days = WEEKLY_WINDOW_DAYS,
): number {
  const cutoff = Date.now() - days * 86_400_000;
  let n = 0;
  for (const [n_, ts] of events) {
    if (n_ === name && ts >= cutoff) n += 1;
  }
  return n;
}

/**
 * Builds a 7-day × 24-hour heatmap grid from timed events.
 * Returns a flat 168-element array indexed as `day * 24 + hour`
 * where `day=0` is 7 days ago and `day=6` is today (local time).
 */
export function buildHeatmap(events: readonly LaunchEvent[]): readonly number[] {
  const grid = new Array<number>(7 * 24).fill(0);
  const now = Date.now();
  const msPerDay = 86_400_000;
  const cutoff = now - 7 * msPerDay;

  for (const [, ts] of events) {
    if (ts < cutoff) continue;
    const daysAgo = Math.floor((now - ts) / msPerDay);
    const day = Math.min(6, Math.max(0, 6 - daysAgo));
    const hour = new Date(ts).getHours();
    grid[day * 24 + hour] = (grid[day * 24 + hour] ?? 0) + 1;
  }
  return grid;
}

/**
 * Extracts a rough bundle-ID prefix from an app's .app path.
 * e.g. "/Applications/Slack.app" → attempts com.tinyspeck style but
 * we only have paths, so we return the leaf name's first token for grouping.
 */
export function bundlePrefix(path: string): string {
  const leaf = path.split('/').pop() ?? '';
  return leaf.replace(/\.app$/i, '').split(/[\s_\-]/)[0]?.toLowerCase() ?? '';
}
