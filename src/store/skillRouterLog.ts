/**
 * Skill-router log — trust surface for System-1 routing decisions.
 *
 * Every time `agentLoop` evaluates an incoming goal against the procedural
 * memory (the `[skill-router]` log lines added in sprint-8 δ), it now also
 * pushes a structured entry here so the SkillsPage can render a "Recent
 * matches" timeline: what goal came in, which skill won, at what cosine
 * similarity, was it fired or skipped, and if skipped — why.
 *
 * Kept deliberately separate from `useInsights`:
 *   - Insights is a user-visible "why did SUNNY do that" audit trail — it
 *     collapses many categories (skills, introspection, constitution,
 *     lessons) and is scoped to a short rolling window.
 *   - This log is the single-purpose match ledger the Skills workshop
 *     needs to explain routing behavior, including runs that DIDN'T fire
 *     a skill. Cleaner UI, cleaner mental model.
 *
 * Invariants:
 *   - Entries are append-only from the UI's point of view. `record` always
 *     creates a new object; the array reference changes on every push.
 *   - Bounded at MAX_ENTRIES so a long-running session doesn't balloon
 *     the store; oldest entries drop off the tail.
 *   - `topMatches` is a small (<=3) snapshot of the highest-scoring
 *     candidates considered at the decision point. The UI uses this to
 *     answer "why didn't a skill fire?" without re-querying memory.
 */
import { create } from 'zustand';

/** Reason a routing decision ended in `skipped` (not `fired`). */
export type SkipReason =
  | 'embeddings-disabled'
  | 'no-skill'
  | 'below-threshold'
  | 'no-recipe'
  | 'skill-error';

export type RouterMatchCandidate = {
  readonly skillId: string;
  readonly skillName: string;
  readonly score: number;
  readonly hasRecipe: boolean;
};

export type RouterLogEntry = {
  readonly id: string;
  /** Unix ms — the decision timestamp. */
  readonly at: number;
  /** The incoming goal text (un-truncated; UI truncates for display). */
  readonly goal: string;
  /** Top-1 match name if there was one, else null. */
  readonly matchedSkillName: string | null;
  /** Top-1 cosine similarity if there was one, else null. */
  readonly score: number | null;
  /** Threshold in effect at the decision point (usually EXECUTE_THRESHOLD). */
  readonly threshold: number;
  /** Whether the router actually executed the skill. */
  readonly fired: boolean;
  /** When `fired=false`, the specific reason. `null` on fires. */
  readonly skipReason: SkipReason | null;
  /** Up to 3 top candidates considered at this decision point. */
  readonly topMatches: ReadonlyArray<RouterMatchCandidate>;
};

type SkillRouterLogState = {
  readonly entries: ReadonlyArray<RouterLogEntry>;
  readonly record: (
    entry: Omit<RouterLogEntry, 'id' | 'at'> & { readonly at?: number },
  ) => void;
  readonly clear: () => void;
};

const MAX_ENTRIES = 20;

function makeId(): string {
  return `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useSkillRouterLog = create<SkillRouterLogState>((set) => ({
  entries: [],
  record: (partial) => {
    const entry: RouterLogEntry = {
      id: makeId(),
      at: partial.at ?? Date.now(),
      goal: partial.goal,
      matchedSkillName: partial.matchedSkillName,
      score: partial.score,
      threshold: partial.threshold,
      fired: partial.fired,
      skipReason: partial.skipReason,
      topMatches: partial.topMatches,
    };
    set((state) => {
      // Newest-first; cap to MAX_ENTRIES. Always a fresh array reference.
      const next = [entry, ...state.entries];
      return {
        entries: next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next,
      };
    });
  },
  clear: () => set({ entries: [] }),
}));

/**
 * Imperative shortcut for non-React callers (agentLoop). Mirrors the
 * pattern used by `pushInsight`. Swallows errors — the router decision
 * must never fail because the log store is unhappy.
 */
export function recordSkillRouterDecision(
  entry: Omit<RouterLogEntry, 'id' | 'at'> & { readonly at?: number },
): void {
  try {
    useSkillRouterLog.getState().record(entry);
  } catch (err) {
    console.error('[skillRouterLog] record failed:', err);
  }
}

/** Human label for a skip reason. Stable — UI uses this directly. */
export function skipReasonLabel(reason: SkipReason): string {
  switch (reason) {
    case 'embeddings-disabled':
      return 'embeddings off';
    case 'no-skill':
      return 'no candidate skill';
    case 'below-threshold':
      return 'below threshold';
    case 'no-recipe':
      return 'candidate had no recipe';
    case 'skill-error':
      return 'skill errored — fell back';
  }
}
