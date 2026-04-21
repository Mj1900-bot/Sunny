import { useCallback, useEffect, useRef, useState } from 'react';
import { SEARCH_DEBOUNCE_MS } from './constants';

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function formatRelative(tsSec: number, nowSec: number): string {
  const d = Math.max(0, nowSec - tsSec);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 2_592_000) return `${Math.floor(d / 86400)}d ago`;
  if (d < 31_536_000) return `${Math.floor(d / 2_592_000)}mo ago`;
  return `${Math.floor(d / 31_536_000)}y ago`;
}

export function formatRelativeMs(ts: number): string {
  return formatRelative(Math.floor(ts / 1000), Math.floor(Date.now() / 1000));
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function truncateToTwoLines(s: string): string {
  const firstNl = s.indexOf('\n');
  if (firstNl === -1) return s.length > 280 ? `${s.slice(0, 277)}…` : s;
  const secondNl = s.indexOf('\n', firstNl + 1);
  const cut = secondNl === -1 ? s : s.slice(0, secondNl);
  return cut.length > 280 ? `${cut.slice(0, 277)}…` : cut;
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Debounced search query hook (shared by 3 tabs)
// ---------------------------------------------------------------------------

export function useDebouncedQuery(raw: string): string {
  const [debounced, setDebounced] = useState(raw);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(raw), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [raw]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Persistent state — lightweight localStorage-backed hook. Used for the
// active memory tab so a reload lands the user back where they were.
// ---------------------------------------------------------------------------

export function usePersistentState<T>(
  key: string,
  initial: T,
  isValid: (v: unknown) => v is T,
): readonly [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return isValid(parsed) ? parsed : initial;
    } catch {
      return initial;
    }
  });

  const setPersisted = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Ignore quota / SecurityError — state still lives in memory.
      }
    },
    [key],
  );

  return [value, setPersisted] as const;
}

// ---------------------------------------------------------------------------
// Click-to-copy — returns a handler that writes `text` to the clipboard and
// flashes the given row id for ~1.2s. The consumer renders the flash.
// ---------------------------------------------------------------------------

export type CopyState = Readonly<{
  flashedId: string | null;
  copy: (id: string, text: string) => void;
}>;

export function useCopyFlash(durationMs: number = 1200): CopyState {
  const [flashedId, setFlashedId] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(
    (id: string, text: string) => {
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      const writer = nav?.clipboard?.writeText?.bind(nav.clipboard);
      const run = async (): Promise<void> => {
        try {
          if (writer) {
            await writer(text);
          } else if (typeof document !== 'undefined') {
            // Fallback for non-secure contexts: transient textarea + execCommand.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          setFlashedId(id);
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            setFlashedId(curr => (curr === id ? null : curr));
            timerRef.current = null;
          }, durationMs);
        } catch {
          // Swallow — copy is an enhancement, never a blocker.
        }
      };
      void run();
    },
    [durationMs],
  );

  return { flashedId, copy };
}
