import { create } from 'zustand';
import { invokeSafe, isTauri } from '../lib/tauri';

export type ViewKey =
  | 'overview' | 'today' | 'timeline' | 'security'
  | 'tasks' | 'journal' | 'focus' | 'calendar'
  | 'inbox' | 'people' | 'contacts' | 'voice' | 'notify'
  | 'notes' | 'reading' | 'memory' | 'photos' | 'files'
  | 'auto' | 'skills' | 'apps' | 'web' | 'code' | 'console' | 'screen' | 'scan'
  | 'brainstorm' | 'world' | 'society' | 'brain' | 'persona' | 'inspector' | 'audit' | 'devices' | 'diagnostics' | 'vault' | 'settings' | 'cost';

export type SettingsSnapshot = Settings;

/** Providers Sunny can talk to. Must stay in sync with the Rust
 *  `match provider` arm in src-tauri/src/ai.rs — each string here has a
 *  corresponding backend route. */
export type ProviderId = 'ollama' | 'openclaw' | 'glm';

export type ModelPreset = {
  readonly id: string;
  readonly label: string;
  readonly provider: ProviderId;
  readonly model: string;
};

export type PhotoRoot = 'Desktop' | 'Screenshots' | 'Downloads';
export type RefreshTier = 'slow' | 'balanced' | 'fast';
export type ReadingTab = 'queue' | 'reading' | 'done';

type Settings = {
  theme: 'cyan' | 'amber' | 'green' | 'violet' | 'magenta';
  voiceEnabled: boolean;
  voiceName: string;
  voiceRate: number;
  provider: ProviderId;
  model: string;
  orbIntensity: number;
  gridOpacity: number;
  orbStatePolicy: 'fixed' | 'load' | 'voice' | 'focus';
  pushToTalkKey: 'Space' | 'F19';
  wakePhrase: string;
  // ── Model tuning ─────────────────────────────────────────────
  temperature: number;        // 0.0 – 2.0 (sampler heat)
  maxTokens: number;          // 256 – 8192 (per-turn output cap)
  contextBudget: number;      // 2048 – 200k (system+history cap)
  // ── Safety / ergonomics ──────────────────────────────────────
  autoApproveSafe: boolean;   // skip ConfirmGate for risk:'low'
  toolTimeoutMs: number;      // per-tool hard wall-clock ceiling
  // ── Appearance (extra) ───────────────────────────────────────
  reducedMotion: boolean;     // disable transitions / orb pulse
  compactMode: boolean;       // tighten gutters + type scale
  // ── Module pages (per-page knobs used by the 30+ module pages) ─
  // Settings here are read lazily by module pages; the store stays the
  // single source of truth so "Reset to defaults" wipes them too.
  liveRefresh: boolean;                 // master on/off for module-page polling
  refreshTier: RefreshTier;             // scales poll cadence (slow ×2, fast ×½)
  aiModuleActions: boolean;             // gate "Sunny triage / digest / brief" buttons
  // CODE page default git-discovery root (also mirrored in localStorage for
  // backward compat with the page's own hook).
  codeRepoRoot: string;
  // PHOTOS page — subset of ~/Desktop, ~/Screenshots (CG cache), and
  // ~/Downloads to search. Stored as an ordered array so the UI can keep
  // a stable "first root becomes default" convention.
  photosRoots: ReadonlyArray<PhotoRoot>;
  // FOCUS — default session length, used by the Focus timer's quick-start
  // chips (25 pomodoro / 45 flow / 60 deep / 90 sprint, etc.).
  focusDefaultMinutes: number;
  // PEOPLE — CRM warmth thresholds, days since last contact.
  peopleWarmDays: number;               // < N days → warm
  peopleColdDays: number;               // ≥ N days → cold
  // NOTIFY — max entries to retain in the local feed.
  notifyLogCap: number;
  // READING — which queue tab to land on when the page opens.
  readingDefaultTab: ReadingTab;
  // AUDIT — start with `only_errors: true` so issues jump out immediately.
  auditOnlyErrors: boolean;
  // INSPECTOR — char cap on OCR'd screen text before it's handed to the LLM.
  inspectorOcrMaxChars: number;
  // TIMELINE / JOURNAL — episodic-memory fetch caps (keeps the UI snappy on
  // dense memory DBs).
  timelineFetchCap: number;
  journalFetchCap: number;
  // ── Saved model presets (user-defined) ───────────────────────
  customPresets: ReadonlyArray<ModelPreset>;
};

type State = {
  view: ViewKey;
  settingsOpen: boolean;
  settings: Settings;
  dockHidden: boolean;
  setView: (v: ViewKey) => void;
  openSettings: () => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  patchSettings: (p: Partial<Settings>) => void;
  /** Restore every settings field to its factory default and flush to
   *  both localStorage and the Tauri filesystem copy so a subsequent
   *  reload doesn't rehydrate the old values. */
  resetSettings: () => void;
  toggleDock: () => void;
  setDockHidden: (v: boolean) => void;
};

/** Expose DEFAULTS as a frozen snapshot for consumers (AdvancedTab's
 *  reset button, diagnostics reports). Intentionally read-only — the
 *  store owns mutation. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  theme: 'amber',
  voiceEnabled: true,
  voiceName: 'George',
  voiceRate: 210,
  provider: 'ollama',
  model: '',
  orbIntensity: 98,
  gridOpacity: 36,
  orbStatePolicy: 'load',
  pushToTalkKey: 'Space',
  wakePhrase: 'hey sunny',
  temperature: 0.7,
  maxTokens: 2048,
  contextBudget: 32000,
  autoApproveSafe: true,
  toolTimeoutMs: 45_000,
  reducedMotion: false,
  compactMode: false,
  // Module pages — defaults tuned against the 21 new module pages. They
  // must be live from first launch so the pages render something sensible
  // before the user ever opens Settings.
  liveRefresh: true,
  refreshTier: 'balanced',
  aiModuleActions: true,
  codeRepoRoot: '~/code',
  photosRoots: ['Desktop', 'Screenshots', 'Downloads'] as ReadonlyArray<PhotoRoot>,
  focusDefaultMinutes: 25,
  peopleWarmDays: 7,
  peopleColdDays: 30,
  notifyLogCap: 200,
  readingDefaultTab: 'queue',
  auditOnlyErrors: false,
  inspectorOcrMaxChars: 4000,
  timelineFetchCap: 800,
  journalFetchCap: 400,
  customPresets: [],
});

const STORAGE_KEY = 'sunny.settings.v1';
const DOCK_KEY = 'sunny.dockHidden.v1';

function loadDockHidden(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) === '1';
  } catch {
    return false;
  }
}

function persistDockHidden(v: boolean): void {
  try {
    localStorage.setItem(DOCK_KEY, v ? '1' : '0');
  } catch {
    /* ignore — private mode / quota */
  }
}

// Internal mutable snapshot used for spread-merges. Kept in sync with
// `DEFAULT_SETTINGS` via structural clone — the frozen public copy is the
// contract, this one is purely an implementation detail.
const DEFAULTS: Settings = {
  ...DEFAULT_SETTINGS,
  customPresets: [...DEFAULT_SETTINGS.customPresets],
  photosRoots: [...DEFAULT_SETTINGS.photosRoots],
};

// One-shot migrations — each flag is set once we've handled it, so users
// who have explicitly customised their settings afterwards never get
// overridden. We use separate keys per wave so a later migration can fire
// even if an earlier one already ran (flipping a single key would gate
// every future migration forever).
const VOICE_MIGRATION_KEY = 'sunny.settings.v1.voice_migrated_to_kokoro';
const RATE_MIGRATION_KEY  = 'sunny.settings.v1.voice_rate_bumped_to_210';
const MODEL_MIGRATION_KEY = 'sunny.settings.v1.model_migrated_alfred_to_sunny';

function loadSettingsSync(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      try {
        localStorage.setItem(VOICE_MIGRATION_KEY, '1');
        localStorage.setItem(RATE_MIGRATION_KEY, '1');
        localStorage.setItem(MODEL_MIGRATION_KEY, '1');
      } catch { /* ignore */ }
      return DEFAULTS;
    }
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = { ...DEFAULTS, ...parsed };
    // Guard against corrupted / legacy shapes: a user with an older
    // localStorage blob will have new fields set to `undefined`, which
    // either crashes `.map`/`.toFixed` downstream or renders as "NaN".
    // Coerce anything that fails its type check back to DEFAULTS before
    // the store is ever read by a component.
    if (!Array.isArray(merged.customPresets)) merged.customPresets = [];
    // photosRoots ships as a string union array — reject both "not an array"
    // and "array with stray strings" so a corrupted snapshot can't crash
    // PhotosPage's `fs_search` loop with an undefined root label.
    const ALLOWED_PHOTO_ROOTS: ReadonlyArray<PhotoRoot> = ['Desktop', 'Screenshots', 'Downloads'];
    if (!Array.isArray(merged.photosRoots)) {
      merged.photosRoots = [...DEFAULTS.photosRoots];
    } else {
      const filtered = merged.photosRoots.filter(
        (r): r is PhotoRoot => typeof r === 'string' && (ALLOWED_PHOTO_ROOTS as readonly string[]).includes(r),
      );
      merged.photosRoots = filtered.length > 0 ? filtered : [...DEFAULTS.photosRoots];
    }
    // Union-typed string fields: if a legacy or hand-edited snapshot has
    // something off-list, fall back to the default so downstream `switch`
    // statements don't silently hit their default branch.
    const ALLOWED_REFRESH_TIERS: ReadonlyArray<RefreshTier> = ['slow', 'balanced', 'fast'];
    if (!(ALLOWED_REFRESH_TIERS as readonly string[]).includes(merged.refreshTier as string)) {
      merged.refreshTier = DEFAULTS.refreshTier;
    }
    const ALLOWED_READING_TABS: ReadonlyArray<ReadingTab> = ['queue', 'reading', 'done'];
    if (!(ALLOWED_READING_TABS as readonly string[]).includes(merged.readingDefaultTab as string)) {
      merged.readingDefaultTab = DEFAULTS.readingDefaultTab;
    }
    if (typeof merged.codeRepoRoot !== 'string' || merged.codeRepoRoot.length === 0) {
      merged.codeRepoRoot = DEFAULTS.codeRepoRoot;
    }
    const numericFields: ReadonlyArray<keyof Settings> = [
      'temperature', 'maxTokens', 'contextBudget', 'toolTimeoutMs',
      'voiceRate', 'orbIntensity', 'gridOpacity',
      'focusDefaultMinutes', 'peopleWarmDays', 'peopleColdDays',
      'notifyLogCap', 'inspectorOcrMaxChars',
      'timelineFetchCap', 'journalFetchCap',
    ];
    for (const f of numericFields) {
      const v = merged[f] as unknown;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        (merged as Record<string, unknown>)[f] = DEFAULTS[f];
      }
    }
    const booleanFields: ReadonlyArray<keyof Settings> = [
      'voiceEnabled', 'autoApproveSafe', 'reducedMotion', 'compactMode',
      'liveRefresh', 'aiModuleActions', 'auditOnlyErrors',
    ];
    for (const f of booleanFields) {
      const v = merged[f] as unknown;
      if (typeof v !== 'boolean') {
        (merged as Record<string, unknown>)[f] = DEFAULTS[f];
      }
    }
    // Invariant: peopleWarmDays < peopleColdDays. Swap if a user typed the
    // numbers in the wrong order so PeoplePage doesn't render zero
    // "cooling" contacts.
    if (merged.peopleWarmDays >= merged.peopleColdDays) {
      merged.peopleWarmDays = DEFAULTS.peopleWarmDays;
      merged.peopleColdDays = DEFAULTS.peopleColdDays;
    }
    try {
      if (localStorage.getItem(VOICE_MIGRATION_KEY) !== '1') {
        if (merged.voiceName === 'Daniel') merged.voiceName = 'George';
        localStorage.setItem(VOICE_MIGRATION_KEY, '1');
      }
      if (localStorage.getItem(RATE_MIGRATION_KEY) !== '1') {
        // Rate bump: users on the old "slightly slow" 170 or Apple-say
        // default 180 get nudged up to 210 wpm — closer to natural Kokoro
        // pacing without feeling rushed. Users who explicitly picked
        // another rate stay put.
        if (merged.voiceRate === 170 || merged.voiceRate === 180) {
          merged.voiceRate = 210;
        }
        localStorage.setItem(RATE_MIGRATION_KEY, '1');
      }
      if (localStorage.getItem(MODEL_MIGRATION_KEY) !== '1') {
        // Model flip: the old `alfred` openclaw agent carried a WhatsApp
        // "cheerful companion" persona and leaked it into Sunny's chat.
        // Everyone on that default gets moved to the dedicated `sunny`
        // agent we wired up (workspace-sunny/IDENTITY.md carries the
        // British butler voice). Users who picked "stephanie" or a custom
        // agent stay put.
        // Legacy virtual model names — leave empty so the Rust runtime
        // picker selects the best available Ollama model at turn time.
        if (merged.model === 'alfred' || merged.model === 'sunny' || merged.model === 'stephanie') {
          merged.model = '';
        }
        localStorage.setItem(MODEL_MIGRATION_KEY, '1');
      }
    } catch { /* ignore — private mode */ }
    return merged;
  } catch {
    return DEFAULTS;
  }
}

function persistLocal(value: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* quota / private mode — safe to ignore */
  }
}

// Debounce filesystem writes so a text input doesn't hammer disk on every
// keystroke. localStorage is still written synchronously so the in-memory
// state is always durable for web preview.
const FS_DEBOUNCE_MS = 300;
let fsTimer: number | null = null;
let pendingFs: Settings | null = null;
function persistFsDebounced(value: Settings): void {
  if (!isTauri) return;
  pendingFs = value;
  if (fsTimer !== null) window.clearTimeout(fsTimer);
  fsTimer = window.setTimeout(() => {
    fsTimer = null;
    const snapshot = pendingFs;
    pendingFs = null;
    if (snapshot) void invokeSafe('settings_save', { value: snapshot });
  }, FS_DEBOUNCE_MS);
}

// Track whether the user has already mutated settings. The filesystem
// hydration is async, so without this flag a fast click between mount and
// fs-load resolution would be overwritten by the stale fs copy.
let userHasPatched = false;

export const useView = create<State>((set, get) => ({
  view: 'overview',
  settingsOpen: false,
  settings: loadSettingsSync(),
  dockHidden: loadDockHidden(),
  setView: v => set({ view: v }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set(s => ({ settingsOpen: !s.settingsOpen })),
  patchSettings: p => {
    userHasPatched = true;
    const next = { ...get().settings, ...p };
    persistLocal(next);
    persistFsDebounced(next);
    set({ settings: next });
  },
  resetSettings: () => {
    // Replace wholesale with a fresh clone of DEFAULTS so any future
    // mutation of `settings` can't leak into DEFAULT_SETTINGS (it's
    // frozen, but an array field like `customPresets` isn't deeply
    // frozen). Persist to both sinks immediately — the filesystem copy
    // is the authority on reload, and if we only wiped localStorage the
    // fs copy would rehydrate the old values.
    userHasPatched = true;
    const next: Settings = {
      ...DEFAULTS,
      customPresets: [...DEFAULTS.customPresets],
      photosRoots: [...DEFAULTS.photosRoots],
    };
    persistLocal(next);
    persistFsDebounced(next);
    set({ settings: next });
  },
  toggleDock: () => {
    const next = !get().dockHidden;
    persistDockHidden(next);
    set({ dockHidden: next });
  },
  setDockHidden: v => {
    persistDockHidden(v);
    set({ dockHidden: v });
  },
}));

// One-shot filesystem hydration. Source of truth is the fs copy (survives
// WebKit storage resets), but we defer to anything the user has already
// changed since mount — otherwise a quick early click would be clobbered.
if (isTauri) {
  void (async () => {
    const fsValue = await invokeSafe<Partial<Settings> | null>('settings_load');
    if (userHasPatched) return;
    if (fsValue && typeof fsValue === 'object') {
      const merged: Settings = { ...DEFAULTS, ...fsValue };
      persistLocal(merged);
      useView.setState({ settings: merged });
    } else {
      // First launch on this machine — seed the file with current defaults.
      persistFsDebounced(useView.getState().settings);
    }
  })();

  // Re-hydrate from disk when the window regains focus. If the user (or an
  // external script) edited ~/.sunny/settings.json while the app was in the
  // background, a focus/blur cycle picks up the change without needing a
  // relaunch. We suppress the refresh while a debounced fs write is still
  // pending — otherwise we'd race our own save and flap the UI.
  const refreshFromDisk = async (): Promise<void> => {
    if (pendingFs !== null || fsTimer !== null) return;
    const fsValue = await invokeSafe<Partial<Settings> | null>('settings_load');
    if (!fsValue || typeof fsValue !== 'object') return;
    const current = useView.getState().settings;
    const next: Settings = { ...DEFAULTS, ...fsValue };
    // Shallow compare — enough to detect external edits to any scalar /
    // union field. For the two array fields we serialise; the arrays are
    // small (≤3 roots, a handful of presets) so JSON.stringify is cheap.
    const a = JSON.stringify(current);
    const b = JSON.stringify(next);
    if (a === b) return;
    persistLocal(next);
    useView.setState({ settings: next });
  };
  window.addEventListener('focus', () => { void refreshFromDisk(); });
}
