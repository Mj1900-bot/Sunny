// Sub-agent store — the single source of truth for every sub-agent that SUNNY
// knows about, regardless of who spawned it:
//
//   • `source: 'ts'`   — runs spawned from the TS side (daemonRuntime,
//     delegation tools, the TaskQueuePage). These live as a queue the
//     sub-agent worker (`lib/subAgents.ts`) drains respecting `maxConcurrent`,
//     promoting `queued` → `running` → terminal. Aborts route through the
//     worker's `AbortController` map.
//
//   • `source: 'rust'` — runs spawned by the Rust backend that emits
//     `sunny://agent.sub` events. Their lifecycle is owned Rust-side; the
//     frontend just mirrors start/step/done/error into the same store via
//     `_rustStart/_rustStep/_rustDone/_rustError`. They never take a queue
//     slot, they don't route through the worker's AbortController, and
//     they can't be aborted from the UI — only cleared.
//
// The store is persisted to localStorage so a webview reload doesn't lose
// recent history or the daemon-runtime's `inFlightDaemons` map (without
// which a reload would cause daemons to double-fire their pending runs).
// Persistence is debounced; persistence to `~/.sunny/subagents-live.json`
// via a Tauri command is a TODO for Agent G (see `persistFile` below).

import { create } from 'zustand';
import { invokeSafe } from '../lib/tauri';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SubAgentStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'aborted'
  | 'error'
  | 'max_steps';

export type SubAgentSource = 'ts' | 'rust';

export type SubAgentStep = {
  readonly kind: string;
  readonly text: string;
  readonly toolName?: string;
  readonly at: number;
};

export type SubAgentRun = {
  readonly id: string;
  readonly goal: string;
  readonly status: SubAgentStatus;
  readonly steps: ReadonlyArray<SubAgentStep>;
  readonly finalAnswer: string;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly parent: string | null;
  readonly source: SubAgentSource;
  // Rust-only metadata. Optional so TS-spawned records stay minimal.
  readonly role?: string;
  readonly model?: string;
  readonly toolCallCount?: number;
  readonly tokenEstimate?: number;
  readonly error?: string;
};

// Daemon inFlight map lives in the store so a webview reload doesn't cause
// `daemonRuntime` to re-spawn a daemon whose sub-agent is still running.
export type DaemonInFlight = {
  readonly daemonId: string;
  readonly runId: string;
  readonly startedAt: number;
};

export type RustStartPayload = {
  readonly id: string;
  readonly role: string;
  readonly task: string;
  readonly model: string;
  readonly parentId: string | null;
};

type SubAgentsState = {
  readonly runs: ReadonlyArray<SubAgentRun>;
  readonly maxConcurrent: number;
  readonly inFlightDaemons: Readonly<Record<string, DaemonInFlight>>;
  // TS-side surface (unchanged public API) ------------------------------
  readonly spawn: (goal: string, parent?: string) => string;
  readonly abort: (id: string) => void;
  readonly abortAll: () => void;
  readonly clear: (includeRunning?: boolean) => void;
  readonly clearFinished: () => void;
  readonly setMaxConcurrent: (n: number) => void;
  readonly _markRunning: (id: string) => void;
  readonly _appendStep: (id: string, step: SubAgentStep) => void;
  readonly _finalise: (
    id: string,
    status: SubAgentStatus,
    finalAnswer: string,
  ) => void;
  // Rust-side merge surface ---------------------------------------------
  readonly _rustStart: (payload: RustStartPayload) => void;
  readonly _rustStep: (id: string, step: SubAgentStep) => void;
  readonly _rustDone: (id: string, answer: string) => void;
  readonly _rustError: (id: string, message: string) => void;
  readonly _rustClear: (olderThanMs: number) => void;
  // Daemon inFlight surface ---------------------------------------------
  readonly setDaemonInFlight: (entry: DaemonInFlight) => void;
  readonly clearDaemonInFlight: (daemonId: string) => void;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'sunny.subAgents.v2';
const LEGACY_STORAGE_KEY = 'sunny.subAgents.v1';
const CONCURRENCY_KEY = 'sunny.subAgents.maxConcurrent';
const INFLIGHT_KEY = 'sunny.subAgents.inFlight.v1';
const PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
// Cap persisted rows. The panel is only useful for recent history; letting
// it grow unbounded bloats localStorage and slows every save.
const MAX_PERSISTED_RUNS = 200;
// Tolerate `kind`s we haven't seen before — only enforce they're strings.
const VALID_STATUSES: ReadonlySet<SubAgentStatus> = new Set<SubAgentStatus>([
  'queued',
  'running',
  'done',
  'aborted',
  'error',
  'max_steps',
]);
const VALID_SOURCES: ReadonlySet<SubAgentSource> = new Set<SubAgentSource>([
  'ts',
  'rust',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStep(raw: unknown): raw is SubAgentStep {
  if (!isRecord(raw)) return false;
  return (
    typeof raw.kind === 'string' &&
    typeof raw.text === 'string' &&
    typeof raw.at === 'number' &&
    (raw.toolName === undefined || typeof raw.toolName === 'string')
  );
}

function isRun(raw: unknown): raw is SubAgentRun {
  if (!isRecord(raw)) return false;
  if (typeof raw.id !== 'string') return false;
  if (typeof raw.goal !== 'string') return false;
  if (typeof raw.status !== 'string') return false;
  if (!VALID_STATUSES.has(raw.status as SubAgentStatus)) return false;
  if (typeof raw.finalAnswer !== 'string') return false;
  if (!(raw.startedAt === null || typeof raw.startedAt === 'number'))
    return false;
  if (!(raw.endedAt === null || typeof raw.endedAt === 'number')) return false;
  if (!(raw.parent === null || typeof raw.parent === 'string')) return false;
  if (!Array.isArray(raw.steps)) return false;
  if (!raw.steps.every(isStep)) return false;
  if ('createdAt' in raw && typeof raw.createdAt !== 'number') return false;
  if ('source' in raw && typeof raw.source !== 'string') return false;
  if ('source' in raw && !VALID_SOURCES.has(raw.source as SubAgentSource))
    return false;
  return true;
}

function loadRawRuns(): ReadonlyArray<SubAgentRun> {
  if (typeof localStorage === 'undefined') return [];
  // v2 first; fall back to v1 for forward migration (older installs).
  const primary = localStorage.getItem(STORAGE_KEY);
  const raw = primary ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRun).map(run => {
      const createdAt =
        typeof (run as { createdAt?: unknown }).createdAt === 'number'
          ? (run as { createdAt: number }).createdAt
          : run.startedAt ?? 0;
      const source: SubAgentSource =
        (run as { source?: unknown }).source === 'rust' ? 'rust' : 'ts';
      const base: SubAgentRun = {
        ...run,
        createdAt,
        source,
      };
      // Any TS run mid-flight at reload must requeue — the worker's
      // AbortController is gone so leaving it 'running' would wedge the
      // queue. Rust runs stay as-is; Rust owns their lifecycle.
      if (base.source === 'ts' && base.status === 'running') {
        return { ...base, status: 'queued' as SubAgentStatus, startedAt: null };
      }
      return base;
    });
  } catch (error) {
    console.error('Failed to load sub-agents:', error);
    return [];
  }
}

function loadInFlightDaemons(): Readonly<Record<string, DaemonInFlight>> {
  if (typeof localStorage === 'undefined') return {};
  const raw = localStorage.getItem(INFLIGHT_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const out: Record<string, DaemonInFlight> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      if (
        typeof value.daemonId === 'string' &&
        typeof value.runId === 'string' &&
        typeof value.startedAt === 'number'
      ) {
        out[key] = {
          daemonId: value.daemonId,
          runId: value.runId,
          startedAt: value.startedAt,
        };
      }
    }
    return out;
  } catch (error) {
    console.error('Failed to load in-flight daemons:', error);
    return {};
  }
}

// Cross-module debounced saves. We save both pieces of state to localStorage
// and (best-effort) push the full snapshot to the backend so other
// consumers — and disaster-recovery tools — see the latest.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRuns: ReadonlyArray<SubAgentRun> | null = null;
let pendingInFlight: Readonly<Record<string, DaemonInFlight>> | null = null;

function schedulePersist(
  runs: ReadonlyArray<SubAgentRun>,
  inFlight: Readonly<Record<string, DaemonInFlight>>,
): void {
  pendingRuns = runs;
  pendingInFlight = inFlight;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
}

function flushPersist(): void {
  persistTimer = null;
  const runs = pendingRuns;
  const inFlight = pendingInFlight;
  pendingRuns = null;
  pendingInFlight = null;
  if (runs !== null) persistRuns(runs);
  if (inFlight !== null) persistInFlight(inFlight);
  // Fire-and-forget backend mirror. Agent G: this expects a Tauri command
  // named `subagents_live_save` accepting `{ value: { runs, inFlightDaemons } }`
  // that writes to `~/.sunny/subagents-live.json` via an atomic rename
  // (same pattern as `daemons.json`). Silently ignores if unimplemented.
  if (runs !== null || inFlight !== null) {
    void persistFile({
      runs: runs ?? [],
      inFlightDaemons: inFlight ?? {},
    });
  }
}

function persistRuns(runs: ReadonlyArray<SubAgentRun>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    // Truncate to newest-N so long-running installs don't hit the 5 MB cap.
    const toSave = runs.length > MAX_PERSISTED_RUNS
      ? runs.slice(runs.length - MAX_PERSISTED_RUNS)
      : runs;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (error) {
    console.error('Failed to persist sub-agents:', error);
  }
}

function persistInFlight(
  inFlight: Readonly<Record<string, DaemonInFlight>>,
): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(INFLIGHT_KEY, JSON.stringify(inFlight));
  } catch (error) {
    console.error('Failed to persist in-flight daemons:', error);
  }
}

type PersistSnapshot = {
  readonly runs: ReadonlyArray<SubAgentRun>;
  readonly inFlightDaemons: Readonly<Record<string, DaemonInFlight>>;
};

async function persistFile(snapshot: PersistSnapshot): Promise<void> {
  // Intentionally non-fatal. Command is optional pending Agent G.
  try {
    await invokeSafe('subagents_live_save', { value: snapshot });
  } catch {
    // ignore
  }
}

function loadMaxConcurrent(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_CONCURRENCY;
    const raw = localStorage.getItem(CONCURRENCY_KEY);
    if (!raw) return DEFAULT_CONCURRENCY;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY;
    return clampConcurrency(parsed);
  } catch {
    return DEFAULT_CONCURRENCY;
  }
}

function persistMaxConcurrent(n: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CONCURRENCY_KEY, String(n));
  } catch (error) {
    console.error('Failed to persist sub-agent concurrency:', error);
  }
}

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  const int = Math.trunc(n);
  if (int < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  if (int > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return int;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// `ACTIVE_STATUSES` — runs we mustn't wipe on `clear()` unless the caller
// explicitly opts in. Anything terminal is always fair game.
const ACTIVE_STATUSES: ReadonlySet<SubAgentStatus> = new Set<SubAgentStatus>([
  'queued',
  'running',
]);

// Rust-record-specific clamp: same behavior as subAgentsLive's old store —
// cap step tails at 40 entries, FIFO. TS runs are unbounded because the
// runner controls them directly.
const MAX_RUST_STEPS_PER_AGENT = 40;
const CHARS_PER_TOKEN = 4;

function estimateTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
}

function clampRustSteps(
  existing: ReadonlyArray<SubAgentStep>,
  next: SubAgentStep,
): ReadonlyArray<SubAgentStep> {
  const appended = [...existing, next];
  if (appended.length <= MAX_RUST_STEPS_PER_AGENT) return appended;
  return appended.slice(appended.length - MAX_RUST_STEPS_PER_AGENT);
}

export const useSubAgents = create<SubAgentsState>((set, get) => {
  function commit(next: Partial<SubAgentsState>): void {
    set(next);
    const state = get();
    schedulePersist(state.runs, state.inFlightDaemons);
  }

  function update(
    mutator: (runs: ReadonlyArray<SubAgentRun>) => ReadonlyArray<SubAgentRun>,
  ): void {
    const next = mutator(get().runs);
    // Cheap reference equality — if the mutator returned the same array,
    // skip the set + persist to avoid redundant subscriber notifications.
    if (next === get().runs) return;
    commit({ runs: next });
  }

  function replaceRun(
    id: string,
    transform: (run: SubAgentRun) => SubAgentRun,
  ): void {
    update(runs => {
      const idx = runs.findIndex(r => r.id === id);
      if (idx === -1) return runs;
      const copy = runs.slice();
      copy[idx] = transform(runs[idx]);
      return copy;
    });
  }

  return {
    runs: loadRawRuns(),
    maxConcurrent: loadMaxConcurrent(),
    inFlightDaemons: loadInFlightDaemons(),

    spawn: (goal: string, parent?: string) => {
      const trimmed = goal.trim();
      const id = makeId();
      const run: SubAgentRun = {
        id,
        goal: trimmed,
        status: 'queued',
        steps: [],
        finalAnswer: '',
        createdAt: Date.now(),
        startedAt: null,
        endedAt: null,
        parent: parent ?? null,
        source: 'ts',
      };
      update(runs => [...runs, run]);
      return id;
    },

    abort: (id: string) => {
      replaceRun(id, run => {
        if (run.source !== 'ts') {
          // Rust runs can't be aborted from the frontend; the Rust side
          // owns their lifecycle. No-op (warning would spam for cascade
          // aborts hitting unrelated ids).
          return run;
        }
        if (
          run.status === 'done' ||
          run.status === 'error' ||
          run.status === 'max_steps' ||
          run.status === 'aborted'
        ) {
          return run;
        }
        return {
          ...run,
          status: 'aborted',
          endedAt: Date.now(),
          finalAnswer: run.finalAnswer || 'Run aborted before completion.',
        };
      });
    },

    abortAll: () => {
      update(runs => {
        let touched = false;
        const next = runs.map(run => {
          if (run.source === 'ts' && ACTIVE_STATUSES.has(run.status)) {
            touched = true;
            return {
              ...run,
              status: 'aborted' as SubAgentStatus,
              endedAt: Date.now(),
              finalAnswer: run.finalAnswer || 'Run aborted before completion.',
            };
          }
          return run;
        });
        return touched ? next : runs;
      });
    },

    clear: (includeRunning = false) => {
      if (includeRunning) {
        update(() => []);
        return;
      }
      update(runs => runs.filter(r => ACTIVE_STATUSES.has(r.status)));
    },

    clearFinished: () => {
      update(runs => runs.filter(r => ACTIVE_STATUSES.has(r.status)));
    },

    setMaxConcurrent: (n: number) => {
      const clamped = clampConcurrency(n);
      if (clamped === get().maxConcurrent) return;
      persistMaxConcurrent(clamped);
      set({ maxConcurrent: clamped });
    },

    _markRunning: (id: string) => {
      replaceRun(id, run =>
        run.status === 'queued'
          ? { ...run, status: 'running', startedAt: Date.now() }
          : run,
      );
    },

    _appendStep: (id: string, step: SubAgentStep) => {
      replaceRun(id, run => ({ ...run, steps: [...run.steps, step] }));
    },

    _finalise: (
      id: string,
      status: SubAgentStatus,
      finalAnswer: string,
    ) => {
      replaceRun(id, run => {
        if (run.status === 'aborted') {
          return {
            ...run,
            endedAt: run.endedAt ?? Date.now(),
            finalAnswer: run.finalAnswer || finalAnswer,
          };
        }
        return {
          ...run,
          status,
          finalAnswer,
          endedAt: Date.now(),
        };
      });
    },

    // -------- Rust merge surface ----------------------------------------

    _rustStart: (payload: RustStartPayload) => {
      const now = Date.now();
      update(runs => {
        const idx = runs.findIndex(r => r.id === payload.id);
        const fresh: SubAgentRun = {
          id: payload.id,
          goal: payload.task,
          status: 'running',
          steps: [],
          finalAnswer: '',
          createdAt: now,
          startedAt: now,
          endedAt: null,
          parent: payload.parentId,
          source: 'rust',
          role: payload.role,
          model: payload.model,
          toolCallCount: 0,
          tokenEstimate: 0,
        };
        if (idx === -1) return [...runs, fresh];
        // Duplicate `start` — Rust restarted the agent under the same id.
        // Replace wholesale (matches old subAgentsLive.ts semantics).
        const copy = runs.slice();
        copy[idx] = fresh;
        return copy;
      });
    },

    _rustStep: (id: string, step: SubAgentStep) => {
      update(runs => {
        const idx = runs.findIndex(r => r.id === id);
        if (idx === -1) return runs; // Rust bridge drops orphan steps.
        const existing = runs[idx];
        if (existing.source !== 'rust') return runs; // Never mutate a TS run from the Rust path.
        const steps = clampRustSteps(existing.steps, step);
        const toolCallCount =
          step.kind === 'tool_call'
            ? (existing.toolCallCount ?? 0) + 1
            : existing.toolCallCount ?? 0;
        const priorChars = (existing.tokenEstimate ?? 0) * CHARS_PER_TOKEN;
        const tokenEstimate = estimateTokens(priorChars + step.text.length);
        const copy = runs.slice();
        copy[idx] = {
          ...existing,
          steps,
          toolCallCount,
          tokenEstimate,
        };
        return copy;
      });
    },

    _rustDone: (id: string, answer: string) => {
      replaceRun(id, run => {
        if (run.source !== 'rust') return run;
        return {
          ...run,
          status: 'done',
          finalAnswer: answer,
          endedAt: Date.now(),
        };
      });
    },

    _rustError: (id: string, message: string) => {
      replaceRun(id, run => {
        if (run.source !== 'rust') return run;
        return {
          ...run,
          status: 'error',
          error: message,
          finalAnswer: run.finalAnswer || message,
          endedAt: Date.now(),
        };
      });
    },

    _rustClear: (olderThanMs: number) => {
      const now = Date.now();
      update(runs => {
        let touched = false;
        const next = runs.filter(run => {
          if (run.source !== 'rust') return true;
          const terminal =
            run.status === 'done' ||
            run.status === 'error' ||
            run.status === 'aborted' ||
            run.status === 'max_steps';
          if (!terminal) return true;
          const endedAt = run.endedAt ?? now;
          if (now - endedAt < olderThanMs) return true;
          touched = true;
          return false;
        });
        return touched ? next : runs;
      });
    },

    // -------- Daemon inFlight surface -----------------------------------

    setDaemonInFlight: (entry: DaemonInFlight) => {
      const current = get().inFlightDaemons;
      const existing = current[entry.daemonId];
      if (
        existing &&
        existing.runId === entry.runId &&
        existing.startedAt === entry.startedAt
      ) {
        return;
      }
      const next: Record<string, DaemonInFlight> = { ...current, [entry.daemonId]: entry };
      commit({ inFlightDaemons: next });
    },

    clearDaemonInFlight: (daemonId: string) => {
      const current = get().inFlightDaemons;
      if (!(daemonId in current)) return;
      const next: Record<string, DaemonInFlight> = { ...current };
      delete next[daemonId];
      commit({ inFlightDaemons: next });
    },
  };
});
