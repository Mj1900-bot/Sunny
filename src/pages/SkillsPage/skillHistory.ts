/**
 * Skill invocation history — localStorage-backed per-skill run log.
 * Each entry records the outcome (ok/fail) at a unix-seconds timestamp.
 * The Skills page writes here on every RUN; SkillCard reads for sparklines.
 */

const KEY = 'sunny.skills.history.v1';
const MAX_ENTRIES_PER_SKILL = 20;

export type RunEntry = {
  readonly ts: number;   // unix seconds
  readonly ok: boolean;
};

type HistoryStore = Record<string, ReadonlyArray<RunEntry>>;

function load(): HistoryStore {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HistoryStore) : {};
  } catch {
    return {};
  }
}

function save(store: HistoryStore): void {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* quota */ }
}

export function getSkillHistory(skillId: string): ReadonlyArray<RunEntry> {
  return load()[skillId] ?? [];
}

export function recordSkillRun(skillId: string, ok: boolean): void {
  const store = load();
  const prev = store[skillId] ?? [];
  const next = [...prev, { ts: Math.floor(Date.now() / 1000), ok }]
    .slice(-MAX_ENTRIES_PER_SKILL);
  save({ ...store, [skillId]: next });
}

/** Returns the last N success-rate values (0–100) over a rolling window,
 *  one data point per run, for sparkline rendering. */
export function successRateSeries(entries: ReadonlyArray<RunEntry>): ReadonlyArray<number> {
  return entries.map(e => (e.ok ? 100 : 0));
}
