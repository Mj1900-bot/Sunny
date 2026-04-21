/**
 * Voice-path constitution kick plumbing.
 *
 * The chat path runs `verifyAnswer` inside `agentLoop.ts` and replaces the
 * whole answer with `CONSTITUTION_BLOCK_REPLY` on a blocking violation.
 * That's fine for typed replies the user can re-read, but a stock refusal
 * clipped into the TTS stream of a half-spoken answer reads like the
 * assistant short-circuited itself — worse UX than speaking a gently
 * truncated version.
 *
 * This module bridges the gap. `sanitizeVoiceAnswer` runs the shared
 * `verifyAnswer` (never forked) against the fully-composed voice reply
 * and applies the minimum text rewrite needed to satisfy each rule:
 *
 *   - `max_words`            → truncate + append "…" (audible ellipsis)
 *   - `no_emoji`             → strip emoji before TTS dispatch
 *   - `confirm_destructive_ran` → flag on the Orb with a one-second amber
 *                                 pulse (never blocks speech — the action
 *                                 already fired; muting the answer would
 *                                 erase the audit trail without undoing
 *                                 the effect).
 *   - every other rule       → pass through (logged as a kick so agent ε's
 *                                 Diagnostics page can surface the count,
 *                                 but not mutated: the voice path only
 *                                 knows how to fix the three above).
 *
 * Every detected violation is logged to `~/.sunny/constitution_kicks.log`
 * (JSONL via the Rust `constitution_kick_append` command) and increments
 * an in-process counter readable by the Diagnostics page.
 *
 * ### Fail-open contract
 *
 * If `verifyAnswer` throws, `sanitizeVoiceAnswer` returns the original
 * answer verbatim and logs the error. The constitution must not brick the
 * voice pipeline — a rule-engine bug is a lower-severity failure than
 * silent microphone death. The Tauri log-append command is fire-and-forget
 * for the same reason: a flaky filesystem must not freeze TTS.
 *
 * ### Latency budget
 *
 * The whole pipeline is synchronous regex work; the measured runtime on a
 * 200-word reply with all six recognised rules active is well under the
 * 50 ms hot-path budget quoted in the sprint brief. The Tauri invoke for
 * kick-log append is dispatched with `void` so it never waits on disk I/O.
 */

import { invokeSafe } from './tauri';
import {
  CONSTITUTION_BLOCK_REPLY,
  parseConstitutionValues,
  stripEmoji,
  truncateToWordCap,
  verifyAnswer,
  type Constitution,
  type ConstitutionViolation,
  type ParsedRule,
} from './constitution';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of a single JSONL row written to `~/.sunny/constitution_kicks.log`.
 * Kept minimal and flat — a future log reader (Diagnostics page tail view,
 * exploratory `jq` sessions) can hand-parse it without a schema handshake.
 */
export type ConstitutionKickRow = {
  readonly at: number;              // ms since epoch
  readonly source: 'voice' | 'chat';
  readonly kind: string;             // verifier rule key
  readonly severity: 'warn' | 'block';
  readonly detail: string;
  readonly before_words: number;
  readonly after_words: number;
  readonly action: 'truncated' | 'emoji_stripped' | 'flagged' | 'passthrough';
};

export type SanitizeResult = {
  /** Possibly-rewritten answer. Always safe to hand to TTS / the user. */
  readonly text: string;
  /** All violations surfaced this turn — logged, not necessarily actioned. */
  readonly violations: ReadonlyArray<ConstitutionViolation>;
  /** `true` iff at least one rewrite fired (caller may want to re-check). */
  readonly rewritten: boolean;
  /** `true` iff a confirm_destructive_ran warning was surfaced. */
  readonly needsAmberPulse: boolean;
};

// ---------------------------------------------------------------------------
// Counter — lives in-process; Diagnostics reads via `getKickCount()`
// ---------------------------------------------------------------------------
//
// We keep a per-session count in JS so the Diagnostics page doesn't have to
// parse the JSONL log on every render, and so React components can re-read
// without an async round-trip. The Rust command
// `constitution_kicks_count` also increments its own on-disk counter for
// cross-session persistence; `getPersistedKickCount` reads that.
// ---------------------------------------------------------------------------

let sessionKickCount = 0;

const KICK_COUNT_LISTENERS = new Set<() => void>();

function bumpSessionKickCount(): void {
  sessionKickCount += 1;
  // Invoke listeners on a fresh array copy so a subscriber mutating the set
  // inside its own callback can't race the iterator.
  for (const fn of [...KICK_COUNT_LISTENERS]) {
    try {
      fn();
    } catch (err) {
      console.error('[constitutionKicks] listener threw:', err);
    }
  }
}

/** Current in-memory kick count since this SUNNY process started. */
export function getSessionKickCount(): number {
  return sessionKickCount;
}

/**
 * Subscribe to kick-count changes. Returns an unsubscribe function.
 * Used by Diagnostics to re-render when the counter ticks.
 */
export function subscribeKickCount(fn: () => void): () => void {
  KICK_COUNT_LISTENERS.add(fn);
  return () => {
    KICK_COUNT_LISTENERS.delete(fn);
  };
}

/**
 * Read the cross-session persisted count from the Rust side. Returns null
 * outside the Tauri runtime or if the backend command isn't reachable.
 * Diagnostics uses this on mount, then falls back to the session count.
 */
export async function getPersistedKickCount(): Promise<number | null> {
  const n = await invokeSafe<number>('constitution_kicks_count');
  return typeof n === 'number' ? n : null;
}

// ---------------------------------------------------------------------------
// Amber pulse — fired on confirm_destructive_ran violations
// ---------------------------------------------------------------------------
//
// We don't touch the agent-store's existing `agentFlash` channel because
// that carries ReAct-loop done/error semantics and the orb's visual logic
// depends on those exact transitions. Instead we dispatch a tiny custom
// DOM event that OrbCore subscribes to; the orb's ring styling has its own
// amber-pulse hook next to the green/red flash so the two can coexist
// without racing.
// ---------------------------------------------------------------------------

const AMBER_PULSE_EVENT = 'sunny-constitution-amber-pulse';

export function AMBER_PULSE_EVENT_NAME(): string {
  // Exposed as a function so the OrbCore subscriber doesn't reach into a
  // const that tree-shaking might rename differently across bundles.
  return AMBER_PULSE_EVENT;
}

function dispatchAmberPulse(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(AMBER_PULSE_EVENT));
  } catch (err) {
    // CustomEvent should always be available in modern WebViews; log and
    // carry on if something pathological is going on.
    console.error('[constitutionKicks] dispatch amber pulse failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Main entry point — verify a voice answer and apply the minimum fix
// ---------------------------------------------------------------------------

export type SanitizeOptions = {
  readonly source?: 'voice' | 'chat';
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string;
    readonly dangerous: boolean;
    readonly confirmed: boolean;
  }>;
};

/**
 * Run the shared `verifyAnswer` and return a voice-safe version of the
 * answer with the minimum rewrite. Fails open — any thrown error logs and
 * returns the original text unchanged.
 */
export function sanitizeVoiceAnswer(
  answer: string,
  constitution: Constitution | null,
  options: SanitizeOptions = {},
): SanitizeResult {
  const source = options.source ?? 'voice';

  // Fast path: no constitution loaded, or no values at all → pass-through.
  if (!constitution || !constitution.values || constitution.values.length === 0) {
    return { text: answer, violations: [], rewritten: false, needsAmberPulse: false };
  }

  let values: ReadonlyArray<ParsedRule>;
  let violations: ReadonlyArray<ConstitutionViolation>;
  try {
    values = parseConstitutionValues(constitution.values);
    violations = verifyAnswer(answer, values, {
      toolCalls: options.toolCalls,
      source,
    });
  } catch (err) {
    // FAIL OPEN. The constitution must never brick voice.
    console.error('[constitutionKicks] verifyAnswer threw; passing through:', err);
    return { text: answer, violations: [], rewritten: false, needsAmberPulse: false };
  }

  if (violations.length === 0) {
    return { text: answer, violations: [], rewritten: false, needsAmberPulse: false };
  }

  // Extract constraints in a form we can re-use for rewrites without
  // re-parsing on every rule. New arrays — never mutate inputs.
  const wordCap = findMaxWordsCap(values);
  const hasNoEmoji = values.some(v => v.key === 'no_emoji');

  let working = answer;
  let rewritten = false;
  let needsAmberPulse = false;

  for (const v of violations) {
    const before = countWordsCheap(working);
    let action: ConstitutionKickRow['action'] = 'passthrough';

    if (v.kind === 'max_words' && wordCap !== null) {
      working = truncateToWordCap(working, wordCap);
      action = 'truncated';
      rewritten = true;
    } else if (v.kind === 'no_emoji' && hasNoEmoji) {
      working = stripEmoji(working);
      action = 'emoji_stripped';
      rewritten = true;
    } else if (v.kind === 'confirm_destructive_ran') {
      // Audit signal only — the tool already fired. Never block TTS here.
      needsAmberPulse = true;
      action = 'flagged';
    }

    const after = countWordsCheap(working);
    const row: ConstitutionKickRow = {
      at: Date.now(),
      source,
      kind: v.kind,
      severity: v.severity,
      detail: v.detail,
      before_words: before,
      after_words: after,
      action,
    };
    void appendKickLog(row);
    bumpSessionKickCount();
  }

  if (needsAmberPulse) {
    dispatchAmberPulse();
  }

  // Belt-and-suspenders: the rewrites above should be a fixed point for
  // every rule they address, but if the rewrite surfaced a *new* violation
  // (e.g. the ellipsis we appended tips sentence count, or the emoji
  // stripper left orphaned punctuation), fall back to the block reply
  // rather than speaking something we know violates a rule. This is a
  // belt for a rare failure — `truncateToWordCap` and `stripEmoji` are
  // both idempotent on the fixed point of their respective rules.
  if (rewritten) {
    try {
      const reVerify = verifyAnswer(working, parseConstitutionValues(constitution.values), {
        toolCalls: options.toolCalls,
        source,
      });
      const stillBlocking = reVerify.some(rv => rv.severity === 'block');
      if (stillBlocking) {
        working = CONSTITUTION_BLOCK_REPLY;
      }
    } catch (err) {
      // Fail open on re-verify too — better to speak the attempted rewrite
      // than to deadlock the voice turn.
      console.error('[constitutionKicks] re-verify threw; keeping rewrite:', err);
    }
  }

  return { text: working, violations, rewritten, needsAmberPulse };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findMaxWordsCap(
  values: ReadonlyArray<ParsedRule>,
): number | null {
  for (const v of values) {
    if (v.key !== 'max_words') continue;
    const n = Number.parseInt(v.constraint, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Cheap word count — matches the verifier's definition (whitespace split
 * after trim). Extracted so log rows are consistent with what the rule
 * engine actually measured. Kept private to this module; the verifier's
 * internal helper is not exported and forking the name space with another
 * public helper would invite drift.
 */
function countWordsCheap(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

async function appendKickLog(row: ConstitutionKickRow): Promise<void> {
  // Fire-and-forget. We never want to block TTS on disk. Any serialization
  // or backend error is logged and swallowed — the session counter already
  // captured the kick, and the audit log is best-effort.
  try {
    await invokeSafe('constitution_kick_append', { row });
  } catch (err) {
    console.error('[constitutionKicks] append failed:', err);
  }
}
