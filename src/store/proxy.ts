// Per-contact AI proxy configuration.
//
// A "proxy" lets SUNNY automatically draft (or auto-send) replies on the user's
// behalf for a specific contact. State is persisted to localStorage so the
// toggle survives reloads. A global `enabled` flag acts as a kill-switch that
// disables every proxy regardless of individual state — used by the red
// "PAUSE PROXY" button on the Contacts page.
//
// Design notes:
//
// - We do NOT store conversation history here. Drafts/inbox live in
//   `src/store/proxyInbox.ts` so the heavy per-message state doesn't churn
//   this config store on every incoming message.
// - Auto-send requires BOTH `enabled` and `autoSend`. A user can safely flip
//   a proxy on in draft-only mode (the default) without risking a runaway
//   sender.
// - Rate limit metadata (`lastSentAt`) is persisted here so the engine's 30s
//   gate survives app restarts.

import { create } from 'zustand';

const STORAGE_KEY = 'sunny.contacts.proxy.v1';
const GLOBAL_KEY = 'sunny.contacts.proxy.global.v1';

export type ProxyConfig = Readonly<{
  /** chat_identifier (phone / email / chat<id>) */
  handle: string;
  /** Human-friendly label shown in UI. */
  display: string;
  /** Per-contact on/off. */
  enabled: boolean;
  /** Freeform persona prompt — prepended to the agent goal. */
  persona: string;
  /** When true, SUNNY sends without a ConfirmGate per message. Off by default. */
  autoSend: boolean;
  /** Optional active hours; outside the window the proxy stays in draft mode. */
  allowedHours?: { readonly from: number; readonly to: number };
  /** Last SQLite ROWID we've seen for this chat; poll watermark. */
  lastSeenRowid?: number;
  /** Epoch ms of the last auto-sent message — for the 30s rate limit. */
  lastSentAt?: number;
  /**
   * Epoch ms when this proxy was most recently turned on. The engine uses
   * this as a hard floor on incoming message `ts` so that enabling a proxy
   * never drafts replies to messages that were already sitting in the
   * inbox from before the user switched it on.
   */
  enabledAt?: number;
  /**
   * Epoch ms until which the proxy is silenced. `enabled` can stay on so
   * the UI still shows the configured persona, but no drafts will be
   * produced until wall-clock time passes this value. Used by "PAUSE 1H".
   */
  mutedUntil?: number;
}>;

export const DEFAULT_PERSONA =
  'Reply casually and briefly, as me. Ask a clarifying question if the message is ambiguous. Never invent facts about my schedule.';

type ProxyState = {
  readonly configs: ReadonlyArray<ProxyConfig>;
  readonly globalEnabled: boolean;
  readonly upsert: (patch: Partial<ProxyConfig> & Pick<ProxyConfig, 'handle' | 'display'>) => void;
  readonly remove: (handle: string) => void;
  readonly setGlobalEnabled: (enabled: boolean) => void;
  readonly setLastSeen: (handle: string, rowid: number) => void;
  readonly markAutoSent: (handle: string) => void;
  /** Silence drafts until `untilMs`. Pass 0 to clear. */
  readonly muteUntil: (handle: string, untilMs: number) => void;
};

export const useProxy = create<ProxyState>((set, get) => ({
  configs: loadConfigs(),
  globalEnabled: loadGlobalEnabled(),
  upsert: patch => {
    set(state => {
      const idx = state.configs.findIndex(c => c.handle === patch.handle);
      const existing = idx >= 0 ? state.configs[idx] : undefined;
      const nextEnabled = patch.enabled ?? existing?.enabled ?? false;
      const wasEnabled = existing?.enabled ?? false;
      // When the proxy flips from off → on, stamp `enabledAt`. The engine
      // uses this as a hard floor on incoming `ts` so we never draft a
      // reply for a message that was already in the inbox before the user
      // switched the proxy on. Also clear any active mute — turning on a
      // muted proxy should be an un-mute.
      const justEnabled = !wasEnabled && nextEnabled;
      const nextEnabledAt = justEnabled
        ? Date.now()
        : patch.enabledAt ?? existing?.enabledAt;
      const nextMutedUntil = justEnabled
        ? undefined
        : patch.mutedUntil !== undefined
          ? patch.mutedUntil || undefined
          : existing?.mutedUntil;
      const next: ProxyConfig = {
        handle: patch.handle,
        display: patch.display,
        enabled: nextEnabled,
        persona: patch.persona ?? existing?.persona ?? DEFAULT_PERSONA,
        autoSend: patch.autoSend ?? existing?.autoSend ?? false,
        allowedHours: patch.allowedHours ?? existing?.allowedHours,
        lastSeenRowid: patch.lastSeenRowid ?? existing?.lastSeenRowid,
        lastSentAt: patch.lastSentAt ?? existing?.lastSentAt,
        enabledAt: nextEnabledAt,
        mutedUntil: nextMutedUntil,
      };
      const configs = idx >= 0
        ? state.configs.map((c, i) => (i === idx ? next : c))
        : [...state.configs, next];
      persistConfigs(configs);
      return { configs };
    });
  },
  remove: handle => {
    set(state => {
      const configs = state.configs.filter(c => c.handle !== handle);
      persistConfigs(configs);
      return { configs };
    });
  },
  setGlobalEnabled: enabled => {
    persistGlobalEnabled(enabled);
    set({ globalEnabled: enabled });
  },
  setLastSeen: (handle, rowid) => {
    const cfg = get().configs.find(c => c.handle === handle);
    if (!cfg) return;
    if (cfg.lastSeenRowid !== undefined && cfg.lastSeenRowid >= rowid) return;
    get().upsert({ handle, display: cfg.display, lastSeenRowid: rowid });
  },
  markAutoSent: handle => {
    const cfg = get().configs.find(c => c.handle === handle);
    if (!cfg) return;
    get().upsert({ handle, display: cfg.display, lastSentAt: Date.now() });
  },
  muteUntil: (handle, untilMs) => {
    const cfg = get().configs.find(c => c.handle === handle);
    if (!cfg) return;
    get().upsert({
      handle,
      display: cfg.display,
      mutedUntil: untilMs > 0 ? untilMs : 0,
    });
  },
}));

/** Pure helper — active iff per-contact enabled, global not paused, and not muted. */
export function isProxyActive(cfg: ProxyConfig | undefined, globalEnabled: boolean): boolean {
  if (!cfg || !cfg.enabled || !globalEnabled) return false;
  if (cfg.mutedUntil && cfg.mutedUntil > Date.now()) return false;
  if (!cfg.allowedHours) return true;
  const hour = new Date().getHours();
  const { from, to } = cfg.allowedHours;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

function loadConfigs(): ReadonlyArray<ProxyConfig> {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProxyConfig);
  } catch (e) {
    console.error('Failed to load proxy configs:', e);
    return [];
  }
}

function persistConfigs(configs: ReadonlyArray<ProxyConfig>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  } catch (e) {
    console.error('Failed to persist proxy configs:', e);
  }
}

function loadGlobalEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    const raw = localStorage.getItem(GLOBAL_KEY);
    if (raw === null) return true;
    return raw === '1';
  } catch {
    return true;
  }
}

function persistGlobalEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(GLOBAL_KEY, enabled ? '1' : '0');
  } catch (e) {
    console.error('Failed to persist proxy kill switch:', e);
  }
}

function isProxyConfig(v: unknown): v is ProxyConfig {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.handle === 'string' &&
    typeof r.display === 'string' &&
    typeof r.enabled === 'boolean' &&
    typeof r.persona === 'string' &&
    typeof r.autoSend === 'boolean'
  );
}
