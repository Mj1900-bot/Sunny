import { create } from 'zustand';
import { useAgentStore } from './agent';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HistoryRunStatus = 'done' | 'aborted' | 'error' | 'max_steps';

export type HistoryStep = {
  readonly kind: string;
  readonly text: string;
  readonly toolName?: string;
  readonly at: number;
  readonly durationMs?: number;
};

export type HistoryRun = {
  readonly id: string;
  readonly goal: string;
  readonly status: HistoryRunStatus;
  readonly finalAnswer: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly steps: ReadonlyArray<HistoryStep>;
};

type AgentHistoryState = {
  readonly runs: ReadonlyArray<HistoryRun>;
  clear: () => void;
  delete: (id: string) => void;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'sunny.agentHistory.v1';
const MAX_RUNS = 200;
const TERMINAL_STATUSES: ReadonlyArray<string> = [
  'done',
  'aborted',
  'error',
  'max_steps',
];

function isHistoryStep(raw: unknown): raw is HistoryStep {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.kind === 'string' &&
    typeof r.text === 'string' &&
    typeof r.at === 'number' &&
    (r.toolName === undefined || typeof r.toolName === 'string') &&
    (r.durationMs === undefined || typeof r.durationMs === 'number')
  );
}

function isHistoryRun(raw: unknown): raw is HistoryRun {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return false;
  if (typeof r.goal !== 'string') return false;
  if (typeof r.finalAnswer !== 'string') return false;
  if (typeof r.startedAt !== 'number') return false;
  if (typeof r.endedAt !== 'number') return false;
  if (
    r.status !== 'done' &&
    r.status !== 'aborted' &&
    r.status !== 'error' &&
    r.status !== 'max_steps'
  )
    return false;
  if (!Array.isArray(r.steps)) return false;
  return r.steps.every(isHistoryStep);
}

function loadRuns(): ReadonlyArray<HistoryRun> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop any legacy entries that don't match the shape — safer than crashing.
    return parsed.filter(isHistoryRun).slice(0, MAX_RUNS);
  } catch (error) {
    console.error('Failed to load agent history:', error);
    return [];
  }
}

function persist(runs: ReadonlyArray<HistoryRun>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  } catch (error) {
    console.error('Failed to persist agent history:', error);
  }
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAgentHistory = create<AgentHistoryState>((set, get) => ({
  runs: loadRuns(),

  clear: () => {
    persist([]);
    set({ runs: [] });
  },

  delete: (id: string) => {
    const next = get().runs.filter(r => r.id !== id);
    persist(next);
    set({ runs: next });
  },
}));

// ---------------------------------------------------------------------------
// Internal: snapshot a terminal agent run into history
// ---------------------------------------------------------------------------

function recordRun(
  goal: string,
  status: HistoryRunStatus,
  finalAnswer: string,
  startedAt: number,
  steps: ReadonlyArray<HistoryStep>,
): void {
  // Blank-goal runs are uninteresting stubs from a freshly-cleared store.
  if (goal.trim().length === 0 && steps.length === 0) return;

  const run: HistoryRun = {
    id: makeId(),
    goal,
    status,
    finalAnswer,
    startedAt,
    endedAt: Date.now(),
    steps,
  };

  const current = useAgentHistory.getState().runs;
  const next = [run, ...current].slice(0, MAX_RUNS);
  persist(next);
  useAgentHistory.setState({ runs: next });
}

function toHistoryStatus(s: string): HistoryRunStatus | null {
  if (s === 'done' || s === 'aborted' || s === 'error' || s === 'max_steps') {
    return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subscription: watch useAgentStore for 'running' -> terminal transitions.
// Lives here (not in agent.ts) so agent.ts stays ignorant of history.
// ---------------------------------------------------------------------------

// Track the previous status so we only snapshot on the *transition edge*.
// zustand's subscribe fires for any state change; without the edge check
// we'd re-record the same run every time a downstream field mutated.
let lastStatus: string = useAgentStore.getState().status;

useAgentStore.subscribe(state => {
  const prev = lastStatus;
  const curr = state.status;
  if (prev === curr) return;
  lastStatus = curr;

  // Only interested in the running -> terminal edge.
  if (prev !== 'running') return;
  if (!TERMINAL_STATUSES.includes(curr)) return;

  const status = toHistoryStatus(curr);
  if (status === null) return;

  const startedAt = state.startedAt ?? Date.now();
  const steps: ReadonlyArray<HistoryStep> = state.steps.map(s => ({
    kind: s.kind,
    text: s.text,
    toolName: s.toolName,
    at: s.at,
    durationMs: s.durationMs,
  }));

  recordRun(state.goal, status, state.finalAnswer, startedAt, steps);
});
