/**
 * Session persistence and message-shape utilities for ChatPanel.
 *
 * Extracted from ChatPanel.tsx to keep the component focused on
 * rendering and event wiring (≤ 400 lines).
 */

export type Role = 'user' | 'sunny' | 'system';

export type Message = {
  id: string;
  role: Role;
  text: string;
  ts: number;
  streaming?: boolean;
};

// Mirror of `memory::conversation::Turn` on the Rust side.
// Kept read-only; used to validate shapes returned by `conversation_tail`.
export type Turn = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  at: number;
};

export const STORAGE_KEY = 'sunny.chat.history.v1';
export const SESSION_KEY = 'sunny.chat.sessionId.v1';
export const MAX_HISTORY = 100;
/**
 * Rolling LLM context window. Mirrors useVoiceChat's MAX_HISTORY_TURNS —
 * 8 user turns + 8 assistant turns = 16 messages. Without this ChatPanel
 * would send every typed turn as a single-message conversation.
 */
export const MAX_LLM_TURNS = 8;

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing && existing.length > 0) return existing;
  } catch { /* private mode — fall through */ }
  const sid = `sunny-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try { localStorage.setItem(SESSION_KEY, sid); } catch { /* ignore */ }
  return sid;
}

export function rotateSessionId(): string {
  const sid = `sunny-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try { localStorage.setItem(SESSION_KEY, sid); } catch { /* ignore */ }
  return sid;
}

/**
 * Write an explicit session id to localStorage. Used when SessionPicker
 * resumes a past conversation — persisting keeps the "reload = same session"
 * contract.
 */
export function persistSessionId(sid: string): void {
  try { localStorage.setItem(SESSION_KEY, sid); } catch { /* ignore */ }
}

/**
 * Map a persisted `Turn[]` (oldest-first) back to the local `Message[]`
 * shape. Tool turns are surfaced as system notices.
 */
export function turnsToMessages(turns: readonly Turn[]): Message[] {
  return turns.map(t => {
    const role: Role =
      t.role === 'user' ? 'user' : t.role === 'assistant' ? 'sunny' : 'system';
    return {
      id: makeId(),
      role,
      text: typeof t.content === 'string' ? t.content : '',
      ts: typeof t.at === 'number' ? t.at : Date.now(),
    };
  });
}

/**
 * Pull the human text out of an agent JSON envelope if the message was
 * persisted pre-fix (the ChatPanel used to store raw `{"action":"answer",
 * "text":"…"}` strings). Guard-clauses fall through on anything that
 * isn't recognisably an envelope — plain text, system notices, or user
 * messages pass untouched.
 *
 * Duplicated here instead of imported from unwrapEnvelope.ts so the
 * session-persistence module stays dependency-free from component code
 * (session.ts is imported by hooks, components, and tests).
 */
function unwrapPersistedText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return raw;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.action === 'string' && typeof parsed.text === 'string') {
      return parsed.text;
    }
  } catch {
    /* fall through */
  }
  return raw;
}

export function loadHistory(): Message[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m): m is Message =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as Message).id === 'string' &&
        typeof (m as Message).role === 'string' &&
        typeof (m as Message).text === 'string' &&
        typeof (m as Message).ts === 'number',
      )
      .map(m => ({
        id: m.id,
        role: m.role,
        // Migrate: any assistant message persisted as a raw envelope
        // gets unwrapped to clean human text on load.
        text: m.role === 'sunny' ? unwrapPersistedText(m.text) : m.text,
        ts: m.ts,
      }));
  } catch {
    return [];
  }
}

export function saveHistory(messages: readonly Message[]): void {
  try {
    const trimmed = messages
      .slice(-MAX_HISTORY)
      .map(({ id, role, text, ts }) => ({ id, role, text, ts }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.error('ChatPanel: failed to persist history', error);
  }
}
