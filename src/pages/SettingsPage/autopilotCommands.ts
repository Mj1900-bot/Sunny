/**
 * autopilotCommands.ts — Thin wrapper around J7's `settings_get` /
 * `settings_update` Tauri commands.
 *
 * STUB NOTICE: As of 2026-04-20 J7's backend is not yet landed. Both
 * functions transparently fall back to `localStorage` under the key
 * `sunny.autopilot.v1`. When the commands become available in Tauri's
 * runtime the stub is automatically bypassed because `invokeSafe`
 * returns `null` only when the command doesn't exist, and the stub
 * kicks in only on that path.
 *
 * To verify backend availability: check `isTauri && result !== null`.
 */

import { invokeSafe, isTauri, listen, type UnlistenFn } from '../../lib/tauri';
import { parseAutopilotSettings, AUTOPILOT_DEFAULTS, type AutopilotSettings } from './autopilotTypes';

const LS_KEY = 'sunny.autopilot.v1';

function lsLoad(): AutopilotSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return AUTOPILOT_DEFAULTS;
    const parsed = parseAutopilotSettings(JSON.parse(raw));
    return parsed ?? AUTOPILOT_DEFAULTS;
  } catch {
    return AUTOPILOT_DEFAULTS;
  }
}

function lsSave(settings: AutopilotSettings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  } catch {
    // quota / private mode — ignore
  }
}

/**
 * Fetch current autopilot settings.
 * Tries `settings_get` first; falls back to localStorage on miss / outside Tauri.
 */
export async function fetchAutopilotSettings(): Promise<AutopilotSettings> {
  if (isTauri) {
    const result = await invokeSafe<unknown>('settings_get');
    if (result !== null) {
      const parsed = parseAutopilotSettings(result);
      if (parsed) return parsed;
    }
  }
  // STUB: J7 command not yet available — use localStorage
  return lsLoad();
}

/**
 * Persist a partial diff of autopilot settings.
 * Tries `settings_update`; falls back to localStorage.
 */
export async function updateAutopilotSettings(
  current: AutopilotSettings,
  diff: Partial<AutopilotSettings>,
): Promise<void> {
  const next: AutopilotSettings = { ...current, ...diff };
  // Optimistically persist locally first so a re-mount gets the latest.
  lsSave(next);
  if (isTauri) {
    // Fire-and-forget — if the command isn't available yet, invokeSafe
    // will log + swallow the error. The localStorage copy is the fallback.
    await invokeSafe<void>('settings_update', { diff });
  }
}

/** Subscribe to `sunny://settings/changed` for cross-instance reconciliation. */
export async function subscribeSettingsChanged(
  cb: (payload: unknown) => void,
): Promise<UnlistenFn> {
  return listen<unknown>('sunny://settings/changed', cb);
}
