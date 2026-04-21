import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { invokeSafe } from '../lib/tauri';

// Shape returned by the (future) `conversation_list_sessions` Tauri command.
// See docstring at the bottom of this file for the proposed command signature.
// Until the backend lands, `invokeSafe` returns null and the picker quietly
// hides itself — no hard error, no UI jank.
export type SessionSummary = {
  session_id: string;
  /** Unix millis of the most recent turn in the session. */
  last_at: number;
  /** First-turn text (truncated by the backend). Empty string is allowed. */
  preview: string;
  /** Total turns persisted under this session_id. Optional for forward-compat. */
  turn_count?: number;
};

type Props = {
  /** Session id currently driving the chat. Highlighted in the dropdown. */
  currentSessionId: string;
  /** Resume an existing session — set sessionId + hydrate tail on parent side. */
  onResume: (sessionId: string) => void;
  /** Explicitly rotate to a fresh session. */
  onNewChat: () => void;
};

const MAX_SESSIONS = 10;
const PREVIEW_CHARS = 60;

/**
 * Safely ask the backend for a list of recent chat sessions. If the command
 * isn't registered yet, `invokeSafe` returns null and we treat that as
 * "picker unavailable" — callers render a simplified UI (NEW only, no list).
 */
async function loadSessions(): Promise<readonly SessionSummary[] | null> {
  const raw = await invokeSafe<SessionSummary[]>(
    'conversation_list_sessions',
    { limit: MAX_SESSIONS },
  );
  if (!Array.isArray(raw)) return null;
  // Defensive shape check — mirrors ChatPanel's `conversation_tail` guard.
  // Tolerate `turn_count` being absent (older builds might not surface it).
  const valid = raw.filter(
    (s): s is SessionSummary =>
      !!s &&
      typeof s === 'object' &&
      typeof (s as SessionSummary).session_id === 'string' &&
      typeof (s as SessionSummary).last_at === 'number' &&
      typeof (s as SessionSummary).preview === 'string',
  );
  return valid.slice(0, MAX_SESSIONS);
}

/** Relative-time label. Kept local to avoid pulling in a date library. */
function formatRelative(now: number, then: number): string {
  const delta = Math.max(0, now - then);
  const secs = Math.floor(delta / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= n) return clean;
  return `${clean.slice(0, n - 1)}…`;
}

export function SessionPicker({ currentSessionId, onResume, onNewChat }: Props): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<readonly SessionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  // `supported === false` when the Tauri command is missing — in that case we
  // hide the HISTORY button entirely (per brief: "gracefully hide the picker
  // (no hard error)"). NEW is still offered because it's pure frontend.
  const [supported, setSupported] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const list = await loadSessions();
      if (list === null) {
        setSupported(false);
        setSessions(null);
        return;
      }
      setSupported(true);
      setSessions(list);
    } catch (error) {
      // Belt-and-braces — `invokeSafe` already swallows invoke failures, so
      // this only catches synchronous throws from the shape filter above.
      console.error('SessionPicker: loadSessions failed', error);
      setSupported(false);
      setSessions(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // One-shot probe on mount. We don't subscribe to session changes — the list
  // is refreshed the next time the user opens the dropdown, which is when they
  // would notice staleness anyway.
  useEffect(() => { void refresh(); }, [refresh]);

  // Close on outside click so the dropdown behaves like a normal menu.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggleOpen = useCallback(() => {
    setOpen(prev => {
      const next = !prev;
      // Refresh on every open — cheap invoke, guarantees the list is current
      // the moment the user looks at it.
      if (next) void refresh();
      return next;
    });
  }, [refresh]);

  const handlePick = useCallback(
    (sid: string) => {
      setOpen(false);
      if (sid === currentSessionId) return;
      onResume(sid);
    },
    [currentSessionId, onResume],
  );

  const handleNew = useCallback(() => {
    setOpen(false);
    onNewChat();
  }, [onNewChat]);

  const now = useMemo(() => Date.now(), [sessions, open]);

  // Subtle amber-on-black styling matching CLEAR / SEND in ChatPanel.
  const wrapperStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
  };

  const btnStyle: CSSProperties = {
    all: 'unset',
    cursor: 'pointer',
    fontFamily: 'var(--display)',
    fontSize: 9,
    letterSpacing: '0.22em',
    color: 'var(--ink-2)',
    padding: '2px 6px',
    border: '1px solid var(--line-soft)',
    background: 'rgba(57, 229, 255, 0.04)',
  };

  const dropdownStyle: CSSProperties = {
    position: 'absolute',
    bottom: 'calc(100% + 4px)',
    left: 0,
    zIndex: 20,
    minWidth: 280,
    maxWidth: 360,
    maxHeight: 320,
    overflowY: 'auto',
    background: 'var(--bg, #0a0d10)',
    border: '1px solid var(--line-soft)',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.6)',
    padding: 4,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  };

  const itemBase: CSSProperties = {
    all: 'unset',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '6px 8px',
    borderLeft: '2px solid transparent',
  };

  const headerStyle: CSSProperties = {
    fontFamily: 'var(--display)',
    fontSize: 9,
    letterSpacing: '0.22em',
    color: 'var(--ink-dim)',
    padding: '4px 8px 6px',
    borderBottom: '1px solid var(--line-soft)',
    marginBottom: 2,
  };

  // When the backend command isn't present, still offer a NEW button — it's
  // pure frontend and genuinely useful on its own.
  const showHistory = supported !== false;
  // While the probe is in-flight we don't know yet; render a placeholder so
  // layout doesn't jump when the button appears.
  if (supported === null) {
    return (
      <span style={wrapperStyle}>
        <button
          type="button"
          style={{ ...btnStyle, opacity: 0.4, cursor: 'default' }}
          disabled
          aria-label="Loading session picker"
        >
          …
        </button>
      </span>
    );
  }

  return (
    <div ref={rootRef} style={wrapperStyle}>
      {showHistory ? (
        <button
          type="button"
          onClick={toggleOpen}
          style={btnStyle}
          title="Browse past conversations"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          HISTORY
        </button>
      ) : null}
      <button
        type="button"
        onClick={handleNew}
        style={btnStyle}
        title="Start a new conversation"
      >
        NEW
      </button>

      {open && showHistory ? (
        <div style={dropdownStyle} role="listbox" aria-label="Recent conversations">
          <div style={headerStyle}>
            RECENT · {sessions?.length ?? 0}
          </div>
          {loading && !sessions ? (
            <div
              style={{
                padding: '8px 10px',
                fontFamily: 'var(--label)',
                fontSize: 12,
                color: 'var(--ink-dim)',
              }}
            >
              Loading…
            </div>
          ) : !sessions || sessions.length === 0 ? (
            <div
              style={{
                padding: '8px 10px',
                fontFamily: 'var(--label)',
                fontSize: 12,
                color: 'var(--ink-dim)',
              }}
            >
              No previous conversations.
            </div>
          ) : (
            sessions.map(s => {
              const isCurrent = s.session_id === currentSessionId;
              const itemStyle: CSSProperties = {
                ...itemBase,
                borderLeftColor: isCurrent ? 'var(--cyan)' : 'transparent',
                background: isCurrent
                  ? 'rgba(57, 229, 255, 0.06)'
                  : 'transparent',
              };
              return (
                <button
                  key={s.session_id}
                  type="button"
                  onClick={() => handlePick(s.session_id)}
                  style={itemStyle}
                  role="option"
                  aria-selected={isCurrent}
                  title={s.session_id}
                >
                  <span
                    style={{
                      fontFamily: 'var(--label)',
                      fontSize: 12,
                      color: 'var(--ink)',
                      lineHeight: 1.35,
                      wordBreak: 'break-word',
                    }}
                  >
                    {s.preview.length > 0
                      ? truncate(s.preview, PREVIEW_CHARS)
                      : '(empty)'}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--ink-dim)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {formatRelative(now, s.last_at)}
                    {typeof s.turn_count === 'number'
                      ? ` · ${s.turn_count} turn${s.turn_count === 1 ? '' : 's'}`
                      : ''}
                    {isCurrent ? ' · current' : ''}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Proposed Tauri command signature (for a later sprint — NOT added here):
 *
 * ```rust
 * /// List the `limit` most recently active sessions, each with a short
 * /// preview taken from the first user turn (or earliest turn overall).
 * /// Returns [] when no conversation history exists yet.
 * #[tauri::command]
 * pub async fn conversation_list_sessions(
 *     limit: u32,
 * ) -> Result<Vec<SessionSummary>, String> { ... }
 *
 * #[derive(serde::Serialize)]
 * pub struct SessionSummary {
 *     pub session_id: String,
 *     /// Unix millis of the latest turn in the session.
 *     pub last_at: i64,
 *     /// Truncated first-turn content (backend clamps to ~120 chars).
 *     pub preview: String,
 *     /// Optional: total turn count under this session_id.
 *     pub turn_count: u32,
 * }
 * ```
 *
 * Implementation note: a single SQL query grouped by `session_id`, ordered
 * by `MAX(at) DESC`, with a correlated subquery for the earliest turn's
 * content — cheap on SQLite with `(session_id, at)` indexed, which the
 * Sprint-7 D schema already provides.
 */
