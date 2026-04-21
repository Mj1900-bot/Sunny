import { invokeSafe } from '../../lib/tauri';
import type { WorldState } from '../WorldPage/types';

export async function getWorld(): Promise<WorldState | null> {
  return invokeSafe<WorldState>('world_get');
}

export type SessionRecord = {
  id: string;
  /** Unix seconds of start. */
  start: number;
  /** Unix seconds of end, or null if in progress. */
  end: number | null;
  goal: string;
  /** Optional preset duration in seconds (for countdown + progress bar). */
  targetSecs?: number;
  /** Total accumulated seconds the session has been paused. Absent on legacy rows. */
  pausedSecs?: number;
  /** Unix seconds when the current pause began, or null if running. Absent on legacy rows. */
  pausedAt?: number | null;
};

export type DistractionEntry = {
  ts: number;
  appName: string;
  windowTitle: string;
};

const SESSION_KEY     = 'sunny.focus.sessions.v1';
const DISTRACTION_KEY = 'sunny.focus.distractions.v1';

/** Known unproductive bundle IDs / app name fragments (case-insensitive). */
const DISTRACTION_PATTERNS = [
  'twitter', 'x.com', 'youtube', 'reddit', 'tiktok',
  'instagram', 'facebook', 'netflix', 'twitch', 'discord',
  'slack', 'messages', 'whatsapp', 'telegram',
];

export function isDistraction(appName: string): boolean {
  const lower = appName.toLowerCase();
  return DISTRACTION_PATTERNS.some(p => lower.includes(p));
}

export function loadSessions(): ReadonlyArray<SessionRecord> {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as ReadonlyArray<SessionRecord>;
    }
  } catch { /* ignore */ }
  return [];
}

export function saveSessions(ss: ReadonlyArray<SessionRecord>): void {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(ss)); } catch { /* ignore */ }
}

export function loadDistractions(): ReadonlyArray<DistractionEntry> {
  try {
    const raw = localStorage.getItem(DISTRACTION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as ReadonlyArray<DistractionEntry>;
    }
  } catch { /* ignore */ }
  return [];
}

export function saveDistractions(ds: ReadonlyArray<DistractionEntry>): void {
  try { localStorage.setItem(DISTRACTION_KEY, JSON.stringify(ds.slice(0, 200))); } catch { /* ignore */ }
}

/** Net focused (unpaused) seconds for a session, using `nowSecs` if still active. */
export function focusedSecs(s: SessionRecord, nowSecs: number): number {
  const endOrNow = s.end ?? nowSecs;
  const livePaused = s.pausedAt != null ? Math.max(0, nowSecs - s.pausedAt) : 0;
  const total = endOrNow - s.start;
  const paused = (s.pausedSecs ?? 0) + livePaused;
  return Math.max(0, total - paused);
}

/** True if the session is currently paused. */
export function isPaused(s: SessionRecord): boolean {
  return s.end == null && s.pausedAt != null;
}

/** Compute consecutive weekday sessions ≥ minSecs, ending today. */
export function computeFocusStreak(sessions: ReadonlyArray<SessionRecord>, minSecs = 25 * 60): number {
  const goodDays = new Set(
    sessions
      .filter(s => s.end != null && focusedSecs(s, s.end) >= minSecs)
      .map(s => {
        const d = new Date(s.start * 1000);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      }),
  );

  let streak = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let cursor = today.getTime();

  // Walk backwards, skipping weekends
  while (true) {
    const day = new Date(cursor).getDay(); // 0=Sun, 6=Sat
    const isWeekend = day === 0 || day === 6;
    if (isWeekend) {
      cursor -= 86_400_000;
      continue;
    }
    if (!goodDays.has(cursor)) break;
    streak++;
    cursor -= 86_400_000;
  }
  return streak;
}

/**
 * Build a 7-day × 24-hour heatmap matrix.
 * Returns: rows[dayIndex 0=today][hour 0-23] = total focused minutes.
 * dayIndex 0 = today, 6 = 6 days ago.
 */
export function buildHeatmap(sessions: ReadonlyArray<SessionRecord>, nowSecs: number): number[][] {
  const matrix: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const dayMs = 86_400_000;
  const todayStart = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  })();

  for (const s of sessions) {
    const startMs = s.start * 1000;
    void ((s.end ?? nowSecs) * 1000);
    // Determine which day bucket
    const sessionDayStart = (() => {
      const d = new Date(startMs); d.setHours(0, 0, 0, 0); return d.getTime();
    })();
    const daysAgo = Math.round((todayStart - sessionDayStart) / dayMs);
    if (daysAgo < 0 || daysAgo > 6) continue;

    // Distribute focused minutes per hour (simplified: assign to start hour)
    const hour = new Date(startMs).getHours();
    const focusedMin = Math.floor(focusedSecs(s, nowSecs) / 60);
    matrix[daysAgo][hour] = (matrix[daysAgo][hour] ?? 0) + focusedMin;
  }
  return matrix;
}
