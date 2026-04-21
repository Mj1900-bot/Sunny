// Boot once in App.tsx: startMemoryWriter(); — it's idempotent.
//
// Listens to the agent store and, on every completed run, asks the Rust
// `memory_add` command to persist a short summary so SUNNY accumulates context
// across conversations. The writer is a pure side-effect module — it never
// touches the store itself, only subscribes. Running outside Tauri is safe:
// invokeSafe returns null and we quietly skip.

import { useAgentStore } from '../store/agent';
import type { AgentRunStatus, PlanStep } from '../store/agent';
import { invokeSafe } from './tauri';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type MemoryWriterOptions = {
  /** Minimum finalAnswer length to warrant a memory. Default 40 chars. */
  readonly minLength?: number;
  /** Which statuses trigger a write. Default ['done']. */
  readonly statuses?: ReadonlyArray<'done' | 'aborted' | 'error' | 'max_steps'>;
  /** Optional override: transform a run into the memory text. Default is a builtin formatter. */
  readonly summarize?: (run: {
    goal: string;
    finalAnswer: string;
    toolNames: string[];
    startedAt: number;
    endedAt: number;
  }) => { text: string; tags: string[] } | null;
};

/** Start listening to the agent store and writing memories on completed runs.
 *  Returns an unsubscribe fn. Idempotent — repeated calls dedupe. */
export function startMemoryWriter(opts?: MemoryWriterOptions): () => void {
  // Idempotent: if already listening, just return the existing detach.
  if (activeUnsub) return activeUnsub;

  const minLength = opts?.minLength ?? 40;
  const statuses = opts?.statuses ?? (['done'] as const);
  const summarize = opts?.summarize ?? defaultSummarize;

  // Track previous store state so we can detect running → terminal transitions.
  let prevStatus: AgentRunStatus = useAgentStore.getState().status;

  const unsub = useAgentStore.subscribe(state => {
    const nextStatus = state.status;
    const wasRunning = prevStatus === 'running';
    prevStatus = nextStatus;

    if (!wasRunning) return;
    if (nextStatus === 'running' || nextStatus === 'idle') return;

    // Guard against the options type allowing 'max_steps' — the store's
    // AgentRunStatus doesn't emit it today, but the contract accepts it for
    // forward compat. A plain includes() on a widened array covers both cases.
    const allowed = statuses as ReadonlyArray<string>;
    if (!allowed.includes(nextStatus)) return;

    const finalAnswer = state.finalAnswer.trim();
    if (finalAnswer.length < minLength) return;

    const goal = state.goal;
    const toolNames = extractToolNames(state.steps);
    const startedAt = state.startedAt ?? Date.now();
    const endedAt = Date.now();

    let payload: { text: string; tags: string[] } | null;
    try {
      payload = summarize({ goal, finalAnswer, toolNames, startedAt, endedAt });
    } catch (err) {
      // Never throw from the subscription callback. A bad summarizer
      // shouldn't take the app down — just log and skip this run.
      console.error('memoryWriter: summarize threw', err);
      return;
    }
    if (!payload) return;

    // Always include the run status as a tag so callers can filter later.
    const enrichedTags = uniq([...payload.tags, `status:${nextStatus}`]);

    // Dedupe: hash goal+finalAnswer so a double-fire of completeRun can't
    // write the same memory twice. Keeps the last N hashes in a ring buffer.
    const hash = djb2(goal + '\u0000' + finalAnswer);
    if (recentHashes.includes(hash)) return;
    recentHashes = [hash, ...recentHashes].slice(0, HASH_RING_SIZE);

    // Fire-and-forget — invokeSafe already swallows errors and returns null
    // when Tauri isn't present (e.g. running in vite preview). Chaining a
    // .catch is still cheap insurance in case the contract ever regresses.
    void Promise.resolve(
      invokeSafe('memory_add', { text: payload.text, tags: enrichedTags })
    ).catch(err => {
      console.error('memoryWriter: memory_add failed', err);
    });
  });

  const detach = (): void => {
    unsub();
    // Only clear the module-level handle if it still points at us; a later
    // start/stop cycle may have replaced it.
    if (activeUnsub === detach) activeUnsub = null;
  };
  activeUnsub = detach;
  return detach;
}

/** Force-stop. Useful for tests. */
export function stopMemoryWriter(): void {
  if (activeUnsub) {
    activeUnsub();
    activeUnsub = null;
  }
  recentHashes = [];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const HASH_RING_SIZE = 30;

// Module-level singletons — the writer is a process-wide listener, so a
// single unsub handle and a single dedupe ring are the right granularity.
let activeUnsub: (() => void) | null = null;
let recentHashes: ReadonlyArray<number> = [];

function defaultSummarize(run: {
  goal: string;
  finalAnswer: string;
  toolNames: string[];
  startedAt: number;
  endedAt: number;
}): { text: string; tags: string[] } {
  const trimmedAnswer = truncate(run.finalAnswer.trim(), 400);
  const tools = uniq(run.toolNames).slice(0, 5);
  const toolSuffix = tools.length ? ` [used: ${tools.join(', ')}]` : '';
  const text = `User asked: "${run.goal}" — SUNNY answered: "${trimmedAnswer}"${toolSuffix}`;
  // The caller appends the status tag, so we only emit the agent-run marker
  // plus the tool names here — keeps the formatter contract simple.
  const tags = ['agent-run', ...tools];
  return { text, tags };
}

function extractToolNames(steps: ReadonlyArray<PlanStep>): string[] {
  // Only tool_call frames carry the canonical tool name; tool_result frames
  // echo it too but we'd then double-count every invocation.
  const names: string[] = [];
  for (const step of steps) {
    if (step.kind === 'tool_call' && step.toolName) {
      names.push(step.toolName);
    }
  }
  return names;
}

function uniq<T>(xs: ReadonlyArray<T>): T[] {
  // Preserve first-seen order — callers rely on it for human-readable tags.
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Reserve one char for the ellipsis so total length === max.
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function djb2(s: string): number {
  // Classic djb2 — collisions are astronomically unlikely for the ~30-entry
  // ring we keep, and avoiding a crypto import keeps this module dep-free.
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}
