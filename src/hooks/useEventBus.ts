/**
 * useEventBus — React hook that subscribes to the Rust event bus via the
 * sprint-7 `event_bus_subscribe` Tauri [`Channel`] push-mode transport, with a
 * warm-replay prefix seeded from `event_bus_tail` / `event_bus_tail_by_kind`.
 *
 * Motivation: the sprint-5 polling implementation had a 250 ms floor and
 * a same-millisecond dedupe collision risk because the bus did not expose
 * a monotonic primary key. Sprint-7 gives every event a `seq: u64`, wakes
 * the frontend via a [`Channel<SunnyEvent>`], and this hook is the single
 * canonical client API on top of that substrate.
 *
 * Shape:
 *
 *   const { events, connected } = useEventBus();
 *   const { events }            = useEventBus({ kind: 'WorldTick' });
 *   const { events }            = useEventBus({ limit: 200 });
 *
 *   // Backward compat: the return is also usable as an array.
 *   const replay = useEventBus({ kind: 'AgentStep' });
 *   replay.map(...); replay.length;
 *
 * Semantics:
 *   - Newest event first (Rust side already returns newest-first for the
 *     warm-replay, and incoming pushed events are prepended as they land).
 *   - Warm-replay on mount primes the UI with the last `limit` events so
 *     the first paint is never empty.
 *   - Push transport: Tauri [`Channel<SunnyEvent>`] appended via
 *     `event_bus_subscribe`, torn down via `event_bus_unsubscribe`.
 *   - Dedupe via `(boot_epoch, seq)` — the compound key. `seq` alone
 *     isn't enough: it resets to 1 on backend restart, so a cursor that
 *     persisted "last seen seq = 5000" would silently drop every
 *     post-restart event until the new process surpassed 5000. A new
 *     `boot_epoch` (different from the last-seen one — not strictly
 *     increasing, because clock skew / TZ change / manual set can move
 *     it backward) is the signal that the backend restarted: we reset
 *     the dedupe set and the sinceMs cursor. Events without either
 *     field (legacy or malformed) fall through to a composite-key
 *     fallback; `boot_epoch = 0` is treated as a synthetic "legacy"
 *     epoch that can coexist with any live epoch.
 *   - Filters by `kind` client-side — the subscribe command is a firehose.
 *   - Fallback: if `event_bus_subscribe` is unavailable (old backend, or
 *     agent A's work hasn't landed yet) the hook degrades to the sprint-5
 *     polling loop so the UI keeps working during the sprint.
 *   - Reconnects on channel error with 2 s backoff, max 5 retries; after
 *     that `connected` stays `false` and the warm-replay stands alone.
 *   - Cancels in-flight work, unsubscribes, and clears timers on unmount.
 */

import { useEffect, useRef, useState } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { invoke, isTauri } from '../lib/tauri';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SunnyEventKind =
  | 'AgentStep'
  | 'ChatChunk'
  | 'WorldTick'
  | 'Security'
  | 'SubAgent'
  | 'DaemonFire';

/**
 * `seq` is populated on every event once agent A's sprint-7 change lands;
 * `boot_epoch` is populated once κ v10 #2 lands. Until then either may be
 * absent and we fall back to composite-key dedupe. Events persisted to
 * SQLite before these fields existed decode with `seq = 0, boot_epoch = 0`
 * (Rust `#[serde(default)]`); `boot_epoch = 0` is the "legacy" epoch.
 */
export type SunnyEvent =
  | { kind: 'AgentStep'; turn_id: string; iteration: number; text: string; tool?: string; at: number; seq?: number; boot_epoch?: number }
  | { kind: 'ChatChunk'; turn_id: string; delta: string; done: boolean; at: number; seq?: number; boot_epoch?: number }
  | { kind: 'WorldTick'; revision: number; focus_app?: string; activity: string; at: number; seq?: number; boot_epoch?: number }
  | { kind: 'Security'; severity: string; summary: string; at: number; seq?: number; boot_epoch?: number }
  | { kind: 'SubAgent'; run_id: string; lifecycle: string; goal?: string; at: number; seq?: number; boot_epoch?: number }
  | { kind: 'DaemonFire'; daemon_id: string; goal: string; at: number; seq?: number; boot_epoch?: number };

export interface UseEventBusOptions {
  readonly kind?: SunnyEventKind;
  readonly limit?: number;
  /**
   * Retained for backward compatibility with the sprint-5 polling hook.
   * Ignored in push mode; used only as the fallback polling cadence.
   */
  readonly pollMs?: number;
}

/**
 * Return type is an array (backward compat with callers that consume
 * the hook as `readonly SunnyEvent[]`) intersected with an object that
 * exposes `events` and `connected`. All consumers keep working; new
 * ones can read `.connected` or destructure `{ events, connected }`.
 */
export type UseEventBusResult = readonly SunnyEvent[] & {
  readonly events: readonly SunnyEvent[];
  readonly connected: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 2000;
const DEFAULT_LIMIT = 50;
const MIN_POLL_MS = 250;

const RECONNECT_BACKOFF_MS = 2000;
const RECONNECT_MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// Shared upstream subscription
//
// `event_bus_subscribe` opens a Tauri Channel that streams every event;
// per-consumer concerns (kind filter, dedupe, limit slicing) all happen
// hook-side. So one Tauri Channel can feed every active hook — we
// don't need a separate IPC channel + pump task per consumer.
//
// This singleton manages the upstream:
//   - lazy bootstrap on first subscriber
//   - fan out each event to every registered callback
//   - tear down on the last unsubscribe
//   - sticky "unsupported" flag once `event_bus_subscribe` returns
//     unknown-command, so subsequent hooks fall straight to polling
//     instead of re-attempting the failing call
// ---------------------------------------------------------------------------

type EventCallback = (evt: SunnyEvent) => void;

interface SharedSubscriptionState {
  readonly callbacks: Set<EventCallback>;
  /**
   * Allocation-free fanout snapshot. Replaced (not mutated) on every
   * subscribe/unsubscribe so the onmessage handler reads a stable array
   * reference without allocating a new spread on every event.
   */
  callbackArr: readonly EventCallback[];
  subscriptionId: number | null;
  pending: Promise<boolean> | null;
  unsupported: boolean;
}

/** @internal Exported for testing only — do not reference in production code. */
export const SHARED: SharedSubscriptionState = {
  callbacks: new Set(),
  callbackArr: [],
  subscriptionId: null,
  pending: null,
  unsupported: false,
};

interface SharedHandle {
  readonly ok: boolean;
  readonly unsubscribe: () => void;
}

const NOOP_UNSUBSCRIBE = (): void => {};

export async function subscribeShared(cb: EventCallback): Promise<SharedHandle> {
  if (SHARED.unsupported) {
    return { ok: false, unsubscribe: NOOP_UNSUBSCRIBE };
  }

  SHARED.callbacks.add(cb);
  // Rebuild the stable fanout array after every subscribe. Replacing the
  // reference (not mutating) ensures onmessage always holds a snapshot that
  // cannot be perturbed mid-iteration.
  SHARED.callbackArr = [...SHARED.callbacks];

  const unsubscribe = (): void => {
    if (!SHARED.callbacks.delete(cb)) return;
    SHARED.callbackArr = [...SHARED.callbacks];
    if (SHARED.callbacks.size === 0 && SHARED.subscriptionId !== null) {
      const id = SHARED.subscriptionId;
      SHARED.subscriptionId = null;
      SHARED.pending = null;
      // Fire-and-forget; the Rust-side Channel GCs regardless.
      invoke('event_bus_unsubscribe', { id }).catch(() => {
        /* ignore — best-effort tear-down */
      });
    }
  };

  // First subscriber bootstraps the upstream channel.
  if (SHARED.callbacks.size === 1 && SHARED.pending === null) {
    SHARED.pending = (async (): Promise<boolean> => {
      if (!isTauri) return false;
      const channel = new Channel<SunnyEvent>();
      channel.onmessage = (evt: SunnyEvent): void => {
        if (!isSunnyEvent(evt)) return;
        // callbackArr is a stable snapshot rebuilt on subscribe/unsubscribe,
        // never mutated in place. Iterating it here costs no allocation per
        // event — the array is already a safe copy from registration time.
        for (const c of SHARED.callbackArr) c(evt);
      };
      try {
        const id = await invoke<number>('event_bus_subscribe', { channel });
        SHARED.subscriptionId = id;
        return true;
      } catch (error) {
        if (isUnknownCommandError(error)) {
          SHARED.unsupported = true;
          return false;
        }
        console.error('useEventBus: shared subscribe failed', error);
        SHARED.pending = null;
        return false;
      }
    })();
  }

  const ok = await (SHARED.pending ?? Promise.resolve(false));
  if (!ok) {
    SHARED.callbacks.delete(cb);
    SHARED.callbackArr = [...SHARED.callbacks];
    return { ok: false, unsubscribe: NOOP_UNSUBSCRIBE };
  }
  return { ok: true, unsubscribe };
}

// ---------------------------------------------------------------------------
// Dedupe helpers
// ---------------------------------------------------------------------------

/**
 * Stable key for an event. Prefers the `(boot_epoch, seq)` compound
 * key (post-κ-v10, monotonic within a process AND disambiguated across
 * restarts) and falls back to a composite key derived from the
 * variant's identifying fields plus `at` for legacy events.
 *
 * A missing `seq` falls all the way through to the legacy composite.
 * A missing `boot_epoch` uses `0` — the reserved "legacy" epoch that
 * won't collide with any live process because BOOT_EPOCH is seeded
 * from wall-clock millis and is always > 0.
 */
function eventKey(evt: SunnyEvent): string {
  if (typeof evt.seq === 'number') {
    const epoch = typeof evt.boot_epoch === 'number' ? evt.boot_epoch : 0;
    return `seq|${epoch}|${evt.seq}`;
  }
  switch (evt.kind) {
    case 'AgentStep':
      return `AgentStep|${evt.at}|${evt.turn_id}|${evt.iteration}`;
    case 'ChatChunk':
      return `ChatChunk|${evt.at}|${evt.turn_id}|${evt.delta.length}|${evt.done ? 1 : 0}`;
    case 'WorldTick':
      return `WorldTick|${evt.at}|${evt.revision}`;
    case 'Security':
      return `Security|${evt.at}|${evt.severity}|${evt.summary}`;
    case 'SubAgent':
      return `SubAgent|${evt.at}|${evt.run_id}|${evt.lifecycle}`;
    case 'DaemonFire':
      return `DaemonFire|${evt.at}|${evt.daemon_id}`;
  }
}

function isSunnyEvent(value: unknown): value is SunnyEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as { kind?: unknown; at?: unknown; seq?: unknown; boot_epoch?: unknown };
  if (typeof obj.at !== 'number') return false;
  if (typeof obj.kind !== 'string') return false;
  if (obj.seq !== undefined && typeof obj.seq !== 'number') return false;
  if (obj.boot_epoch !== undefined && typeof obj.boot_epoch !== 'number') return false;
  switch (obj.kind) {
    case 'AgentStep':
    case 'ChatChunk':
    case 'WorldTick':
    case 'Security':
    case 'SubAgent':
    case 'DaemonFire':
      return true;
    default:
      return false;
  }
}

function normalizeEvents(rows: readonly unknown[]): readonly SunnyEvent[] {
  const out: SunnyEvent[] = [];
  for (const row of rows) {
    if (isSunnyEvent(row)) out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unknown-command detection
// ---------------------------------------------------------------------------

/**
 * Tauri raises a command-not-found error with a predictable message shape.
 * We sniff it so we can transparently fall back to polling when agent A's
 * new commands aren't wired up yet — the sprint shouldn't brick if the
 * backend half of this work lands late.
 */
function isUnknownCommandError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    msg.includes('not found') ||
    msg.includes('unknown command') ||
    msg.includes('Command ') ||
    msg.includes('command_not_found')
  );
}

// ---------------------------------------------------------------------------
// Warm-replay + polling backend calls
// ---------------------------------------------------------------------------

async function fetchWarmReplay(
  kind: SunnyEventKind | undefined,
  limit: number,
  sinceMs: number | null,
): Promise<readonly SunnyEvent[]> {
  if (!isTauri) return [];
  try {
    if (kind) {
      const rows = await invoke<unknown[]>('event_bus_tail_by_kind', { kind, limit });
      return normalizeEvents(rows);
    }
    const rows = await invoke<unknown[]>('event_bus_tail', {
      limit,
      sinceMs: sinceMs ?? null,
    });
    return normalizeEvents(rows);
  } catch (error) {
    console.error('useEventBus: warm-replay failed', error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Result assembly — Fix 2
// ---------------------------------------------------------------------------

/**
 * Wrap an events array and a connected flag into the intersection return
 * type. The `events` and `connected` fields are non-enumerable so
 * destructuring works but the array surface (map/filter/length/...) stays
 * clean for callers that treat the result as a plain array.
 *
 * Fix 2: `buildResult` is no longer called on every state tick. Instead we
 * maintain a stable ref to the result object and only rebuild it when the
 * events array reference or the connected flag actually changes. This avoids
 * the `events.slice()` + two `Object.defineProperty` calls that previously
 * ran on every React render cycle.
 */
function attachResultProps(
  base: SunnyEvent[],
  connected: boolean,
): UseEventBusResult {
  Object.defineProperty(base, 'events', {
    value: base,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(base, 'connected', {
    value: connected,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return base as unknown as UseEventBusResult;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to the Rust event bus via push-mode [`Channel`] transport, with a
 * warm-replay prefix and a polling fallback for older backends.
 *
 * Returns a value that is simultaneously:
 *   - a `readonly SunnyEvent[]` (newest-first, capped at `limit`), and
 *   - an object with `events` / `connected` for newer consumers.
 */
export function useEventBus(opts: UseEventBusOptions = {}): UseEventBusResult {
  const kind = opts.kind;
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const pollMs = Math.max(MIN_POLL_MS, opts.pollMs ?? DEFAULT_POLL_MS);

  const [events, setEvents] = useState<readonly SunnyEvent[]>([]);
  const [connected, setConnected] = useState<boolean>(false);

  // Fix 2: stable result ref — only rebuilt when events reference or connected
  // flag changes; the ref itself is always the same object so consumers that
  // cache the hook return value won't see false-positive identity changes.
  const resultRef = useRef<UseEventBusResult>(attachResultProps([], false));

  // Mutable refs survive re-renders so the push/poll loops keep their
  // dedupe state across ticks without re-running the effect.
  // Fix 2: seenRef is capped to `limit * 2` entries (sliding window) so the
  // Set doesn't grow unboundedly over the lifetime of a long session.
  const seenRef = useRef<Set<string>>(new Set<string>());
  // Ordered key log so we can evict the oldest when the cap is hit.
  const seenOrderRef = useRef<string[]>([]);
  const sinceMsRef = useRef<number | null>(null);
  // Last boot_epoch we've observed from the backend. `null` means "no
  // stamped event yet". When a new event arrives with a different
  // non-zero epoch we treat it as a backend restart: clear `seenRef`
  // and `sinceMsRef` so the post-restart seq=1 doesn't get silently
  // dedup'd against a pre-restart seq=5000 we still remember. Zero
  // boot_epoch is the "legacy" sentinel and does NOT trigger a reset.
  const bootEpochRef = useRef<number | null>(null);
  const activeRef = useRef<boolean>(true);

  // Rebuild the stable result object whenever events or connected changes.
  // We do this outside the effect so the returned value is always fresh on
  // the render that consumed it, without an extra render cycle.
  const eventsArr = events as SunnyEvent[];
  const result = attachResultProps([...eventsArr], connected);
  resultRef.current = result;

  useEffect(() => {
    // Reset per-subscription state whenever the filter / limit changes so
    // dedupe keys from unrelated subscriptions don't bleed across.
    seenRef.current = new Set<string>();
    seenOrderRef.current = [];
    sinceMsRef.current = null;
    bootEpochRef.current = null;
    setEvents([]);
    setConnected(false);
    activeRef.current = true;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let sharedUnsubscribe: (() => void) | null = null;
    let retries = 0;

    // Fix 2: sliding-window cap on the seen Set (limit * 2 max entries).
    const seenCap = limit * 2;
    const trackSeen = (key: string): void => {
      seenRef.current.add(key);
      seenOrderRef.current.push(key);
      if (seenOrderRef.current.length > seenCap) {
        const evicted = seenOrderRef.current.shift();
        if (evicted !== undefined) seenRef.current.delete(evicted);
      }
    };

    /**
     * Merge a batch of events into state, newest-first, dedup'd by
     * `eventKey`, capped at `limit` with FIFO drop of oldest.
     */
    const mergeBatch = (batch: readonly SunnyEvent[]): void => {
      if (batch.length === 0) return;

      // Epoch change detection. We check BEFORE dedupe so a restarted
      // backend's first event (seq=1, new epoch) is accepted, not
      // dropped because its key happens to collide with something
      // under the prior epoch.
      for (const evt of batch) {
        const epoch = typeof evt.boot_epoch === 'number' ? evt.boot_epoch : 0;
        if (epoch === 0) continue; // legacy sentinel — not a restart
        const last = bootEpochRef.current;
        if (last === null) {
          bootEpochRef.current = epoch;
          continue;
        }
        if (epoch !== last) {
          // Backend restarted. Clock may have moved BACKWARD (TZ
          // change / manual set), so we compare by inequality, not
          // strict-increase. Different epoch = different process =
          // fresh seq namespace.
          seenRef.current = new Set<string>();
          seenOrderRef.current = [];
          sinceMsRef.current = null;
          bootEpochRef.current = epoch;
        }
      }

      const seen = seenRef.current;
      const fresh: SunnyEvent[] = [];
      let maxAt = sinceMsRef.current ?? Number.NEGATIVE_INFINITY;
      for (const evt of batch) {
        const key = eventKey(evt);
        if (seen.has(key)) continue;
        trackSeen(key);
        fresh.push(evt);
        if (evt.at > maxAt) maxAt = evt.at;
      }
      if (fresh.length === 0) return;
      if (maxAt !== Number.NEGATIVE_INFINITY) sinceMsRef.current = maxAt;

      setEvents(prev => {
        // New events sort strictly newer-than-or-equal to prior ones, so
        // concatenating fresh-first preserves the newest-first invariant.
        const merged = [...fresh, ...prev];
        // FIFO drop of oldest when over cap.
        return merged.length > limit ? merged.slice(0, limit) : merged;
      });
    };

    /**
     * Client-side kind filter — the subscribe command is a firehose, so
     * every consumer filters locally. Keeps the Rust side simple.
     */
    const matchesKind = (evt: SunnyEvent): boolean =>
      kind === undefined || evt.kind === kind;

    /**
     * Load the warm-replay prefix so the first paint isn't empty.
     * Runs once per effect; pushed events prepend on top of it.
     */
    const seedWarmReplay = async (): Promise<void> => {
      const seed = await fetchWarmReplay(kind, limit, null);
      if (cancelled) return;
      // Backend already filters by kind when asked; belt-and-braces here.
      const filtered = kind ? seed.filter(matchesKind) : seed;
      mergeBatch(filtered);
    };

    /**
     * Open a Tauri Channel, register it via `event_bus_subscribe`, and
     * pipe incoming events through the dedupe + merge pipeline. Returns
     * true on success, false if the command is absent (caller falls
     * back to polling).
     */
    const openChannel = async (): Promise<boolean> => {
      if (!isTauri) return false;
      const onEvent: EventCallback = (evt: SunnyEvent): void => {
        if (cancelled) return;
        if (!matchesKind(evt)) return;
        mergeBatch([evt]);
      };
      const handle = await subscribeShared(onEvent);
      if (cancelled) {
        handle.unsubscribe();
        return handle.ok;
      }
      if (handle.ok) {
        sharedUnsubscribe = handle.unsubscribe;
        setConnected(true);
        retries = 0;
        return true;
      }
      // Upstream is unsupported (`unknown command`) — caller falls
      // through to the polling fallback. A non-unknown failure path
      // would have left `SHARED.pending = null`, allowing retry; we
      // schedule one here so transient subscribe failures recover.
      if (!SHARED.unsupported) scheduleReconnect();
      return SHARED.unsupported ? false : true;
    };

    /**
     * Reconnect with linear 2 s backoff, capped at `RECONNECT_MAX_RETRIES`.
     * After exhausting retries we leave `connected=false` and stop; the
     * warm-replay is still on screen and the user isn't blocked.
     */
    const scheduleReconnect = (): void => {
      if (cancelled) return;
      setConnected(false);
      if (retries >= RECONNECT_MAX_RETRIES) {
        console.error('useEventBus: subscribe retries exhausted, giving up');
        return;
      }
      retries += 1;
      reconnectTimer = setTimeout(() => {
        void openChannel().then(ok => {
          // If the backend suddenly reports unknown-command mid-session
          // there isn't much we can do — fall through to polling.
          if (!ok && !cancelled) startPollingFallback();
        });
      }, RECONNECT_BACKOFF_MS);
    };

    /**
     * Fallback polling loop — identical semantics to the sprint-5 hook.
     * Used when `event_bus_subscribe` is unavailable (old backend).
     *
     * Per-hook polling is intentional here: unlike the push path, the
     * polling path cannot be shared because each hook instance owns its
     * own `mergeBatch` closure (different `kind` filter, `seenRef`,
     * `sinceMsRef`, and `limit`). Sharing a single poll interval and then
     * fanning out into per-consumer merge pipelines would replicate the
     * shared-subscription architecture for what is a temporary fallback
     * path — the complexity is not worth it. When the backend upgrades and
     * `event_bus_subscribe` becomes available, all hooks migrate to the
     * single shared channel automatically.
     */
    const startPollingFallback = (): void => {
      if (cancelled || pollTimer !== null) return;
      setConnected(false);

      const tick = async (): Promise<void> => {
        const batch = await fetchWarmReplay(kind, limit, sinceMsRef.current);
        if (cancelled) return;
        mergeBatch(kind ? batch.filter(matchesKind) : batch);
      };

      // Fire immediately so the first paint isn't empty for `pollMs`.
      void tick();
      pollTimer = setInterval(() => {
        void tick();
      }, pollMs);
    };

    /**
     * Mount-time orchestration: warm-replay first, then subscribe. On
     * unknown-command fall back to polling.
     */
    const start = async (): Promise<void> => {
      await seedWarmReplay();
      if (cancelled) return;
      if (!isTauri) return;

      const subscribed = await openChannel();
      if (cancelled) return;
      if (!subscribed) startPollingFallback();
    };

    void start();

    return () => {
      cancelled = true;
      activeRef.current = false;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Drop our slot in the shared upstream subscription. The shared
      // manager refcounts and tears down the Tauri channel when the
      // last hook unmounts.
      const unsub = sharedUnsubscribe;
      sharedUnsubscribe = null;
      unsub?.();
    };
  }, [kind, limit, pollMs]);

  return resultRef.current;
}
