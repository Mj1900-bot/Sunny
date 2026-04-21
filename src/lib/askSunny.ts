/**
 * Lightweight bridge for "ask Sunny" actions from module pages.
 *
 * Any page that surfaces a contextual action ("summarize this email",
 * "draft a reply to Jordan", "what's my next meeting") dispatches an
 * `sunny-ask` CustomEvent. The ChatPanel subscribes and feeds the prompt
 * through its normal `handleSend` path — so these shortcuts go through
 * the identical streaming / tool-use / memory-write pipeline as a
 * manually-typed message, with no parallel brain to keep in sync.
 *
 * Keep this file tiny on purpose: it's a typed wrapper over a window
 * event. The ChatPanel owns the listener; pages only produce events.
 */

export const SUNNY_ASK_EVENT = 'sunny-ask';

export type SunnyAskDetail = {
  /** The prompt sent to Sunny. Plain text, no markup. */
  readonly prompt: string;
  /** Optional short origin for audit / telemetry. */
  readonly source?: string;
};

/** Dispatch an ask from any module page. Safe on SSR (no-ops). */
export function askSunny(prompt: string, source?: string): void {
  if (typeof window === 'undefined') return;
  const detail: SunnyAskDetail = { prompt, source };
  window.dispatchEvent(new CustomEvent<SunnyAskDetail>(SUNNY_ASK_EVENT, { detail }));
}

/** Subscribe to ask-sunny events. Returns a disposer. */
export function onSunnyAsk(cb: (detail: SunnyAskDetail) => void): () => void {
  const handler = (e: Event) => {
    const ce = e as CustomEvent<SunnyAskDetail>;
    if (ce.detail && typeof ce.detail.prompt === 'string' && ce.detail.prompt.trim().length > 0) {
      cb(ce.detail);
    }
  };
  window.addEventListener(SUNNY_ASK_EVENT, handler);
  return () => window.removeEventListener(SUNNY_ASK_EVENT, handler);
}
