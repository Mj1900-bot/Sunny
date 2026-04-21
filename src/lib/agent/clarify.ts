// ---------------------------------------------------------------------------
// Clarify-continuation bridge.
//
// Problem this solves: when the pre-run introspector returns `clarify`, the
// agent emits a one-line message and returns `done`. The NEXT user message
// arrives as a fresh `runAgent()` call with zero knowledge of the outstanding
// question — so "what's on my calendar" → "for which day?" → "tomorrow" gets
// treated by the second call as a brand-new standalone goal ("tomorrow"),
// which is nonsense to plan against.
//
// The bridge: on `clarify` we stash `{originalGoal, clarifyingQuestion,
// issuedAt}` in a module-level Map keyed by sessionId. The next `runAgent`
// with the same sessionId (within the TTL) consumes the entry and composes a
// merged goal: original + "\n\nClarification from user: " + newMessage.
//
// Transience guarantees:
//   - Stored in a plain in-memory Map (NOT localStorage). Process restart
//     wipes it — which is the correct behaviour: after a restart the user
//     has almost certainly moved on, so we must NOT ambush them with a stale
//     clarify merge that reinterprets their first message of the new session.
//   - 5-minute TTL. If the user takes longer than that to answer, we assume
//     they've abandoned the thread and treat the next message as fresh.
//   - Consumed on read (single-shot). Second answer in a row is not merged
//     with the same original goal — that would chain interpretations and
//     drift further from user intent.
// ---------------------------------------------------------------------------

export type PendingClarifyState = {
  readonly originalGoal: string;
  readonly clarifyingQuestion: string;
  readonly issuedAt: number;
  readonly sessionId: string;
};

export const CLARIFY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CLARIFY_SESSION = '__default__';

// Module-level store. Keyed by sessionId so concurrent chat+voice sessions
// can't cross-pollinate, but fine to fall back to a single default key
// because SUNNY is single-user — overlap is the exception, not the rule.
const pendingClarifies: Map<string, PendingClarifyState> = new Map();

function clarifyKey(sessionId: string | undefined): string {
  const s = sessionId && sessionId.trim().length > 0 ? sessionId.trim() : DEFAULT_CLARIFY_SESSION;
  return s;
}

function pruneExpiredClarifies(now: number): void {
  // Iterate a snapshot so deletion during iteration is safe across engines.
  const entries = Array.from(pendingClarifies.entries());
  for (const [key, state] of entries) {
    if (now - state.issuedAt > CLARIFY_TTL_MS) {
      pendingClarifies.delete(key);
    }
  }
}

/**
 * Stash a pending clarify for this session. Overwrites any prior entry —
 * the freshest outstanding question always wins.
 */
export function savePendingClarify(
  sessionId: string | undefined,
  originalGoal: string,
  clarifyingQuestion: string,
): void {
  const key = clarifyKey(sessionId);
  const state: PendingClarifyState = {
    originalGoal,
    clarifyingQuestion,
    issuedAt: Date.now(),
    sessionId: key,
  };
  // New entry — immutable, always replace (no mutation of existing record).
  pendingClarifies.set(key, state);
}

/**
 * Pop the pending clarify for this session if one exists and is still within
 * the TTL. Returns `null` when there's nothing live to consume.
 */
export function consumePendingClarify(sessionId: string | undefined): PendingClarifyState | null {
  const now = Date.now();
  pruneExpiredClarifies(now);
  const key = clarifyKey(sessionId);
  const state = pendingClarifies.get(key);
  if (!state) return null;
  // Belt-and-braces: another check in case the entry survived the prune
  // narrowly (different clock reading). Correctness, not performance.
  if (now - state.issuedAt > CLARIFY_TTL_MS) {
    pendingClarifies.delete(key);
    return null;
  }
  pendingClarifies.delete(key);
  return state;
}

/**
 * Test-only export so unit tests can observe/seed clarify state without
 * reaching into module internals.
 */
export function peekPendingClarifyForTests(sessionId: string | undefined): PendingClarifyState | null {
  pruneExpiredClarifies(Date.now());
  return pendingClarifies.get(clarifyKey(sessionId)) ?? null;
}

export function clearPendingClarifiesForTests(): void {
  pendingClarifies.clear();
}
