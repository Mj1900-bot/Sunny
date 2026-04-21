/**
 * Agent insights — a user-visible log of "why SUNNY did what it did".
 *
 * Every time an internal subsystem makes a non-trivial decision that
 * changes the user's experience, it pushes an `Insight` here. The HUD
 * surfaces the most recent N as a persistent feed and fires a transient
 * toast for the highest-signal kinds (skill execution, skill synthesis,
 * introspection hits). This is what turns an opaque "the AI answered"
 * into a legible "the AI checked memory first, matched a learned skill,
 * and bypassed the model — here's the evidence."
 *
 * Kinds (stable — add new ones rather than repurposing):
 *   • `skill_fired`       — System-1 ran a skill instead of the LLM loop
 *   • `skill_synthesized` — a new procedural recipe was compiled from runs
 *   • `introspect_direct` — pre-run introspection answered from memory
 *   • `introspect_clarify`— pre-run introspection asked for clarification
 *   • `introspect_caveat` — pre-run introspection added caveats to prompt
 *   • `memory_lesson`     — reflection promoted a durable lesson
 *   • `constitution_block`— a tool call was denied by policy (future)
 *
 * This store is deliberately separate from `useToastStore`:
 *   - Toasts are a render primitive (transient, UI-chrome).
 *   - Insights are an audit trail (persistent session, UI-agnostic,
 *     inspectable, filterable). Any new "SUNNY Knows" panel reads from here.
 */
import { create } from 'zustand';
import { useToastStore } from './toasts';

export type InsightKind =
  | 'skill_fired'
  | 'skill_synthesized'
  | 'introspect_direct'
  | 'introspect_clarify'
  | 'introspect_caveat'
  | 'memory_lesson'
  | 'constitution_block';

export type Insight = {
  readonly id: string;
  readonly kind: InsightKind;
  readonly title: string;
  /** One-line human summary. What the user sees in the toast + feed. */
  readonly detail: string;
  /** Optional structured payload the inspector can render in detail view. */
  readonly data?: unknown;
  readonly createdAt: number;
};

type InsightsState = {
  readonly insights: ReadonlyArray<Insight>;
  readonly push: (
    kind: InsightKind,
    title: string,
    detail: string,
    data?: unknown,
  ) => void;
  readonly clear: () => void;
};

const MAX_INSIGHTS = 50;

const TOAST_KINDS: ReadonlySet<InsightKind> = new Set<InsightKind>([
  'skill_fired',
  'skill_synthesized',
  'introspect_direct',
  'introspect_clarify',
  'memory_lesson',
  'constitution_block',
]);

function toastKindFor(insight: InsightKind): 'success' | 'info' | 'error' {
  switch (insight) {
    case 'skill_fired':
    case 'skill_synthesized':
    case 'memory_lesson':
      return 'success';
    case 'constitution_block':
      return 'error';
    default:
      return 'info';
  }
}

function makeId(): string {
  return `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useInsights = create<InsightsState>((set) => ({
  insights: [],
  push: (kind, title, detail, data) => {
    const entry: Insight = {
      id: makeId(),
      kind,
      title,
      detail,
      data,
      createdAt: Date.now(),
    };
    set(state => {
      const next = [entry, ...state.insights];
      return {
        insights: next.length > MAX_INSIGHTS ? next.slice(0, MAX_INSIGHTS) : next,
      };
    });
    // Fire a transient toast for high-signal kinds. Lower-signal insights
    // (introspect_caveat) stay in the feed without interrupting the user.
    if (TOAST_KINDS.has(kind)) {
      try {
        useToastStore.getState().push(toastKindFor(kind), `${title} · ${detail}`, 5000);
      } catch (err) {
        // Toast store is React-land — must never crash the emitter.
        console.error('[insights] toast push failed:', err);
      }
    }
  },
  clear: () => set({ insights: [] }),
}));

/**
 * Imperative shortcut for non-React callers (library modules like
 * skillExecutor, introspect, skillSynthesis). Equivalent to
 * `useInsights.getState().push(...)` but keeps the call sites terse.
 */
export function pushInsight(
  kind: InsightKind,
  title: string,
  detail: string,
  data?: unknown,
): void {
  try {
    useInsights.getState().push(kind, title, detail, data);
  } catch (err) {
    console.error('[insights] push failed:', err);
  }
}
