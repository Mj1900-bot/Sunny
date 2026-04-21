import { useEffect, useState } from 'react';

/**
 * Tracks the Caps Lock key state using `KeyboardEvent.getModifierState`,
 * which is the only reliable cross-browser way to read modifier state
 * without polling. Returns `true` when Caps Lock is on.
 *
 * The hook only attaches listeners while `active` is true to keep idle
 * cost at zero (important for a long-lived vault page).
 */
export function useCapsLock(active: boolean): boolean {
  const [caps, setCaps] = useState<boolean>(false);

  useEffect(() => {
    if (!active) {
      setCaps(false);
      return;
    }
    function handler(e: KeyboardEvent) {
      // Some events (like mousedown-triggered synthetic ones) won't have
      // the method; guard for safety.
      if (typeof e.getModifierState === 'function') {
        setCaps(e.getModifierState('CapsLock'));
      }
    }
    window.addEventListener('keydown', handler);
    window.addEventListener('keyup', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keyup', handler);
    };
  }, [active]);

  return caps;
}
