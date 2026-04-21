/**
 * brainstorm store — chat mode (task | brainstorm) and idle-prompt state.
 *
 * Single source of truth for mode. Consumers read `mode` directly;
 * mutations go through `enterBrainstorm` / `exitBrainstorm`.
 *
 * Immutable state: every setter returns a new object via Zustand's `set`.
 */
import { create } from 'zustand';

export type ChatMode = 'task' | 'brainstorm';

type BrainstormState = {
  /** Current conversational contract. */
  mode: ChatMode;
  /** Whether the "Want a sounding board?" idle prompt is visible. */
  idlePromptVisible: boolean;
  /**
   * Timestamp (ms) when the idle prompt was dismissed — we suppress it
   * for 20 min after a dismiss.
   */
  idlePromptDismissedAt: number | null;

  enterBrainstorm: () => void;
  exitBrainstorm: () => void;
  showIdlePrompt: () => void;
  dismissIdlePrompt: () => void;
};

export const useBrainstormStore = create<BrainstormState>(set => ({
  mode: 'task',
  idlePromptVisible: false,
  idlePromptDismissedAt: null,

  enterBrainstorm: () =>
    set({ mode: 'brainstorm', idlePromptVisible: false }),

  exitBrainstorm: () =>
    set({ mode: 'task', idlePromptVisible: false }),

  showIdlePrompt: () =>
    set({ idlePromptVisible: true }),

  dismissIdlePrompt: () =>
    set({ idlePromptVisible: false, idlePromptDismissedAt: Date.now() }),
}));
