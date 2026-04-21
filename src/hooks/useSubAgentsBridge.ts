/**
 * useSubAgentsBridge — subscribes to `SunnyEvent::SubAgent` via the sprint-7
 * push-channel event bus (`useEventBus`) and mirrors each lifecycle
 * transition into `useSubAgentsLive`. Mount once, high in the tree.
 *
 * Sprint-9 migration: this hook previously listened for the Tauri event
 * `sunny://agent.sub` emitted by `agent_loop::helpers::emit_sub_event`.
 * Agent β extended the bus variant with `iteration / step_kind / content`
 * so the full per-step detail can ride the event spine; agent γ (this
 * file) then retired the Tauri emit and moved the bridge onto the bus.
 *
 * Bus event → lifecycle mapping (all fields are optional at the TS type
 * level — β's extension landed but older serialized rows still deserialise
 * without them). Rust `emit_sub_event` packs lifecycle-specific data:
 *
 *   lifecycle: 'start'
 *     - goal    = task
 *     - content = JSON {role, model, parent, depth}
 *   lifecycle: 'step'
 *     - iteration, step_kind, content = per-iteration body
 *   lifecycle: 'done'
 *     - content = final answer
 *   lifecycle: 'error'
 *     - content = error message
 *
 * Unknown lifecycles are logged and ignored.
 */

import { useEffect, useRef } from 'react';
import { useEventBus, type SunnyEvent } from './useEventBus';
import {
  useSubAgentsLive,
  type SubAgentRole,
  type SubAgentStep,
  type SubAgentStepKind,
} from '../store/subAgentsLive';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubAgentBusEvent = Extract<SunnyEvent, { kind: 'SubAgent' }>;

/**
 * β-extended bus fields. TS's `SunnyEvent` type only tracks the sprint-7
 * baseline shape (`run_id / lifecycle / goal / at / seq`), so we read the
 * extension fields (`iteration / step_kind / content`) defensively via
 * `unknown` + narrow, rather than widening the public type and forcing
 * every consumer to handle them. The Rust wire uses
 * `#[serde(rename = "step_kind")]` for the kind field to avoid colliding
 * with the enum's `#[serde(tag = "kind")]` discriminator.
 */
type ExtendedFields = {
  readonly iteration?: number;
  readonly step_kind?: string;
  readonly content?: string;
};

const ROLE_VALUES: ReadonlySet<SubAgentRole> = new Set<SubAgentRole>([
  'researcher',
  'coder',
  'writer',
  'browser_driver',
  'planner',
  'summarizer',
  'critic',
  'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asRole(value: unknown): SubAgentRole {
  if (typeof value !== 'string') return 'unknown';
  return ROLE_VALUES.has(value as SubAgentRole)
    ? (value as SubAgentRole)
    : 'unknown';
}

function asParentId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/**
 * Read β's extension fields off the bus event without widening the
 * public `SunnyEvent` type. If β's Rust side hasn't landed the event
 * shape yet these simply read `undefined` and the bridge falls back
 * to the defaults below.
 */
function readExtended(evt: SubAgentBusEvent): ExtendedFields {
  const raw = evt as unknown as Record<string, unknown>;
  const out: { iteration?: number; step_kind?: string; content?: string } = {};
  if (typeof raw.iteration === 'number') out.iteration = raw.iteration;
  if (typeof raw.step_kind === 'string') out.step_kind = raw.step_kind;
  if (typeof raw.content === 'string') out.content = raw.content;
  return out;
}

// ---------------------------------------------------------------------------
// Run-id helpers
// ---------------------------------------------------------------------------

const RUN_ID_PREFIX = 'sub:';

/**
 * Rust `derive_run_id` stamps `"sub:<sub_id>"` on every SubAgent event.
 * Strip the prefix so the store keys on the raw sub-agent id (preserves
 * the pre-migration shape the store consumed).
 */
function stripRunPrefix(runId: string): string {
  return runId.startsWith(RUN_ID_PREFIX)
    ? runId.slice(RUN_ID_PREFIX.length)
    : runId;
}

// ---------------------------------------------------------------------------
// Text shaping
// ---------------------------------------------------------------------------

const STEP_TEXT_MAX = 200;

function clampText(text: string, max: number = STEP_TEXT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
}

/**
 * Parse a `tool_call` content string of the shape `name({args})`.
 * Tolerant — accepts `name`, `name()`, `name(partial`, or raw text.
 * Mirrors the logic in useAgentStepBridge so the two surfaces stay in sync.
 */
function splitToolCall(raw: string): { readonly name: string; readonly args: string } {
  const s = raw.trim();
  if (s.length === 0) return { name: '', args: '' };
  const openIdx = s.indexOf('(');
  if (openIdx < 0) return { name: s, args: '' };
  const name = s.slice(0, openIdx).trim();
  const afterOpen = s.slice(openIdx + 1).trimEnd();
  const args = afterOpen.endsWith(')') ? afterOpen.slice(0, -1) : afterOpen;
  return { name, args: args.trim() };
}

/**
 * Parse a `tool_result` content string of the shape `name → preview`.
 * Falls back gracefully when the arrow is missing or truncated.
 */
function splitToolResult(raw: string): { readonly name: string; readonly preview: string } {
  const s = raw.trimStart();
  if (s.length === 0) return { name: '', preview: '' };
  const arrowUnicode = s.indexOf('\u2192');
  const arrowAscii = s.indexOf('->');
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
  return {
    name: s.slice(0, arrowAt).trim(),
    preview: s.slice(arrowAt + arrowLen).trimStart(),
  };
}

// ---------------------------------------------------------------------------
// Inner step → SubAgentStep
// ---------------------------------------------------------------------------

function toStepKind(raw: string): SubAgentStepKind | null {
  switch (raw) {
    case 'thinking':
    case 'tool_call':
    case 'tool_result':
    case 'error':
      return raw;
    default:
      return null;
  }
}

/**
 * Build a `SubAgentStep` from an inner step event. Returns `null` when
 * the kind is unrecognised — the caller should ignore nulls rather than
 * crash.
 */
function buildStep(
  stepKind: string,
  content: string,
  atMs: number,
): SubAgentStep | null {
  const kind = toStepKind(stepKind);
  if (!kind) return null;

  if (kind === 'tool_call') {
    const { name, args } = splitToolCall(content);
    const text = args.length > 0 ? args : '(no args)';
    return {
      at: atMs,
      kind,
      text: clampText(text),
      toolName: name.length > 0 ? name : undefined,
    };
  }
  if (kind === 'tool_result') {
    const { name, preview } = splitToolResult(content);
    const text = preview.length > 0 ? preview : '(no output)';
    return {
      at: atMs,
      kind,
      text: clampText(text),
      toolName: name.length > 0 ? name : undefined,
    };
  }
  return { at: atMs, kind, text: clampText(content) };
}

// ---------------------------------------------------------------------------
// Start-lifecycle payload parsing
// ---------------------------------------------------------------------------

type StartBlob = {
  readonly role: SubAgentRole;
  readonly model: string;
  readonly parentId: string | null;
};

/**
 * Rust packs {role, model, parent, depth} into `content` as JSON for
 * `start` lifecycle events. Parse tolerantly: a malformed blob gives
 * defaults rather than crashing the bridge.
 */
function parseStartBlob(content: string): StartBlob {
  if (content.length === 0) {
    return { role: 'unknown', model: 'unknown', parentId: null };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      return { role: 'unknown', model: 'unknown', parentId: null };
    }
    return {
      role: asRole(parsed.role),
      model: asString(parsed.model, 'unknown'),
      parentId: asParentId(parsed.parent),
    };
  } catch {
    return { role: 'unknown', model: 'unknown', parentId: null };
  }
}

// ---------------------------------------------------------------------------
// Dispatch — one event → one store mutation
// ---------------------------------------------------------------------------

function dispatch(evt: SubAgentBusEvent): void {
  const store = useSubAgentsLive.getState();
  const id = stripRunPrefix(evt.run_id);
  if (id.length === 0) return;

  const lifecycle = evt.lifecycle;
  const ext = readExtended(evt);
  const content = ext.content ?? '';

  switch (lifecycle) {
    case 'start': {
      const blob = parseStartBlob(content);
      const task = asString(evt.goal, '(untitled sub-agent task)');
      store.start({
        id,
        role: blob.role,
        task,
        model: blob.model,
        parentId: blob.parentId,
      });
      return;
    }
    case 'step': {
      const step = buildStep(ext.step_kind ?? '', content, evt.at);
      if (step) store.step(id, step);
      return;
    }
    case 'done': {
      store.done(id, content);
      return;
    }
    case 'error': {
      const message = content.length > 0 ? content : 'Unknown sub-agent error';
      store.error(id, message);
      return;
    }
    default: {
      console.warn(
        `useSubAgentsBridge: ignoring unknown lifecycle "${lifecycle}"`,
      );
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/**
 * Stable dedupe key. Prefers the monotonic `seq` (sprint-7 guarantee)
 * and falls back to a composite for legacy rows without a seq.
 */
function eventDedupeKey(evt: SubAgentBusEvent): string {
  if (typeof evt.seq === 'number') return `seq|${evt.seq}`;
  const ext = readExtended(evt);
  const iter = ext.iteration ?? 0;
  return `evt|${evt.at}|${evt.run_id}|${evt.lifecycle}|${iter}`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const BRIDGE_REPLAY_LIMIT = 100;

/**
 * Subscribe to `SunnyEvent::SubAgent` from the push-channel event bus and
 * mirror each lifecycle transition into `useSubAgentsLive`.
 *
 * The bus seeds a warm-replay prefix on mount — we suppress that prefix
 * (everything at or before the mount watermark) so a fresh reload doesn't
 * flood the store with runs from a prior session. Only events that
 * arrive AFTER mount are replayed. Mirrors the pattern Agent α used for
 * `useAgentStepBridge` in sprint-8.
 */
export function useSubAgentsBridge(): void {
  const busEvents = useEventBus({ kind: 'SubAgent', limit: BRIDGE_REPLAY_LIMIT });

  // Per-instance dedupe — the bus returns a rolling window of newest-first
  // events, so every render we may re-see events we already applied.
  const seenRef = useRef<Set<string>>(new Set<string>());

  // Mount-time watermark — events with `at <= watermark` were already on
  // the bus before this bridge mounted (warm-replay from a previous run).
  // Suppressing them preserves the pre-migration behavior where the Tauri
  // listener only saw live events.
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
        if (evt.kind !== 'SubAgent') continue;
        seen.add(eventDedupeKey(evt));
        if (evt.at > maxAt) maxAt = evt.at;
      }
      watermarkRef.current = maxAt === Number.NEGATIVE_INFINITY ? 0 : maxAt;
      return;
    }

    const watermark = watermarkRef.current;
    const seen = seenRef.current;
    const fresh: SubAgentBusEvent[] = [];
    for (const evt of busEvents) {
      if (evt.kind !== 'SubAgent') continue;
      if (evt.at <= watermark) continue;
      const key = eventDedupeKey(evt);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(evt);
    }
    if (fresh.length === 0) return;

    // Bus is newest-first; walk in reverse for chronological store writes —
    // `start` must land before the first `step`, and `done / error` last.
    for (let i = fresh.length - 1; i >= 0; i -= 1) {
      try {
        dispatch(fresh[i]);
      } catch (error) {
        console.error('useSubAgentsBridge: dispatch failed', error);
      }
    }
  }, [busEvents]);
}
