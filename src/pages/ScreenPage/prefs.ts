import { PREFS_KEY, DEFAULT_PREFS, PSM_PRESETS } from './constants';
import type { ScreenPrefs, AutoCadence } from './types';

export function loadPrefs(): ScreenPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ScreenPrefs>;
    const cadences: ReadonlyArray<AutoCadence> = ['OFF', '5s', '15s', '60s'];
    const psmWhitelist = new Set(PSM_PRESETS.map(p => p.psm));
    const psm = typeof parsed.ocrPsm === 'number' && psmWhitelist.has(parsed.ocrPsm)
      ? parsed.ocrPsm
      : DEFAULT_PREFS.ocrPsm;
    const minConf = typeof parsed.ocrMinConf === 'number'
      ? Math.min(100, Math.max(0, parsed.ocrMinConf))
      : DEFAULT_PREFS.ocrMinConf;
    return {
      cadence: cadences.includes(parsed.cadence as AutoCadence) ? (parsed.cadence as AutoCadence) : 'OFF',
      showBoxes: typeof parsed.showBoxes === 'boolean' ? parsed.showBoxes : false,
      ocrPsm: psm,
      ocrMinConf: minConf,
      ocrPreserveLayout:
        typeof parsed.ocrPreserveLayout === 'boolean'
          ? parsed.ocrPreserveLayout
          : DEFAULT_PREFS.ocrPreserveLayout,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: ScreenPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* quota / private mode */ }
}
