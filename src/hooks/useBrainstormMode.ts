/**
 * useBrainstormMode — toggle between task and brainstorm conversational contracts.
 *
 * Entry triggers:
 *   • Voice phrase matching "let's brainstorm" (caller passes the transcript).
 *   • Chat command `/brainstorm`.
 *   • Idle > 3 min on blank note (detected externally; call `showIdlePrompt`).
 *
 * Exit trigger:
 *   • Phrase matching "let's do it" or "take action" (caller passes text).
 *
 * The hook wraps useBrainstormStore so components only import one hook.
 * All phrase detection is done client-side (case-insensitive, trimmed).
 */
import { useCallback } from 'react';
import { useBrainstormStore, type ChatMode } from '../store/brainstorm';

const ENTER_PHRASES = [
  "let's brainstorm",
  "lets brainstorm",
  "/brainstorm",
] as const;

const EXIT_PHRASES = [
  "let's do it",
  "lets do it",
  "take action",
] as const;

/** @internal — exported for tests only. */
export const ENTER_PHRASES_EXPORT = ENTER_PHRASES;
/** @internal — exported for tests only. */
export const EXIT_PHRASES_EXPORT = EXIT_PHRASES;

/**
 * Pure phrase detector — no React, no Zustand. Exported for unit tests.
 * Checks exit phrases first (they take priority over entry phrases).
 */
export function detectBrainstormPhrase(text: string): 'entered' | 'exited' | null {
  const lower = text.trim().toLowerCase();
  for (const phrase of EXIT_PHRASES) {
    if (lower.includes(phrase)) return 'exited';
  }
  for (const phrase of ENTER_PHRASES) {
    if (lower.includes(phrase)) return 'entered';
  }
  return null;
}

export interface UseBrainstormModeResult {
  readonly mode: ChatMode;
  readonly idlePromptVisible: boolean;
  readonly enterBrainstorm: () => void;
  readonly exitBrainstorm: () => void;
  readonly showIdlePrompt: () => void;
  readonly dismissIdlePrompt: () => void;
  /**
   * Detect entry/exit phrase in the given text and apply the corresponding
   * transition. Returns `'entered'`, `'exited'`, or `null` (no match).
   */
  readonly detectPhrase: (text: string) => 'entered' | 'exited' | null;
  /**
   * True when the idle prompt should be suppressd (within the 20 min window
   * after the last dismiss).
   */
  readonly isIdleSuppressed: () => boolean;
}

const IDLE_SUPPRESS_MS = 20 * 60 * 1000; // 20 min

export function useBrainstormMode(): UseBrainstormModeResult {
  const mode = useBrainstormStore(s => s.mode);
  const idlePromptVisible = useBrainstormStore(s => s.idlePromptVisible);
  const idlePromptDismissedAt = useBrainstormStore(s => s.idlePromptDismissedAt);
  const enterBrainstorm = useBrainstormStore(s => s.enterBrainstorm);
  const exitBrainstorm = useBrainstormStore(s => s.exitBrainstorm);
  const showIdlePrompt = useBrainstormStore(s => s.showIdlePrompt);
  const dismissIdlePrompt = useBrainstormStore(s => s.dismissIdlePrompt);

  const detectPhrase = useCallback(
    (text: string): 'entered' | 'exited' | null => {
      const result = detectBrainstormPhrase(text);
      if (result === 'exited') exitBrainstorm();
      else if (result === 'entered') enterBrainstorm();
      return result;
    },
    [enterBrainstorm, exitBrainstorm],
  );

  const isIdleSuppressed = useCallback((): boolean => {
    if (idlePromptDismissedAt === null) return false;
    return Date.now() - idlePromptDismissedAt < IDLE_SUPPRESS_MS;
  }, [idlePromptDismissedAt]);

  return {
    mode,
    idlePromptVisible,
    enterBrainstorm,
    exitBrainstorm,
    showIdlePrompt,
    dismissIdlePrompt,
    detectPhrase,
    isIdleSuppressed,
  };
}
