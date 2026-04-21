/**
 * Shared hooks — tiny utilities every module page can reuse.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useView } from '../../store/view';

/** Soft floor on poll cadence. Even on FAST tier we never poll more often
 *  than this — protects against accidental rename of a page-authored
 *  300ms interval into a 150ms runaway when someone bumps the tier. */
const MIN_POLL_MS = 500;

/** Scale the caller's intended cadence by the MODULES · REFRESH TIER
 *  setting. SLOW ×2, FAST ×½, BALANCED passthrough. Kept as a pure
 *  function so callers can compute the "live" interval for logs. */
function scaleInterval(base: number, tier: 'slow' | 'balanced' | 'fast'): number {
  if (base <= 0) return base;
  if (tier === 'slow') return base * 2;
  if (tier === 'fast') return Math.max(MIN_POLL_MS, Math.floor(base / 2));
  return base;
}

/** Periodically invoke an async loader until the component unmounts.
 *  Guarantees no state update after unmount; replaces manual setInterval
 *  boilerplate in every page that polls a Tauri command.
 *
 *  Honours two global settings automatically:
 *   * `settings.liveRefresh === false` disables the periodic timer.
 *     The initial fetch still runs so the page renders something.
 *   * `settings.refreshTier` scales the `intervalMs` (slow ×2, fast ×½)
 *     subject to a `MIN_POLL_MS` floor.
 *
 *  `intervalMs: 0` still means "fetch once, no interval" so one-shot
 *  loaders continue to opt out.
 *
 *  Fix 7: `loader` is captured via a ref so a new function identity on
 *  the parent's re-render does NOT restart the polling effect. Callers
 *  that pass a stable reference (useCallback) benefit as before; callers
 *  that pass an inline arrow also work correctly without accidental
 *  effect restarts / double fetches. */
export function usePoll<T>(
  loader: () => Promise<T>,
  intervalMs: number,
  deps: ReadonlyArray<unknown> = [],
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  // Fix 7: keep loader in a ref so the effect does not re-register when the
  // caller's closure identity changes (e.g. inline arrow on every render).
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const liveRefresh = useView(s => s.settings.liveRefresh);
  const refreshTier = useView(s => s.settings.refreshTier);

  // Scale once per render so the effect's dep array closes over a stable
  // primitive and re-subscribes only when the user actually changes the
  // tier (not on every parent re-render).
  const effectiveMs = intervalMs > 0 && liveRefresh
    ? scaleInterval(intervalMs, refreshTier)
    : 0;

  useEffect(() => {
    alive.current = true;
    let handle: number | null = null;
    const run = async () => {
      // Gate on visibility: skip the fetch while the tab is hidden so
      // background tabs don't issue IPC calls at full cadence. The
      // visibilitychange listener below re-fires run() when the tab
      // returns to the foreground, keeping data fresh on re-focus.
      if (document.visibilityState !== 'visible') return;
      try {
        // Call through the ref so we always use the latest loader without
        // the effect depending on its identity.
        const v = await loaderRef.current();
        if (alive.current) { setData(v); setError(null); }
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    };
    void run();
    if (effectiveMs > 0) handle = window.setInterval(run, effectiveMs);
    const onVisibility = () => { if (document.visibilityState === 'visible') void run(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive.current = false;
      if (handle !== null) clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveMs, tick, ...deps]);

  return { data, loading, error, reload: () => setTick(n => n + 1) };
}

/** Debounce a rapidly-changing value (used by search inputs). */
export function useDebounced<T>(value: T, ms = 240): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setV(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms]);
  return v;
}

/** Human-relative time formatter ("2m ago", "yesterday", "Mar 3"). */
export function relTime(tsSecs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - tsSecs;
  if (diff < 5) return 'now';
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(tsSecs * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Convert Unix seconds to HH:MM local. */
export function clockTime(tsSecs: number): string {
  return new Date(tsSecs * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Short-lived status line after copy / export actions (module pages). */
export function useFlashMessage(durationMs = 2400): {
  message: string | null;
  flash: (msg: string) => void;
} {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const flash = useCallback((msg: string) => {
    setMessage(msg);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setMessage(null);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
  }, []);

  return { message, flash };
}
