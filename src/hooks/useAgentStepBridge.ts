/**
 * useAgentStepBridge — subscribes to `SunnyEvent::AgentStep` via the sprint-7
 * push-channel event bus (`useEventBus`) and replays each step into the
 * shared `useAgentStore`. Any subscriber to that store (PlanPanel,
 * AgentOverlay, AgentActivity) lights up for free — no component-level
 * wiring needed.
 *
 * Sprint-8 migration: this hook previously subscribed to the Tauri event
 * `sunny://agent.step`. The Rust producer (`agent_loop::helpers::
 * emit_agent_step`) still publishes `SunnyEvent::AgentStep` to the bus with
 * the same semantics, so the translation layer below (isRustKind /
 * stepToStatus / appendStep) is unchanged — only the transport moved.
 *
 * The hook is deliberately side-effect only (no return value). Mount it
 * once, high up in the tree (see Dashboard.tsx), so it's alive whenever
 * the user can see those panels.
 *
 * Bus → store kind mapping (PlanStep only has `kind`, `text`, `toolName`,
 * `id`, `at` — we don't invent new fields for iteration/args/result):
 *
 *   thinking    → kind: 'message'      text: <content>
 *   tool_call   → kind: 'tool_call'    text: <args preview>   toolName: <name>
 *   tool_result → kind: 'tool_result'  text: <result preview> toolName: <name>
 *   error       → kind: 'error'        text: <content>
 *   answer      → store.completeRun('done', <content>)  (terminal, no step)
 *
 * On the bus side, `SunnyEvent::AgentStep.tool` carries the original Rust
 * kind string ("thinking" / "tool_call" / ...) and `.text` carries the
 * original `content`. Iteration count is preserved on the event but not
 * stored on `PlanStep` (the pre-migration bridge already dropped it).
 */

import { useEffect, useRef } from 'react';
import { useEventBus, type SunnyEvent } from './useEventBus';
import { useAgentStore, type PlanStep, type PlanStepKind } from '../store/agent';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentStepEvent = Extract<SunnyEvent, { kind: 'AgentStep' }>;

// Narrow the free-form Rust kind string against the values we actually handle.
type RustKind = 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'error';

function isRustKind(value: string): value is RustKind {
  return (
    value === 'thinking' ||
    value === 'tool_call' ||
    value === 'tool_result' ||
    value === 'answer' ||
    value === 'error'
  );
}

// ---------------------------------------------------------------------------
// Parsing helpers — tolerant. Prefer returning the raw content over throwing.
// ---------------------------------------------------------------------------

const CHAT_HISTORY_KEY = 'sunny.chat.history.v1';
const GOAL_FALLBACK = '(voice turn)';
const TEXT_MAX_CHARS = 400;

type ChatMessageShape = {
  readonly role?: unknown;
  readonly text?: unknown;
};

/**
 * Best-effort: pull the most recent user message from ChatPanel's persisted
 * history. Used as the run goal when the Rust backend starts emitting steps
 * without the frontend having called startRun(). Returns GOAL_FALLBACK if
 * history is empty, unreadable, or malformed — the caller should never crash
 * because of a missing goal.
 */
function inferGoal(): string {
  try {
    if (typeof localStorage === 'undefined') return GOAL_FALLBACK;
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!raw) return GOAL_FALLBACK;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return GOAL_FALLBACK;
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      const m = parsed[i] as ChatMessageShape | null | undefined;
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'user' && typeof m.text === 'string' && m.text.length > 0) {
        return m.text;
      }
    }
    return GOAL_FALLBACK;
  } catch {
    return GOAL_FALLBACK;
  }
}

/**
 * Parse a `tool_call` content string of the shape `name({json-preview})`
 * into its component parts. Tolerant:
 *   - `"fs_list({\"path\":\"/x\"})"` → { name: 'fs_list', args: '{"path":"/x"}' }
 *   - `"fs_list()"`                 → { name: 'fs_list', args: '' }
 *   - `"no_parens"`                 → { name: 'no_parens', args: '' }
 *   - `""`                          → { name: '', args: '' }
 * Always trims. Drops the trailing `)` if present; if it isn't (truncated
 * preview), keeps everything after the first `(`.
 */
function splitToolCall(raw: string): { readonly name: string; readonly args: string } {
  const s = raw.trim();
  if (s.length === 0) return { name: '', args: '' };
  const openIdx = s.indexOf('(');
  if (openIdx < 0) return { name: s, args: '' };
  const name = s.slice(0, openIdx).trim();
  const afterOpen = s.slice(openIdx + 1);
  // Strip the matching close paren if it's the last non-whitespace char.
  const trimmedAfter = afterOpen.trimEnd();
  const args = trimmedAfter.endsWith(')')
    ? trimmedAfter.slice(0, -1)
    : trimmedAfter;
  return { name, args: args.trim() };
}

/**
 * Parse a `tool_result` content string of the shape `name → preview` into
 * its component parts. Tolerant:
 *   - Rust emits a Unicode arrow `→`; fall back on `->` too in case of a
 *     future encoding change.
 *   - No arrow at all → keep raw as preview, empty name (the UI still shows
 *     the step; it just won't have a tool badge).
 *   - Multi-line previews are preserved verbatim; callers can clamp further.
 */
function splitToolResult(raw: string): { readonly name: string; readonly preview: string } {
  const s = raw.trimStart();
  if (s.length === 0) return { name: '', preview: '' };
  const arrowUnicode = s.indexOf('\u2192'); // →
  const arrowAscii = s.indexOf('->');
  // Pick whichever arrow appears first (and only if it's found).
  let arrowAt = -1;
  let arrowLen = 0;
  if (arrowUnicode >= 0 && (arrowAscii < 0 || arrowUnicode < arrowAscii)) {
    arrowAt = arrowUnicode;
    arrowLen = 1;
  } else if (arrowAscii >= 0) {
    arrowAt = arrowAscii;
    arrowLen = 2;
  }
  if (arrowAt < 0) return { name: '', preview: s };
  const name = s.slice(0, arrowAt).trim();
  const preview = s.slice(arrowAt + arrowLen).trimStart();
  return { name, preview };
}

function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
}

// ---------------------------------------------------------------------------
// Step construction
// ---------------------------------------------------------------------------

let stepCounter = 0;
function nextStepId(): string {
  stepCounter += 1;
  return `rust_step_${Date.now().toString(36)}_${stepCounter}`;
}

function buildStep(
  kind: PlanStepKind,
  text: string,
  toolName: string | undefined,
): PlanStep {
  return {
    id: nextStepId(),
    kind,
    text,
    toolName: toolName !== undefined && toolName.length > 0 ? toolName : undefined,
    at: Date.now(),
  };
}

/**
 * Decide whether the store is in a state where a fresh step implies a new
 * run. All non-running statuses (idle, done, aborted, error) qualify — the
 * Rust loop may fire its first event right after a previous run completed.
 */
function shouldStartRun(status: ReturnType<typeof useAgentStore.getState>['status']): boolean {
  return status !== 'running';
}

/**
 * Stable dedupe key for an AgentStep event. Prefers the monotonic `seq`
 * (sprint-7 guarantee) and falls back to a composite when the event
 * predates the seq rollout.
 */
function eventDedupeKey(evt: AgentStepEvent): string {
  if (typeof evt.seq === 'number') return `seq|${evt.seq}`;
  return `evt|${evt.at}|${evt.turn_id}|${evt.iteration}`;
}

/**
 * Translate one bus `AgentStep` event into the store mutation the old
 * Tauri-listener bridge performed. Pure with respect to its arguments;
 * the only side effect is the `useAgentStore` write.
 */
function applyAgentStep(evt: AgentStepEvent): void {
  // `tool` on the bus carries the original Rust kind ("thinking" /
  // "tool_call" / ...). `text` carries the original content. Normalise
  // to strings — the variant types already guarantee `text: string`
  // but `tool` is optional.
  const kind = typeof evt.tool === 'string' ? evt.tool : '';
  const content = evt.text;

  if (!isRustKind(kind)) {
    // Unknown kinds get routed through as plain messages rather than
    // dropped — easier to diagnose a future Rust addition this way.
    const store = useAgentStore.getState();
    if (shouldStartRun(store.status)) store.startRun(inferGoal());
    useAgentStore.getState().appendStep(
      buildStep('message', clampText(content, TEXT_MAX_CHARS), undefined),
    );
    return;
  }

  // `answer` is terminal — completeRun, don't append a redundant step.
  // (The existing PlanPanel surfaces `finalAnswer` separately; the
  // AgentOverlay uses the `done` status to show its green flash.)
  if (kind === 'answer') {
    const store = useAgentStore.getState();
    // If the backend emits an answer without a prior thinking/tool
    // event, we still need to have a run to complete. Guard: only
    // complete if there's an active run.
    if (store.status !== 'running') {
      // No active run to complete. Surface the content as a message
      // so the user isn't left with a silent answer drop.
      if (shouldStartRun(store.status)) store.startRun(inferGoal());
      useAgentStore.getState().appendStep(
        buildStep('message', clampText(content, TEXT_MAX_CHARS), undefined),
      );
      useAgentStore.getState().completeRun('done', content);
      return;
    }
    store.completeRun('done', content);
    return;
  }

  // Any non-answer step: ensure there's an active run, then append.
  const store = useAgentStore.getState();
  if (shouldStartRun(store.status)) {
    store.startRun(inferGoal());
  }

  switch (kind) {
    case 'thinking': {
      useAgentStore.getState().appendStep(
        buildStep('message', clampText(content, TEXT_MAX_CHARS), undefined),
      );
      break;
    }
    case 'tool_call': {
      const { name, args } = splitToolCall(content);
      const text = args.length > 0 ? args : '(no args)';
      useAgentStore.getState().appendStep(
        buildStep('tool_call', clampText(text, TEXT_MAX_CHARS), name),
      );
      break;
    }
    case 'tool_result': {
      const { name, preview } = splitToolResult(content);
      const text = preview.length > 0 ? preview : '(no output)';
      useAgentStore.getState().appendStep(
        buildStep('tool_result', clampText(text, TEXT_MAX_CHARS), name),
      );
      break;
    }
    case 'error': {
      useAgentStore.getState().appendStep(
        buildStep('error', clampText(content, TEXT_MAX_CHARS), undefined),
      );
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const BRIDGE_REPLAY_LIMIT = 50;

/**
 * Subscribe to `SunnyEvent::AgentStep` from the push-channel event bus and
 * mirror each event into `useAgentStore`. The sprint-8 migration dropped
 * the direct `sunny://agent.step` Tauri listener; the bus is now the only
 * transport.
 *
 * The bus seeds a warm-replay prefix on mount — we suppress that prefix
 * (everything at or before the mount watermark) so a fresh reload doesn't
 * flood the store with steps from a prior session. Only events that
 * arrive AFTER mount are replayed into the store.
 */
export function useAgentStepBridge(): void {
  const busEvents = useEventBus({ kind: 'AgentStep', limit: BRIDGE_REPLAY_LIMIT });

  // Per-instance dedupe — the bus returns a rolling window of newest-first
  // events, so every render we may re-see events we already applied.
  const seenRef = useRef<Set<string>>(new Set<string>());

  // Mount-time watermark — events with `at <= watermark` were already on
  // the bus before this bridge mounted (warm-replay from a previous run).
  // We suppress them to preserve the pre-migration behavior where the
  // Tauri listener only saw live events.
  const watermarkRef = useRef<number | null>(null);

  useEffect(() => {
    if (busEvents.length === 0) return;

    // First non-empty batch: record the highest `at` as the mount
    // watermark, and mark every seeded event as already seen. Subsequent
    // batches prepend only genuinely new events.
    if (watermarkRef.current === null) {
      let maxAt = Number.NEGATIVE_INFINITY;
      const seen = seenRef.current;
      for (const evt of busEvents) {
        if (evt.kind !== 'AgentStep') continue;
        seen.add(eventDedupeKey(evt));
        if (evt.at > maxAt) maxAt = evt.at;
      }
      watermarkRef.current = maxAt === Number.NEGATIVE_INFINITY ? 0 : maxAt;
      return;
    }

    // Collect fresh events (newest-first from the bus), then apply them
    // oldest-first so the store sees iteration N before iteration N+1.
    const watermark = watermarkRef.current;
    const seen = seenRef.current;
    const fresh: AgentStepEvent[] = [];
    for (const evt of busEvents) {
      if (evt.kind !== 'AgentStep') continue;
      if (evt.at <= watermark) continue;
      const key = eventDedupeKey(evt);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(evt);
    }
    if (fresh.length === 0) return;

    // Bus is newest-first; walk in reverse for chronological store writes.
    for (let i = fresh.length - 1; i >= 0; i -= 1) {
      applyAgentStep(fresh[i]);
    }
  }, [busEvents]);
}
