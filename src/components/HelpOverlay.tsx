import { useEffect, useRef, useState, type JSX } from 'react';
import {
  HELP_OVERLAY_CLOSE_EVENT,
  HELP_OVERLAY_TOGGLE_EVENT,
} from '../hooks/useGlobalHotkeys';

type Shortcut = {
  readonly keys: ReadonlyArray<string>;
  readonly label: string;
};

// Module-level flag so other pages can guard against double-toggling.
// Updated synchronously with the overlay's open/closed state.
let _helpOverlayOpen = false;

/** Returns true while the global help overlay is mounted and visible. */
export function isHelpOverlayOpen(): boolean {
  return _helpOverlayOpen;
}

// Mac shows `⌘`, everyone else sees `Ctrl`. Avoids misleading Linux/Windows
// users who have no Cmd key on their keyboard.
function primaryModLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad/i.test(navigator.platform) ? '\u2318' : 'Ctrl';
}

function buildShortcuts(mod: string): ReadonlyArray<{
  readonly heading: string;
  readonly rows: ReadonlyArray<Shortcut>;
}> {
  return [
    {
      heading: 'NAVIGATION',
      rows: [
        { keys: [mod, '1'], label: 'Overview' },
        { keys: [mod, '2'], label: 'Files' },
        { keys: [mod, '3'], label: 'Apps' },
        { keys: [mod, '4'], label: 'Auto (todos + scheduled)' },
        { keys: [mod, '5'], label: 'Calendar' },
        { keys: [mod, '6'], label: 'Screen' },
        { keys: [mod, '7'], label: 'Contacts' },
        { keys: [mod, '8'], label: 'Memory' },
        { keys: [mod, '9'], label: 'Web' },
      ],
    },
    {
      heading: 'SYSTEM',
      rows: [
        { keys: [mod, ','], label: 'Settings' },
        { keys: [mod, 'J'], label: 'Toggle terminals & AI chat dock' },
        { keys: ['?'], label: 'Toggle this help' },
        { keys: ['Esc'], label: 'Close overlay' },
      ],
    },
    {
      heading: 'VOICE',
      rows: [
        { keys: ['Space', '(hold)'], label: 'Push-to-talk — speak to SUNNY' },
        { keys: ['F19'], label: 'Push-to-talk (alternate key)' },
      ],
    },
    {
      heading: 'SECURITY',
      rows: [
        { keys: ['!'], label: 'Panic — stop agent, block egress' },
        { keys: ['P'], label: 'Release panic mode' },
      ],
    },
  ];
}

// Collect all focusable elements within a container.
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function HelpOverlay(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    const toggle = (): void => {
      setOpen(prev => {
        const next = !prev;
        _helpOverlayOpen = next;
        if (next) {
          // Capture focus origin before opening.
          returnFocusRef.current = document.activeElement;
        }
        return next;
      });
    };
    const close = (): void => {
      _helpOverlayOpen = false;
      setOpen(false);
    };
    window.addEventListener(HELP_OVERLAY_TOGGLE_EVENT, toggle);
    window.addEventListener(HELP_OVERLAY_CLOSE_EVENT, close);
    return () => {
      window.removeEventListener(HELP_OVERLAY_TOGGLE_EVENT, toggle);
      window.removeEventListener(HELP_OVERLAY_CLOSE_EVENT, close);
    };
  }, []);

  // Move focus into dialog when opened; restore when closed.
  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => {
        const el = dialogRef.current;
        if (!el) return;
        const first = getFocusable(el)[0] ?? el;
        first.focus();
      });
      return () => cancelAnimationFrame(frame);
    } else {
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement) {
        target.focus();
      }
      returnFocusRef.current = null;
    }
  }, [open]);

  // Focus trap — keep Tab / Shift+Tab inside the dialog while open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const el = dialogRef.current;
      if (!el) return;
      const focusable = getFocusable(el);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;

  const mod = primaryModLabel();
  const sections = buildShortcuts(mod);

  return (
    // Backdrop — click outside to close.
    <div
      className="help-overlay-backdrop"
      onClick={() => { _helpOverlayOpen = false; setOpen(false); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-overlay-title"
        className="help-overlay-panel"
        // Stop clicks inside the panel from bubbling to the backdrop.
        onClick={e => e.stopPropagation()}
        // tabIndex so the panel itself is reachable as a last-resort focus target.
        tabIndex={-1}
      >
        <div className="help-overlay-header">
          <span id="help-overlay-title" className="help-overlay-heading">
            KEYBOARD SHORTCUTS
          </span>
          <button
            type="button"
            className="help-overlay-close"
            aria-label="Close keyboard shortcuts"
            onClick={() => { _helpOverlayOpen = false; setOpen(false); }}
          >
            ESC TO CLOSE
          </button>
        </div>

        {sections.map(section => (
          <div key={section.heading} className="help-overlay-section">
            <div className="help-overlay-section-heading" aria-hidden="true">
              {section.heading}
            </div>
            <dl className="help-overlay-grid">
              {section.rows.map(row => (
                <ShortcutRow key={row.label} row={row} />
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShortcutRow({ row }: { readonly row: Shortcut }): JSX.Element {
  return (
    <>
      <dt className="help-overlay-keys">
        {row.keys.map((k, i) => (
          <KeyCap key={`${k}-${i}`} label={k} />
        ))}
      </dt>
      <dd className="help-overlay-desc">{row.label}</dd>
    </>
  );
}

function KeyCap({ label }: { readonly label: string }): JSX.Element {
  return <kbd className="help-overlay-keycap">{label}</kbd>;
}
