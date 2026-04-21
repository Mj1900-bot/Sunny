import { useEffect, useRef } from 'react';
import { useView, type ViewKey } from '../store/view';

// Cmd/Ctrl+1..9 jumps to the first 9 modules in NAV_MODULES order.
// Keep this in sync with src/data/seeds.ts NAV_MODULES[0..8].
const DIGIT_TO_VIEW: ReadonlyArray<ViewKey> = [
  'overview',  // 1
  'files',     // 2
  'apps',      // 3
  'auto',      // 4 — TODOS + SCHEDULED tabs
  'calendar',  // 5
  'screen',    // 6
  'contacts',  // 7
  'memory',    // 8 — EPISODIC / SEMANTIC / HISTORY / …
  'web',       // 9
];

export const HELP_OVERLAY_TOGGLE_EVENT = 'sunny-help-overlay-toggle';
export const HELP_OVERLAY_CLOSE_EVENT = 'sunny-help-overlay-close';

function dispatchOverlayEvent(name: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name));
}

const COALESCE_MS = 250;

type HotkeyCode = 'Space' | 'F19';

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useGlobalHotkeys(): void {
  const settings = useView(s => s.settings);
  const setView = useView(s => s.setView);
  const toggleDock = useView(s => s.toggleDock);
  
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const setViewRef = useRef(setView);
  useEffect(() => { setViewRef.current = setView; }, [setView]);

  const toggleDockRef = useRef(toggleDock);
  useEffect(() => { toggleDockRef.current = toggleDock; }, [toggleDock]);

  const pressedAtRef = useRef<number | null>(null);
  const activeCodeRef = useRef<HotkeyCode | null>(null);

  // Module navigation (Cmd/Ctrl+1..9) and help overlay (`?`, Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTextInput(e.target)) return;

      // Cmd/Ctrl+1..9 — jump to module. Use e.key so Shift+digit (symbols)
      // doesn't accidentally match, and only fire without Alt to avoid
      // clobbering OS-level shortcuts.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (e.key >= '1' && e.key <= '9') {
          const idx = Number(e.key) - 1;
          const target = DIGIT_TO_VIEW[idx];
          if (target) {
            e.preventDefault();
            setViewRef.current(target);
          }
          return;
        }

        // Cmd/Ctrl+J — toggle the bottom dock (terminals + AI chat).
        // Mirrors VSCode's panel-toggle shortcut so it's immediately
        // familiar; check e.code so alternate layouts still match the
        // physical `J` key.
        if (e.code === 'KeyJ') {
          e.preventDefault();
          toggleDockRef.current();
          return;
        }
      }

      // `?` with no modifier (other than Shift, since `?` is Shift+/ on US
      // layouts) toggles the help overlay.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        dispatchOverlayEvent(HELP_OVERLAY_TOGGLE_EVENT);
        return;
      }

      // Esc — ask the overlay to close itself. The overlay owns visibility
      // state and will no-op if it isn't open, so this is safe even when
      // Esc is meaningful elsewhere.
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        dispatchOverlayEvent(HELP_OVERLAY_CLOSE_EVENT);
        return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const matchCode = (e: KeyboardEvent): HotkeyCode | null => {
      const configured = settingsRef.current.pushToTalkKey;
      if (e.code === configured) return configured;
      if (e.code === 'F19') return 'F19';
      if (e.code === 'Space' && configured === 'Space') return 'Space';
      return null;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      const code = matchCode(e);
      if (!code) return;
      if (isTextInput(e.target)) return;
      if (e.repeat) { e.preventDefault(); return; }
      if (activeCodeRef.current !== null) return;

      e.preventDefault();
      activeCodeRef.current = code;
      pressedAtRef.current = performance.now();

      // Delegate Push-To-Talk execution to `useVoiceChat`
      window.dispatchEvent(new CustomEvent('sunny-ptt-start'));
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      const code = matchCode(e);
      if (!code) return;
      if (activeCodeRef.current !== code) return;

      e.preventDefault();
      const pressedAt = pressedAtRef.current;
      const heldMs = pressedAt === null ? 0 : performance.now() - pressedAt;
      activeCodeRef.current = null;
      pressedAtRef.current = null;

      if (heldMs < COALESCE_MS) {
        window.dispatchEvent(new CustomEvent('sunny-ptt-cancel'));
        return;
      }

      window.dispatchEvent(new CustomEvent('sunny-ptt-stop'));
    };

    const onBlur = (): void => {
      if (activeCodeRef.current === null) return;
      activeCodeRef.current = null;
      pressedAtRef.current = null;
      window.dispatchEvent(new CustomEvent('sunny-ptt-cancel'));
    };

    window.addEventListener('keydown', downHandler);
    window.addEventListener('keyup', upHandler);
    window.addEventListener('blur', blurHandler);
    return () => {
      window.removeEventListener('keydown', downHandler);
      window.removeEventListener('keyup', upHandler);
      window.removeEventListener('blur', blurHandler);
    };

    // Use named functions for proper listener removal instead of anonymous arrow wrappers
    function downHandler(e: KeyboardEvent) { onKeyDown(e); }
    function upHandler(e: KeyboardEvent) { onKeyUp(e); }
    function blurHandler() { onBlur(); }
  }, []);
}
