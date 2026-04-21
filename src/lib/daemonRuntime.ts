// Daemon runtime — the part that makes persistent AI goals actually run.
//
// Responsibility loop:
//   1. Every TICK_MS, ask the Rust side for daemons whose `next_run <= now`.
//   2. For each, spawn a sub-agent carrying the daemon's `goal` and mark
//      the pair in `useSubAgents.inFlightDaemons` so we don't fire it again
//      until the sub-agent completes. This map is persisted (debounced)
//      so a webview reload doesn't cause daemons to double-fire.
//   3. Subscribe to `useSubAgents` updates; when a run that we spawned on
//      behalf of a daemon reaches a terminal status, call
//      `daemons_mark_fired` with the final status + truncated answer so
//      the Rust side advances `next_run` / `runs_count` / auto-disables.
//   4. After every fire or mark, nudge the cached daemon list to refresh.
//
// Also exposes `emitDaemonEvent(name)` for `on_event` daemons: listeners
// in the Rust layer trigger via Tauri events (`daemons_ready_to_fire` only
// returns time-based daemons), and the frontend can just call this helper
// when a user-facing event fires to queue matching daemons immediately.

import { invokeSafe, isTauri } from './tauri';
import { daemonsList, daemonsMarkFired, useDaemons, type Daemon } from '../store/daemons';
import { useSubAgents, type SubAgentRun, type SubAgentStatus } from '../store/subAgents';

const TICK_MS = 15_000;
const OUTPUT_TRUNCATE = 1000;

let timer: number | null = null;
let subagentUnsub: (() => void) | null = null;
let started = false;

function terminal(status: SubAgentStatus): boolean {
  return (
    status === 'done' ||
    status === 'aborted' ||
    status === 'error' ||
    status === 'max_steps'
  );
}

function truncate(s: string, max = OUTPUT_TRUNCATE): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Lift a fresh spawn into the persistent in-flight map. */
function trackDaemonSpawn(daemonId: string, runId: string): void {
  useSubAgents.getState().setDaemonInFlight({
    daemonId,
    runId,
    startedAt: Date.now(),
  });
}

/**
 * Start the daemon runtime. Safe to call multiple times — it no-ops on
 * repeat invocations. Returns a stop function for teardown (e.g. in React
 * strict-mode double-mount scenarios).
 */
export function startDaemonRuntime(): () => void {
  if (!isTauri) return () => undefined;
  if (started) return stopDaemonRuntime;
  started = true;

  // Initial list load so the UI has something immediately.
  void useDaemons.getState().refresh();

  // Subscribe to sub-agent store so finishes resolve their daemons. The
  // inFlight map now lives in the store too, so a reload mid-flight still
  // lets us mark the daemon fired once the run completes.
  subagentUnsub = useSubAgents.subscribe(async state => {
    const entries = Object.values(state.inFlightDaemons);
    if (entries.length === 0) return;

    const resolved: Array<{
      daemonId: string;
      runId: string;
      run: SubAgentRun;
    }> = [];
    for (const entry of entries) {
      const run = state.runs.find(r => r.id === entry.runId);
      if (!run) continue;
      if (terminal(run.status)) {
        resolved.push({ daemonId: entry.daemonId, runId: entry.runId, run });
      }
    }
    if (resolved.length === 0) return;

    for (const r of resolved) {
      // Clear in-flight BEFORE the await so a racing tick sees the slot
      // free and can't re-fire while mark_fired is outstanding.
      useSubAgents.getState().clearDaemonInFlight(r.daemonId);
      try {
        await daemonsMarkFired(
          r.daemonId,
          Math.floor(Date.now() / 1000),
          r.run.status,
          truncate(r.run.finalAnswer || ''),
        );
      } catch (err) {
        console.error('daemons_mark_fired failed', err);
      }
    }
    void useDaemons.getState().refresh();
  });

  // Polling tick — time-based daemons only. on_event daemons are fired by
  // `emitDaemonEvent()`.
  const tick = async (): Promise<void> => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const due = await invokeSafe<ReadonlyArray<Daemon>>('daemons_ready_to_fire', {
      nowSecs,
    });
    if (!due || due.length === 0) {
      if (Math.random() < 0.25) void useDaemons.getState().refresh();
      return;
    }
    const inFlight = useSubAgents.getState().inFlightDaemons;
    for (const d of due) {
      if (!d.enabled) continue;
      if (inFlight[d.id]) continue;
      const runId = useSubAgents.getState().spawn(d.goal, `daemon:${d.id}`);
      trackDaemonSpawn(d.id, runId);
    }
    void useDaemons.getState().refresh();
  };

  timer = window.setInterval(() => void tick(), TICK_MS);
  // Kick off one tick right away so daemons due at boot fire promptly.
  void tick();

  return stopDaemonRuntime;
}

export function stopDaemonRuntime(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (subagentUnsub !== null) {
    subagentUnsub();
    subagentUnsub = null;
  }
  // Note: we intentionally do NOT clear inFlightDaemons on stop — a
  // webview reload restarts the runtime and we want pending runs to
  // resolve their daemons correctly.
  started = false;
}

/**
 * Force-fire every `on_event` daemon subscribed to the given event name.
 * Call this anywhere in the UI when a semantically meaningful event
 * happens (scan completed, file saved, etc).
 */
export async function emitDaemonEvent(name: string): Promise<void> {
  if (!isTauri) return;
  const all = await daemonsList();
  const matches = all.filter(
    d => d.enabled && d.kind === 'on_event' && d.on_event === name,
  );
  const inFlight = useSubAgents.getState().inFlightDaemons;
  for (const d of matches) {
    if (inFlight[d.id]) continue;
    const runId = useSubAgents.getState().spawn(d.goal, `daemon:${d.id}`);
    trackDaemonSpawn(d.id, runId);
  }
}

/**
 * Manually fire a specific daemon. Bypasses the schedule — used by the
 * "Run now" button in the UI.
 */
export function runDaemonNow(daemon: Daemon): string {
  const current = useSubAgents.getState().inFlightDaemons[daemon.id];
  if (current) return current.runId;
  const runId = useSubAgents.getState().spawn(daemon.goal, `daemon:${daemon.id}`);
  trackDaemonSpawn(daemon.id, runId);
  return runId;
}

/** Map exposed for UI introspection (Agents tab shows "(running)" badge). */
export function inFlightDaemonIds(): ReadonlySet<string> {
  return new Set(Object.keys(useSubAgents.getState().inFlightDaemons));
}
