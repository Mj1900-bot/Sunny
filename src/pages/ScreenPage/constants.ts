import type { PermissionProbe, PsmPreset, ScreenPrefs } from './types';

export const PSM_PRESETS: ReadonlyArray<PsmPreset> = [
  { psm: 3,  label: 'AUTO',     hint: 'Fully automatic page segmentation (best for varied layouts).' },
  { psm: 4,  label: 'COLUMN',   hint: 'Assume a single column of text of variable sizes.' },
  { psm: 6,  label: 'BLOCK',    hint: 'Assume a single uniform block of text (default, good for UI).' },
  { psm: 7,  label: 'LINE',     hint: 'Treat the image as a single text line.' },
  { psm: 11, label: 'SPARSE',   hint: 'Find as much text as possible in no particular order (dense UIs).' },
  { psm: 12, label: 'SPARSE+',  hint: 'Sparse text + orientation detection.' },
];

export const PREFS_KEY = 'sunny.screen.prefs.v1';

export const DEFAULT_PREFS: ScreenPrefs = {
  cadence: 'OFF',
  showBoxes: false,
  ocrPsm: 6,
  ocrMinConf: 0,
  ocrPreserveLayout: true,
};

export const INITIAL_PROBE: PermissionProbe = {
  screenRecording: { status: 'unknown' },
  automation: { status: 'unknown' },
  accessibility: { status: 'unknown' },
  tesseract: { status: 'unknown' },
  checkedAt: 0,
};

/** A valid 1×1 RGBA PNG, base64-encoded — used to cheaply probe whether
 *  `tesseract` is installed without capturing the screen. Byte-identical to
 *  the `ONE_BY_ONE_PNG` fixture in `src-tauri/src/vision.rs`, so libpng is
 *  guaranteed not to reject it with a CRC mismatch. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

/** Sunny's reverse-DNS bundle identifier. Must stay in sync with
 *  `tauri.conf.json#identifier` so `tccutil reset` targets the right row. */
export const SUNNY_BUNDLE_ID = 'ai.kinglystudio.sunny';

/** macOS `x-apple.systempreferences` deep links. Each targets a specific
 *  Privacy & Security sub-pane; confirmed working on macOS 13–15. */
export const SETTINGS_URLS = {
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
} as const;

export const SCREEN_POLL_INTERVAL_MS = 3000;
export const WINDOW_LIST_INTERVAL_MS = 8000;
export const HISTORY_LIMIT = 30;
