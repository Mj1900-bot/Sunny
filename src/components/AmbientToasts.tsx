/**
 * AmbientToasts — in-HUD surface for the Rust `ambient` watcher.
 *
 * Subscribes to `sunny://ambient.notify`, which emits a softer, non-OS
 * notification for three trigger categories defined in `src-tauri/src/
 * ambient.rs`:
 *
 *   - `meeting`  → next meeting in 5–15 min (amber)
 *   - `battery`  → battery < 15 % and discharging  (red)
 *   - `mail`     → inbox unread climbed past user threshold (amber)
 *
 * Behaviour:
 *   - Stacks up to 3 cards top-right; oldest is evicted when full.
 *   - Auto-dismisses after 15 s.
 *   - Click on the card body routes to the relevant module page
 *     (meeting → Calendar, mail → Inbox, battery → no-op).
 *   - Small "×" button always dismisses without navigating.
 *
 * Kept deliberately separate from `ToastStack.tsx` — that component's
 * store (`useToastStore`) is tuned for transient success/error/info
 * signals (4 s TTL, 5-card cap, bottom-right). Mixing the ambient
 * surface in would either pollute that store's types or compromise its
 * layout contract. The two surfaces are visually distinct on-screen
 * (opposite corners) so the user can tell them apart at a glance.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { listen } from '../lib/tauri';
import { useView, type ViewKey } from '../store/view';

type AmbientCategory = 'meeting' | 'battery' | 'mail';

type AmbientPayload = {
  readonly category: AmbientCategory;
  readonly title: string;
  readonly body: string;
  /** Optional — the Rust side currently emits {category,title,body}; if a
   *  future revision adds `at`, we'll honour it for ordering. */
  readonly at?: number;
};

type AmbientToast = {
  readonly id: string;
  readonly category: AmbientCategory;
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
};

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 15_000;

const CATEGORY_COLORS: Record<AmbientCategory, string> = {
  meeting: 'var(--amber)',
  battery: 'var(--red, rgb(255, 82, 82))',
  mail: 'var(--amber)',
};

const CATEGORY_ICONS: Record<AmbientCategory, string> = {
  // Small monospace-friendly glyphs so no icon font is pulled in.
  meeting: '◷',
  battery: '▼',
  mail: '✉',
};

const CATEGORY_LABELS: Record<AmbientCategory, string> = {
  meeting: 'MTG',
  battery: 'BAT',
  mail: 'MAIL',
};

/** Map a category to the module page the user lands on when clicking the
 *  toast body. `null` means "no navigation" (battery has no dedicated
 *  module page — user can still click the × to dismiss). */
function targetView(category: AmbientCategory): ViewKey | null {
  switch (category) {
    case 'meeting': return 'calendar';
    case 'mail': return 'inbox';
    case 'battery': return null;
    default: return null;
  }
}

function makeId(): string {
  return `at_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isValidPayload(value: unknown): value is AmbientPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const cat = v.category;
  if (cat !== 'meeting' && cat !== 'battery' && cat !== 'mail') return false;
  if (typeof v.title !== 'string' || typeof v.body !== 'string') return false;
  return true;
}

const STACK_STYLE: CSSProperties = {
  position: 'fixed',
  top: 56,
  right: 18,
  width: 300,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  zIndex: 9998, // one under ToastStack so transient errors win focus
  pointerEvents: 'none',
};

type CardProps = {
  readonly toast: AmbientToast;
  readonly onDismiss: (id: string) => void;
  readonly onActivate: (toast: AmbientToast) => void;
};

function AmbientToastCard({ toast, onDismiss, onActivate }: CardProps) {
  const [entered, setEntered] = useState(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    raf.current = requestAnimationFrame(() => setEntered(true));
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, []);

  const color = CATEGORY_COLORS[toast.category];
  const icon = CATEGORY_ICONS[toast.category];
  const label = CATEGORY_LABELS[toast.category];
  const canNavigate = targetView(toast.category) !== null;

  const cardStyle: CSSProperties = {
    border: `1px solid ${color}`,
    background: 'rgba(5, 15, 22, 0.95)',
    padding: 10,
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color,
    boxShadow: `0 0 12px ${color}22, 0 6px 18px rgba(0,0,0,0.55)`,
    transform: entered ? 'translateX(0)' : 'translateX(110%)',
    opacity: entered ? 1 : 0,
    transition: 'transform 220ms ease-out, opacity 220ms ease-out',
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    lineHeight: 1.4,
    cursor: canNavigate ? 'pointer' : 'default',
  };

  const iconStyle: CSSProperties = {
    fontSize: 14,
    lineHeight: 1,
    marginTop: 1,
    color,
    flexShrink: 0,
    fontFamily: 'var(--mono)',
  };

  const bodyWrapStyle: CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  };

  const labelStyle: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.18em',
    color,
    opacity: 0.85,
  };

  const titleStyle: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    fontWeight: 600,
    color,
    wordBreak: 'break-word',
  };

  const bodyStyle: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color,
    opacity: 0.85,
    wordBreak: 'break-word',
  };

  const dismissStyle: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color,
    fontFamily: 'var(--mono)',
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
    opacity: 0.7,
    alignSelf: 'flex-start',
  };

  const handleCardClick = (): void => {
    onActivate(toast);
  };

  const handleDismissClick = (e: React.MouseEvent): void => {
    // Stop so the card click handler doesn't also trigger navigation.
    e.stopPropagation();
    onDismiss(toast.id);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      style={cardStyle}
      onClick={canNavigate ? handleCardClick : undefined}
    >
      <span aria-hidden="true" style={iconStyle}>{icon}</span>
      <div style={bodyWrapStyle}>
        <span style={labelStyle}>{label}</span>
        <span style={titleStyle}>{toast.title}</span>
        <span style={bodyStyle}>{toast.body}</span>
      </div>
      <button
        type="button"
        aria-label="Dismiss ambient notification"
        onClick={handleDismissClick}
        style={dismissStyle}
      >
        ×
      </button>
    </div>
  );
}

export function AmbientToasts() {
  const [toasts, setToasts] = useState<readonly AmbientToast[]>([]);
  const setView = useView(s => s.setView);
  const timersRef = useRef<Map<string, number>>(new Map());

  // Subscribe to the Rust-side ambient surface exactly once per mount.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const off = await listen<unknown>('sunny://ambient.notify', raw => {
          if (!isValidPayload(raw)) {
            // Swallow — malformed payloads should never crash the HUD.
            return;
          }
          const toast: AmbientToast = {
            id: makeId(),
            category: raw.category,
            title: raw.title,
            body: raw.body,
            createdAt: Date.now(),
          };
          setToasts(prev => {
            // Immutable append, then trim from the front so the OLDEST is
            // evicted first when we exceed the cap. Callers reading the
            // array will still see stable refs for unchanged entries.
            const appended = [...prev, toast];
            return appended.length > MAX_TOASTS
              ? appended.slice(appended.length - MAX_TOASTS)
              : appended;
          });
        });
        if (disposed) {
          off();
        } else {
          unlisten = off;
        }
      } catch (error) {
        // Listener setup failed — log and no-op. The HUD continues to
        // render; we just won't surface ambient toasts this session.
        console.error('AmbientToasts: listen(sunny://ambient.notify) failed', error);
      }
    })();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Per-toast auto-dismiss timers. Tracking by id lets us cancel cleanly
  // when a toast is manually dismissed (avoids setState-after-unmount).
  useEffect(() => {
    const timers = timersRef.current;
    const liveIds = new Set(toasts.map(t => t.id));

    // Cancel timers for toasts that are no longer present.
    for (const [id, handle] of timers.entries()) {
      if (!liveIds.has(id)) {
        window.clearTimeout(handle);
        timers.delete(id);
      }
    }

    // Schedule timers for newly-added toasts.
    for (const toast of toasts) {
      if (timers.has(toast.id)) continue;
      const handle = window.setTimeout(() => {
        timers.delete(toast.id);
        setToasts(prev => prev.filter(t => t.id !== toast.id));
      }, AUTO_DISMISS_MS);
      timers.set(toast.id, handle);
    }

    return () => {
      // Intentionally do NOT clear timers on every effect run — we only
      // want to clear them on full unmount. This branch handles unmount
      // via the closure-captured reference.
    };
  }, [toasts]);

  // Clear any pending timers on unmount to avoid touching state after
  // the component goes away.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) {
        window.clearTimeout(handle);
      }
      timers.clear();
    };
  }, []);

  const dismiss = (id: string): void => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const activate = (toast: AmbientToast): void => {
    const view = targetView(toast.category);
    if (view !== null) {
      setView(view);
    }
    // Clicking the card always dismisses — whether or not it navigated.
    dismiss(toast.id);
  };

  if (toasts.length === 0) return null;

  return (
    <div style={STACK_STYLE} aria-live="polite" aria-atomic="false">
      {toasts.map(t => (
        <AmbientToastCard
          key={t.id}
          toast={t}
          onDismiss={dismiss}
          onActivate={activate}
        />
      ))}
    </div>
  );
}
