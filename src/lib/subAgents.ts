// Sub-agent worker — a React-free background dispatcher that drains the queue
// held by `useSubAgents` (see `store/subAgents.ts`). The UI never calls into
// this module directly; it just `spawn()`s runs on the store and the worker
// notices.
//
// Design notes:
// - One worker per process. Call `startSubAgentWorker()` once at app start
//   and hold onto the returned unsubscribe function. Calling it twice is
//   harmless but wastes a zustand subscription, so we guard against it.
// - Aborts are routed through a `Map<id, AbortController>`. The store marks
//   the run as `'aborted'` synchronously (so the UI updates immediately),
//   and the worker's subscriber observes that transition and fires the
//   controller's `abort()`. This keeps the store pure TS and moves the
//   mutable handle into the worker.
// - Concurrency: we re-evaluate the queue after every state change. Each
//   call to `maybeSpawnNext` promotes at most one run so repeated calls
//   naturally throttle themselves when `maxConcurrent` is hit.

import { runAgent } from './agentLoop';
import { parseParentDepth } from './tools/builtins/delegation';
import {
  useSubAgents,
  type SubAgentRun,
  type SubAgentStatus,
  type SubAgentStep,
} from '../store/subAgents';

// ---------------------------------------------------------------------------
// Worker state (module-scoped — there's only ever one worker instance)
// ---------------------------------------------------------------------------

type WorkerState = {
  readonly controllers: Map<string, AbortController>;
  running: boolean;
  unsubscribe: (() => void) | null;
};

const workerState: WorkerState = {
  controllers: new Map(),
  running: false,
  unsubscribe: null,
};

// ---------------------------------------------------------------------------
// Step coercion — AgentStep has extra fields (id, toolInput, toolOutput) that
// we intentionally drop; the sub-agent store keeps a lighter record so the
// persisted payload stays small.
// ---------------------------------------------------------------------------

type LooseAgentStep = {
  readonly kind: string;
  readonly text: string;
  readonly toolName?: string;
  readonly at: number;
};

function toSubAgentStep(step: LooseAgentStep): SubAgentStep {
  return {
    kind: step.kind,
    text: step.text,
    toolName: step.toolName,
    at: step.at,
  };
}

// ---------------------------------------------------------------------------
// Queue inspection
// ---------------------------------------------------------------------------

function countRunning(runs: ReadonlyArray<SubAgentRun>): number {
  let n = 0;
  for (const run of runs) if (run.status === 'running') n += 1;
  return n;
}

function firstQueued(runs: ReadonlyArray<SubAgentRun>): SubAgentRun | null {
  for (const run of runs) if (run.status === 'queued') return run;
  return null;
}

// ---------------------------------------------------------------------------
// The core promotion step
// ---------------------------------------------------------------------------

function promoteOne(): boolean {
  const state = useSubAgents.getState();
  const { runs, maxConcurrent } = state;
  if (countRunning(runs) >= maxConcurrent) return false;
  const next = firstQueued(runs);
  if (!next) return false;

  // Claim the slot before the async work starts so a racing second
  // `promoteOne()` sees `running` and respects the cap.
  state._markRunning(next.id);

  const controller = new AbortController();
  workerState.controllers.set(next.id, controller);

  // Derive this run's depth from its parent label so `spawn_subagent`
  // inside the sub-agent's own loop knows how deep it is and can refuse
  // to spawn past MAX_DEPTH. A fresh UI/daemon-launched run with
  // parent="agent" or parent="daemon:xyz" lives at depth 0; subsequent
  // spawns carry "@depth:N" on the label.
  const depth = parseParentDepth(next.parent);

  void runAgent({
    goal: next.goal,
    signal: controller.signal,
    onStep: step => {
      // runAgent emits a richer shape; we project it onto our lighter step.
      useSubAgents.getState()._appendStep(next.id, toSubAgentStep(step));
    },
    parent: next.parent ?? undefined,
    depth,
  })
    .then(result => {
      useSubAgents
        .getState()
        ._finalise(next.id, result.status as SubAgentStatus, result.finalAnswer);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      useSubAgents
        .getState()
        ._finalise(next.id, 'error', `Sub-agent crashed: ${message}`);
    })
    .finally(() => {
      workerState.controllers.delete(next.id);
      // A slot just freed up — give the next queued run a chance to start.
      drainQueue();
    });

  return true;
}

function drainQueue(): void {
  // Promote as many runs as the concurrency cap allows in one tick.
  // `promoteOne` returns false once either the cap is hit or the queue is
  // empty, so this always terminates.
  // Hard cap on iterations guards against a pathological state where the
  // store's accounting disagrees with the worker's.
  for (let i = 0; i < 64; i += 1) {
    if (!promoteOne()) return;
  }
}

// ---------------------------------------------------------------------------
// Abort routing
// ---------------------------------------------------------------------------

function handleAbortTransitions(
  current: ReadonlyArray<SubAgentRun>,
  previous: ReadonlyArray<SubAgentRun>,
): void {
  // Build a quick id → prev-status map so we can detect the exact moment a
  // run flips into 'aborted'. We don't want to abort on every re-render.
  const prevById = new Map<string, SubAgentStatus>();
  for (const run of previous) prevById.set(run.id, run.status);

  for (const run of current) {
    if (run.status !== 'aborted') continue;
    const prev = prevById.get(run.id);
    if (prev === 'aborted') continue; // already handled
    const controller = workerState.controllers.get(run.id);
    if (!controller) continue;
    controller.abort();
    // The controller reference can stay in the map until the runAgent
    // promise's finally-block deletes it — the signal is now tripped and
    // any further work the loop does will short-circuit.
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function startSubAgentWorker(): () => void {
  if (workerState.running && workerState.unsubscribe) {
    // Idempotent — callers can safely invoke from multiple mount points
    // (e.g. React strict mode double-mount) without spawning two workers.
    return workerState.unsubscribe;
  }

  workerState.running = true;

  // Subscribe to the full store; zustand v5 hands us (state, prev) so we
  // can diff for abort transitions without keeping our own snapshot.
  const unsubscribe = useSubAgents.subscribe((state, prev) => {
    handleAbortTransitions(state.runs, prev.runs);
    drainQueue();
  });

  // Kick the queue once in case runs were already present (e.g. restored
  // from localStorage on page load).
  drainQueue();

  const dispose = (): void => {
    if (!workerState.running) return;
    workerState.running = false;
    try {
      unsubscribe();
    } catch (error) {
      console.error('Failed to unsubscribe sub-agent worker:', error);
    }
    workerState.unsubscribe = null;
    // Abort every in-flight run so we don't leak promises after teardown.
    for (const controller of workerState.controllers.values()) {
      try {
        controller.abort();
      } catch (error) {
        console.error('Failed to abort in-flight sub-agent:', error);
      }
    }
    workerState.controllers.clear();
  };

  workerState.unsubscribe = dispose;
  return dispose;
}
