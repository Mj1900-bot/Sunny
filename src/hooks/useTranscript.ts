/**
 * useTranscript — a persistent, scrollable conversation log source of truth
 * for the sprint-13 θ TRANSCRIPT section inside `<ChatPanel />`.
 *
 * Why a dedicated hook rather than reading `ChatPanel.messages` directly?
 * The transcript has three demands that the live messages list doesn't:
 *
 *   1. Survives reload — hydrates from `memory::conversation::tail` on
 *      mount so the user returning to the app after a restart still sees
 *      yesterday's dialogue without needing to resume via SessionPicker.
 *   2. Channel-agnostic — the user doesn't care whether a turn came in via
 *      typed chat or voice. We prefer a single merge surface.
 *   3. Capped + deduped — the log is bounded at `MAX_ROWS` with FIFO drop
 *      of the oldest turn so rendering stays O(rows) and screen-reader
 *      announcements don't replay old content on every mount.
 *
 * This hook is intentionally decoupled from any Rust-side write path. Our
 * contract with `memory::conversation` is READ-ONLY (`tail`), reusing the
 * existing store per the brief's "Prefer reuse over a new store" rule.
 * Fresh turns are merged in from the parent's `liveMessages` prop — which
 * in practice comes from ChatPanel's already-battle-tested `messages`
 * state (unified voice + typed by its own subscribers).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { invokeSafe } from '../lib/tauri';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TranscriptRole = 'user' | 'sunny' | 'system';

/**
 * A single row rendered inside the TRANSCRIPT log. The `key` is stable
 * across renders so React's reconciler keeps the DOM warm — important for
 * the aria-live announcer, which resets its observed region when the last
 * child node is replaced wholesale.
 */
export type TranscriptRow = {
  readonly key: string;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly at: number;
};

/** Shape of a live message this hook accepts from the parent. Deliberately
 * a subset of ChatPanel's internal `Message` so the two types don't couple
 * on `streaming` / `id` or anything else transient. */
export type LiveMessage = {
  readonly role: TranscriptRole;
  readonly text: string;
  readonly ts: number;
};

/** Mirror of `memory::conversation::Turn`. Narrow type — we only read it. */
type Turn = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  at: number;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max rows rendered. Matches the brief ("shows the last 50 turns"). */
export const MAX_ROWS = 50;

/** How many turns we ask the backend for on warm replay. We request a
 *  superset of MAX_ROWS so that dedupe dropping a couple of rows against
 *  live messages still leaves us with a full log on mount. */
const WARM_REPLAY_LIMIT = MAX_ROWS + 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a persisted `Turn` role to the transcript's local role enum.
 * Assistant → "sunny" (matches the user-visible speaker label), user stays
 * "user", tool rows are surfaced as "system" notices so the reader sees
 * that something happened without us fabricating an SUNNY voice for it.
 */
function turnRoleToTranscript(role: Turn['role']): TranscriptRole {
  if (role === 'assistant') return 'sunny';
  if (role === 'tool') return 'system';
  return 'user';
}

/**
 * Derive a stable key for a row so dedupe + React keys agree. The combo
 * of `(at, role, first-64-chars)` is unique enough across all realistic
 * histories — two turns with identical text AND identical millisecond
 * timestamps AND the same role is vanishingly rare and if it does happen
 * the user sees a single bubble, which is the right degenerate outcome.
 */
function rowKey(role: TranscriptRole, text: string, at: number): string {
  const prefix = text.length > 64 ? text.slice(0, 64) : text;
  return `${at}|${role}|${prefix}`;
}

/**
 * Merge two sorted-by-`at` row streams into one dedup'd list capped at
 * MAX_ROWS. We always return a NEW array (immutability rule) — callers
 * may rely on referential inequality to trigger re-render.
 */
function mergeRows(
  warm: readonly TranscriptRow[],
  live: readonly TranscriptRow[],
): readonly TranscriptRow[] {
  if (warm.length === 0 && live.length === 0) return [];
  const seen = new Set<string>();
  const merged: TranscriptRow[] = [];
  // Live turns are authoritative when keys collide — the user's active
  // session state is the source of truth for in-flight turns, and warm
  // replay can lag behind by a write (the agent_loop append commits AFTER
  // the chunk event). Walk live first, then backfill warm.
  for (const row of live) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    merged.push(row);
  }
  for (const row of warm) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    merged.push(row);
  }
  // Oldest-first presentation (natural reading order). Stable sort in V8
  // keeps equal-`at` rows in live-before-warm order.
  merged.sort((a, b) => a.at - b.at);
  // FIFO drop of oldest when over cap.
  return merged.length > MAX_ROWS ? merged.slice(-MAX_ROWS) : merged;
}

/**
 * Adapt the parent's live messages into TranscriptRow shape. Filters out
 * empty-text placeholder bubbles (ChatPanel seeds an empty SUNNY bubble
 * when a turn starts so the streaming text can accumulate — we don't want
 * that transient blank row polluting the transcript).
 */
function liveToRows(messages: readonly LiveMessage[]): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const m of messages) {
    const text = typeof m.text === 'string' ? m.text : '';
    if (text.length === 0) continue;
    const role = m.role;
    rows.push({
      key: rowKey(role, text, m.ts),
      role,
      text,
      at: m.ts,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseTranscriptResult {
  /** Rows, oldest-first, capped at MAX_ROWS. Ready to render. */
  readonly rows: readonly TranscriptRow[];
  /** Text of the most recent SUNNY row, or empty string. Used for the
   *  aria-live polite announcer so screen readers read the answer
   *  without the user focusing the log. */
  readonly latestSunnyText: string;
  /** True while the initial `conversation_tail` probe is in flight. */
  readonly hydrating: boolean;
  /** Count of rows currently visible — convenience for the section header. */
  readonly rowCount: number;
}

/**
 * Subscribe to the transcript for a given session.
 *
 * @param sessionId  openclaw session id whose persisted tail we warm-replay
 *                   on mount. Changing this value triggers a re-probe (the
 *                   user resumed a different thread via SessionPicker).
 * @param liveMessages  the parent's live list (typically `ChatPanel.messages`).
 *                   Passed as-is; the hook adapts + merges internally.
 */
export function useTranscript(
  sessionId: string,
  liveMessages: readonly LiveMessage[],
): UseTranscriptResult {
  // We track "warm replay state" per-session via a single state object so
  // a session switch doesn't require two synchronous setState calls inside
  // the effect body (which the react-hooks/set-state-in-effect lint rule
  // rightly flags as a cascading-render smell). The object is replaced
  // atomically by the async probe completion OR by the sync session-switch
  // path below.
  type WarmState = {
    readonly sessionId: string;
    readonly rows: readonly TranscriptRow[];
    readonly hydrating: boolean;
  };
  const [warmState, setWarmState] = useState<WarmState>(() => ({
    sessionId,
    rows: [],
    hydrating: true,
  }));

  // If `sessionId` changed without the effect having run yet (e.g. the
  // user resumed a different thread between renders), we reset the warm
  // state synchronously during render. React allows a single in-render
  // setState to a different store when guarded by an equality check —
  // this is the canonical pattern for "derive state from props". See
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (warmState.sessionId !== sessionId) {
    setWarmState({ sessionId, rows: [], hydrating: true });
  }

  const warm = warmState.rows;
  const hydrating = warmState.hydrating;

  // Guard against stale probe responses landing after a session switch.
  // Incrementing this on every effect run lets the inner async closure
  // compare on return and no-op if the user has since moved on.
  const probeTokenRef = useRef<number>(0);

  useEffect(() => {
    const token = probeTokenRef.current + 1;
    probeTokenRef.current = token;

    let cancelled = false;

    (async () => {
      try {
        const tail = await invokeSafe<Turn[]>('conversation_tail', {
          sessionId,
          limit: WARM_REPLAY_LIMIT,
        });
        if (cancelled) return;
        if (probeTokenRef.current !== token) return;
        if (!Array.isArray(tail)) {
          setWarmState({ sessionId, rows: [], hydrating: false });
          return;
        }
        const rows: TranscriptRow[] = [];
        for (const t of tail) {
          if (!t || typeof t !== 'object') continue;
          if (typeof t.role !== 'string' || typeof t.content !== 'string') continue;
          const at = typeof t.at === 'number' ? t.at : Date.now();
          const role = turnRoleToTranscript(t.role);
          const text = t.content;
          if (text.length === 0) continue;
          rows.push({ key: rowKey(role, text, at), role, text, at });
        }
        setWarmState({ sessionId, rows, hydrating: false });
      } catch (error) {
        // invokeSafe already catches backend errors, but catch synchronous
        // throws too so an unexpected bug can't leave `hydrating` stuck.
        console.error('useTranscript: warm replay failed', error);
        if (!cancelled && probeTokenRef.current === token) {
          setWarmState({ sessionId, rows: [], hydrating: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Combine warm + live on every live change. `useMemo` rather than state so
  // we never carry a stale merged copy after the parent mutates
  // `liveMessages` — referential equality with the previous merge isn't
  // guaranteed, which is fine: React diffs the rendered rows by `row.key`.
  const rows = useMemo(() => {
    const live = liveToRows(liveMessages);
    return mergeRows(warm, live);
  }, [warm, liveMessages]);

  const latestSunnyText = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].role === 'sunny') return rows[i].text;
    }
    return '';
  }, [rows]);

  return {
    rows,
    latestSunnyText,
    hydrating,
    rowCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Internals exposed for unit tests. Not part of the public API.
// ---------------------------------------------------------------------------

export const __testing = {
  mergeRows,
  liveToRows,
  turnRoleToTranscript,
  rowKey,
  MAX_ROWS,
};
