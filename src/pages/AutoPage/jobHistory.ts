/**
 * Job run history — localStorage-backed per-job run log (last 10 runs).
 * Written by AutoPage after each schedulerRunOnce; read by JobCard for
 * the duration sparkline and the history list.
 */

const KEY = 'sunny.auto.jobhistory.v1';
const MAX_PER_JOB = 10;

export type RunRecord = {
  readonly ts: number;           // unix ms
  readonly duration_ms: number;  // estimated or 0
  readonly ok: boolean;
};

type Store = Record<string, ReadonlyArray<RunRecord>>;

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function persist(store: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* quota */ }
}

export function getJobHistory(jobId: string): ReadonlyArray<RunRecord> {
  return load()[jobId] ?? [];
}

export function recordJobRun(jobId: string, ok: boolean, duration_ms = 0): void {
  const store = load();
  const prev = store[jobId] ?? [];
  const next = [...prev, { ts: Date.now(), duration_ms, ok }].slice(-MAX_PER_JOB);
  persist({ ...store, [jobId]: next });
}

/** Returns duration_ms series for sparkline (0 = failed run). */
export function durationSeries(records: ReadonlyArray<RunRecord>): ReadonlyArray<number> {
  return records.map(r => r.duration_ms);
}
