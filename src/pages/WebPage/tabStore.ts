import { create } from 'zustand';
import { invoke, invokeSafe, isTauri, listen } from '../../lib/tauri';
import { BUILTIN_PROFILES } from './profiles';
import type {
  BrowserFetchResult,
  DownloadJob,
  EmbedBounds,
  ProfileId,
  ProfilePolicy,
  RenderMode,
  TabRecord,
  TorStatus,
} from './types';

type ActiveTab = string;

type ClosedTab = { tab: TabRecord; closedAt: number };

type State = {
  // Profile catalogue (synced with the Rust dispatcher).
  profiles: ProfilePolicy[];
  // All open tabs, per profile.
  tabs: TabRecord[];
  activeTabId: ActiveTab | null;
  // Closed-tab stack for Cmd+Shift+T reopen. Size-bounded.
  closedStack: ClosedTab[];
  // Per-profile zoom level (1.0 = 100%).
  zoomByProfile: Record<ProfileId, number>;
  // Cross-cutting UX.
  killSwitch: boolean;
  torStatus: TorStatus | null;
  // Downloads.
  downloads: DownloadJob[];
  // Bounds of the SUNNY content area in logical pixels. When set, the
  // sandbox path prefers the embedded child-webview transport so the
  // live page renders inline. `null` means "UI not mounted yet" and we
  // fall back to a separate OS window.
  sandboxBounds: EmbedBounds | null;

  // ---- actions ----
  hydrate: () => Promise<void>;
  openTab: (profileId: ProfileId, url?: string, renderMode?: RenderMode) => string;
  closeTab: (id: string) => void;
  reopenLastClosed: () => void;
  selectTab: (id: string) => void;
  setRenderMode: (id: string, mode: RenderMode) => void;
  navigate: (id: string, url: string) => Promise<void>;
  goBack: (id: string) => void;
  goForward: (id: string) => void;
  reload: (id: string) => Promise<void>;
  upsertProfile: (policy: ProfilePolicy) => Promise<void>;
  removeProfile: (id: ProfileId) => Promise<void>;
  setKillSwitch: (armed: boolean) => Promise<void>;
  refreshDownloads: () => Promise<void>;
  upsertDownload: (job: DownloadJob) => void;
  bumpZoom: (profileId: ProfileId, delta: number) => void;
  setZoom: (profileId: ProfileId, zoom: number) => void;
  // Embedded-sandbox geometry plumbing. The Web page registers bounds on
  // mount + every resize; the store forwards to the live webview when
  // an embedded sandbox is open. Visibility actions fire on tab-switch
  // and on Web-module enter/leave so the native webview stops painting
  // on top of other modules.
  setSandboxBounds: (bounds: EmbedBounds | null) => void;
  setSandboxVisible: (visible: boolean) => void;
};

// ---------------------------------------------------------------------------
// Session persistence — ONLY for the default profile. Private and Tor
// intentionally drop on quit: persisting their URL list would defeat the
// "no trace" promise. The session is round-tripped through localStorage
// under a versioned key so schema evolution doesn't clobber old data.
// ---------------------------------------------------------------------------

const SESSION_KEY = 'sunny.web.session.v1';
const ZOOM_KEY = 'sunny.web.zoom.v1';
const CLOSED_STACK_MAX = 20;

type PersistedSession = {
  tabs: Array<{ profileId: string; url: string; title: string }>;
  activeTabId: string | null;
};

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistSession(tabs: TabRecord[]): void {
  try {
    const persistable = tabs
      .filter(t => t.profileId === 'default' && t.url.length > 0)
      .map(t => ({ profileId: t.profileId, url: t.url, title: t.title }));
    localStorage.setItem(SESSION_KEY, JSON.stringify({ tabs: persistable, activeTabId: null }));
  } catch {
    /* ignore */
  }
}

function loadZoom(): Record<string, number> {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

function persistZoom(zoomByProfile: Record<string, number>): void {
  try {
    localStorage.setItem(ZOOM_KEY, JSON.stringify(zoomByProfile));
  } catch {
    /* ignore */
  }
}

function makeTabId(): string {
  return `tab_${Math.random().toString(36).slice(2, 10)}`;
}

function initialTab(profileId: ProfileId): TabRecord {
  return {
    id: makeTabId(),
    profileId,
    renderMode: 'reader',
    url: '',
    title: '',
    history: [],
    cursor: -1,
    load: { kind: 'idle' },
  };
}

// Pure URL helpers live in ./urlHelpers so they can be unit-tested
// without booting the store. Re-exported here to preserve the existing
// import surface (tools.sunnyBrowser.ts and UI components import from
// './tabStore').
import { looksLikeUrl, normalizeUrl, searchUrl, hostOf as hostOfImpl, isExtractThin as isExtractThinImpl } from './urlHelpers';
export { looksLikeUrl, searchUrl };

// We fetch through the dispatcher and update the tab's load state. Tokens
// keep stale responses from overwriting newer ones when the user fires
// several navigations in a row.
const tokens = new Map<string, number>();
function nextToken(tabId: string): number {
  const t = (tokens.get(tabId) ?? 0) + 1;
  tokens.set(tabId, t);
  return t;
}
function isCurrentToken(tabId: string, t: number): boolean {
  return tokens.get(tabId) === t;
}

// Hydrate tabs from localStorage on first mount. Only default-profile
// tabs round-trip; private/tor tabs start fresh every session.
const initialTabs: TabRecord[] = (() => {
  const restored = loadSession();
  if (!restored || restored.tabs.length === 0) return [initialTab('default')];
  return restored.tabs.map(persisted => ({
    ...initialTab(persisted.profileId),
    url: persisted.url,
    title: persisted.title,
  }));
})();

export const useTabs = create<State>((set, get) => ({
  profiles: BUILTIN_PROFILES,
  tabs: initialTabs,
  activeTabId: initialTabs[0]?.id ?? null,
  closedStack: [],
  zoomByProfile: loadZoom(),
  killSwitch: false,
  torStatus: null,
  downloads: [],
  sandboxBounds: null,

  hydrate: async () => {
    if (!isTauri) return;
    const [profiles, killSwitch, downloads, torStatus] = await Promise.all([
      invokeSafe<ProfilePolicy[]>('browser_profiles_list', undefined, BUILTIN_PROFILES),
      invokeSafe<boolean>('browser_kill_switch_status', undefined, false),
      invokeSafe<DownloadJob[]>('browser_downloads_list', undefined, []),
      invokeSafe<TorStatus>('browser_tor_status'),
    ]);
    set(state => ({
      profiles: profiles && profiles.length > 0 ? profiles : state.profiles,
      killSwitch: !!killSwitch,
      downloads: downloads ?? [],
      torStatus: torStatus ?? null,
      activeTabId: state.activeTabId ?? state.tabs[0]?.id ?? null,
    }));

    // Listen for sandbox window-close events so the React tab strip
    // stays honest when the user kills the WebView window from its
    // titlebar.
    type SandboxClosed = { tab_id: string };
    void listen<SandboxClosed>('browser:sandbox:closed', payload => {
      const id = payload.tab_id;
      set(s => {
        const next = s.tabs.filter(t => t.id !== id);
        const active =
          s.activeTabId === id ? (next[next.length - 1]?.id ?? null) : s.activeTabId;
        return {
          tabs: next.length > 0 ? next : [initialTab('default')],
          activeTabId: active,
        };
      });
    });

    // Repoll Tor status every 15s so the rail indicator reflects reality
    // when the user brings `tor` up or down outside the app. Cheap — the
    // command only probes 127.0.0.1:9050 with a 1s timeout.
    const pollTor = async () => {
      const s = await invokeSafe<TorStatus>('browser_tor_status');
      set({ torStatus: s ?? null });
    };
    window.setInterval(() => {
      void pollTor();
    }, 15000);

    // Poll sandbox tab URLs every 3s. WKWebView does not fire a navigation
    // event back into the Tauri side we can cheaply listen on, so we ask
    // the Rust side for the current URL of each live sandbox tab and sync
    // the React record. The poll cost is one Tauri IPC per sandbox tab,
    // which is basically free compared to the render budget.
    window.setInterval(() => {
      const s = useTabs.getState();
      for (const t of s.tabs) {
        if (t.renderMode !== 'sandbox') continue;
        void invokeSafe<string | null>('browser_sandbox_current_url', {
          tabId: t.id,
        }).then(url => {
          if (url === null || url === undefined) return;
          if (url === t.url) return;
          useTabs.setState(prev => ({
            tabs: prev.tabs.map(x =>
              x.id === t.id
                ? { ...x, url, title: hostOf(url), load: x.load }
                : x,
            ),
          }));
        });
      }
    }, 3000);
  },

  openTab: (profileId, url, renderMode) => {
    const tab: TabRecord = { ...initialTab(profileId), renderMode: renderMode ?? 'reader' };
    set(s => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    if (url !== undefined && url.length > 0) {
      void get().navigate(tab.id, url);
    }
    return tab.id;
  },

  closeTab: id => {
    set(s => {
      const victim = s.tabs.find(t => t.id === id);
      const next = s.tabs.filter(t => t.id !== id);
      const active =
        s.activeTabId === id ? (next[next.length - 1]?.id ?? null) : s.activeTabId;

      // Stash closable tabs (not private/tor — those vanish) onto the
      // reopen stack so Cmd+Shift+T brings them back for 20 tabs.
      const stash: ClosedTab[] = s.closedStack.slice();
      if (victim && victim.profileId === 'default' && victim.url.length > 0) {
        stash.unshift({ tab: victim, closedAt: Date.now() });
        if (stash.length > CLOSED_STACK_MAX) stash.pop();
      }

      const nextTabs = next.length > 0 ? next : [initialTab('default')];
      persistSession(nextTabs);
      return { tabs: nextTabs, activeTabId: active, closedStack: stash };
    });
    if (isTauri) {
      void invokeSafe('browser_sandbox_close', { tabId: id });
    }
  },

  reopenLastClosed: () => {
    const s = get();
    const last = s.closedStack[0];
    if (!last) return;
    const rest = s.closedStack.slice(1);
    // Fresh tab id — the closed tab's id is stale (sandbox wiped).
    const revived: TabRecord = {
      ...initialTab(last.tab.profileId),
      url: last.tab.url,
      title: last.tab.title,
      renderMode: last.tab.renderMode,
    };
    set({
      tabs: [...s.tabs, revived],
      activeTabId: revived.id,
      closedStack: rest,
    });
    if (last.tab.url.length > 0) {
      void get().navigate(revived.id, last.tab.url);
    }
  },

  selectTab: id => {
    const prev = get().activeTabId;
    set({ activeTabId: id });
    // Only one embedded sandbox webview is visible at a time — the one
    // belonging to the active tab. Everything else sits hidden behind it
    // so the user sees exactly the tab they picked.
    if (isTauri && prev !== id) {
      if (prev) {
        void invokeSafe('browser_sandbox_set_visible', {
          tabId: prev,
          visible: false,
        });
      }
      void invokeSafe('browser_sandbox_set_visible', { tabId: id, visible: true });
      // Snap the newly-active webview to the current content rect in
      // case it moved while hidden (window resized, splitter dragged).
      const b = get().sandboxBounds;
      if (b) {
        void invokeSafe('browser_sandbox_set_bounds', { tabId: id, bounds: b });
      }
    }
  },

  setRenderMode: (id, mode) => {
    set(s => ({
      tabs: s.tabs.map(t => (t.id === id ? { ...t, renderMode: mode } : t)),
    }));
  },

  navigate: async (id, raw) => {
    const next = normalizeUrl(raw);
    if (next.length === 0) return;
    const token = nextToken(id);
    set(s => ({
      tabs: s.tabs.map(t => {
        if (t.id !== id) return t;
        const truncated = t.cursor >= 0 ? t.history.slice(0, t.cursor + 1) : [];
        const appended = [...truncated, { url: next, title: hostOf(next) }];
        // Clear the escalation-latch when moving to a different URL so the
        // thin-extract check runs fresh. Reloads on the same URL keep the
        // latch so we don't bounce back to sandbox after a user-requested
        // reader view.
        const keepLatch = t.lastSandboxEscalationUrl === next;
        return {
          ...t,
          url: next,
          title: hostOf(next),
          history: appended,
          cursor: appended.length - 1,
          load: { kind: 'loading', startedAt: Date.now() },
          lastSandboxEscalationUrl: keepLatch ? t.lastSandboxEscalationUrl : undefined,
        };
      }),
    }));

    const tab = get().tabs.find(t => t.id === id);
    if (!tab) return;

    if (tab.renderMode === 'sandbox') {
      // Hand off to the Rust sandbox module. Prefer the embedded path
      // (child webview pinned over the content area) when we have a
      // rect to pin it to; fall back to a separate OS window if the
      // React UI hasn't measured the content area yet.
      if (isTauri) {
        try {
          const bounds = get().sandboxBounds;
          if (bounds) {
            await invoke('browser_sandbox_open_embedded', {
              profileId: tab.profileId,
              tabId: tab.id,
              url: next,
              bounds,
            });
          } else {
            await invoke('browser_sandbox_open', {
              profileId: tab.profileId,
              tabId: tab.id,
              url: next,
            });
          }
          set(s => ({
            tabs: s.tabs.map(t =>
              t.id === id
                ? {
                    ...t,
                    load: {
                      kind: 'ready',
                      result: {
                        status: 200,
                        ok: true,
                        final_url: next,
                        url: next,
                        extract: {
                          title: hostOf(next),
                          description: '',
                          body_html: '',
                          text: '',
                          favicon_url: '',
                        },
                      },
                      elapsedMs: 0,
                    },
                  }
                : t,
            ),
          }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          set(s => ({
            tabs: s.tabs.map(t =>
              t.id === id ? { ...t, load: { kind: 'error', message: msg } } : t,
            ),
          }));
        }
      }
      return;
    }

    // Reader-mode path.
    const start = Date.now();
    try {
      const result = await invoke<BrowserFetchResult>('browser_fetch_readable', {
        profileId: tab.profileId,
        url: next,
        tabId: tab.id,
      });
      if (!isCurrentToken(id, token)) return;
      const elapsedMs = Date.now() - start;
      set(s => ({
        tabs: s.tabs.map(t => {
          if (t.id !== id) return t;
          const title =
            result.extract.title.trim().length > 0 ? result.extract.title : hostOf(next);
          return {
            ...t,
            title,
            history: t.history.map((h, i) => (i === t.cursor ? { ...h, title } : h)),
            load: { kind: 'ready', result, elapsedMs },
          };
        }),
      }));
      // Persist history (silently skips tor profile in Rust).
      if (isTauri) {
        void invokeSafe('browser_history_push', {
          profileId: tab.profileId,
          title: result.extract.title || hostOf(next),
          url: next,
        });
      }

      // Thin-extract escalation. JS-heavy SPAs (google.com, gmail, twitter,
      // modern dashboards) strip down to a dozen links and zero prose under
      // the reader extractor — useless to the user. When that happens and
      // sandbox mode is available, hand the URL off to the WebView window
      // so they get the real page. The escalation-latch suppresses bouncing
      // when the user then Cmd+J's back to reader on the same URL.
      if (isTauri && isExtractThin(result)) {
        const current = get().tabs.find(t => t.id === id);
        if (current && current.lastSandboxEscalationUrl !== next) {
          try {
            const bounds = get().sandboxBounds;
            if (bounds) {
              await invoke('browser_sandbox_open_embedded', {
                profileId: tab.profileId,
                tabId: tab.id,
                url: next,
                bounds,
              });
            } else {
              await invoke('browser_sandbox_open', {
                profileId: tab.profileId,
                tabId: tab.id,
                url: next,
              });
            }
            set(s => ({
              tabs: s.tabs.map(t =>
                t.id === id
                  ? {
                      ...t,
                      renderMode: 'sandbox',
                      lastSandboxEscalationUrl: next,
                    }
                  : t,
              ),
            }));
          } catch {
            /* Sandbox failed to open — leave the tab in reader mode with
               its thin extract. Better than a half-broken state. */
          }
        }
      }
    } catch (e) {
      if (!isCurrentToken(id, token)) return;
      const msg = e instanceof Error ? e.message : String(e);
      set(s => ({
        tabs: s.tabs.map(t => (t.id === id ? { ...t, load: { kind: 'error', message: msg } } : t)),
      }));
    }
  },

  goBack: id => {
    const tab = get().tabs.find(t => t.id === id);
    if (!tab || tab.cursor <= 0) return;
    const nextCursor = tab.cursor - 1;
    const entry = tab.history[nextCursor];
    if (!entry) return;
    set(s => ({
      tabs: s.tabs.map(t =>
        t.id === id ? { ...t, cursor: nextCursor, url: entry.url, title: entry.title } : t,
      ),
    }));
    void get().navigate(id, entry.url);
  },

  goForward: id => {
    const tab = get().tabs.find(t => t.id === id);
    if (!tab || tab.cursor < 0 || tab.cursor >= tab.history.length - 1) return;
    const nextCursor = tab.cursor + 1;
    const entry = tab.history[nextCursor];
    if (!entry) return;
    set(s => ({
      tabs: s.tabs.map(t =>
        t.id === id ? { ...t, cursor: nextCursor, url: entry.url, title: entry.title } : t,
      ),
    }));
    void get().navigate(id, entry.url);
  },

  reload: async id => {
    const tab = get().tabs.find(t => t.id === id);
    if (!tab || tab.url.length === 0) return;
    await get().navigate(id, tab.url);
  },

  upsertProfile: async policy => {
    await invokeSafe('browser_profiles_upsert', { policy });
    set(s => {
      const without = s.profiles.filter(p => p.id !== policy.id);
      return { profiles: [...without, policy] };
    });
  },

  removeProfile: async id => {
    if (['default', 'private', 'tor'].includes(id)) return; // built-ins are non-removable
    await invokeSafe('browser_profiles_remove', { id });
    set(s => ({
      profiles: s.profiles.filter(p => p.id !== id),
      tabs: s.tabs.map(t => (t.profileId === id ? { ...t, profileId: 'default' } : t)),
    }));
  },

  setKillSwitch: async armed => {
    await invokeSafe('browser_kill_switch', { armed });
    set({ killSwitch: armed });
  },

  refreshDownloads: async () => {
    const jobs = await invokeSafe<DownloadJob[]>('browser_downloads_list', undefined, []);
    set({ downloads: jobs ?? [] });
  },

  upsertDownload: job => {
    set(s => {
      const without = s.downloads.filter(j => j.id !== job.id);
      return { downloads: [job, ...without] };
    });
  },

  bumpZoom: (profileId, delta) => {
    const s = get();
    const current = s.zoomByProfile[profileId] ?? 1.0;
    const next = Math.max(0.5, Math.min(2.5, +(current + delta).toFixed(2)));
    const map = { ...s.zoomByProfile, [profileId]: next };
    persistZoom(map);
    set({ zoomByProfile: map });
  },

  setZoom: (profileId, zoom) => {
    const clamped = Math.max(0.5, Math.min(2.5, +zoom.toFixed(2)));
    const s = get();
    const map = { ...s.zoomByProfile, [profileId]: clamped };
    persistZoom(map);
    set({ zoomByProfile: map });
  },

  setSandboxBounds: bounds => {
    const prev = get().sandboxBounds;
    set({ sandboxBounds: bounds });
    if (!isTauri || !bounds) return;
    // Skip redundant IPC when the rect hasn't meaningfully changed. A
    // ResizeObserver fires on every layout tick; rounding to a pixel
    // both collapses jitter and keeps the native webview from re-
    // layouting on every React microtask.
    if (
      prev &&
      Math.round(prev.x) === Math.round(bounds.x) &&
      Math.round(prev.y) === Math.round(bounds.y) &&
      Math.round(prev.width) === Math.round(bounds.width) &&
      Math.round(prev.height) === Math.round(bounds.height)
    ) {
      return;
    }
    const activeId = get().activeTabId;
    if (activeId) {
      void invokeSafe('browser_sandbox_set_bounds', { tabId: activeId, bounds });
    }
  },

  setSandboxVisible: visible => {
    if (!isTauri) return;
    // Walk every live sandbox tab — the frontend can't easily know which
    // ones are embedded vs windowed, so we hand it to the Rust side and
    // let `set_visible` no-op for windowed tabs.
    for (const t of get().tabs) {
      if (t.renderMode !== 'sandbox') continue;
      void invokeSafe('browser_sandbox_set_visible', {
        tabId: t.id,
        visible: visible && t.id === get().activeTabId,
      });
    }
  },
}));

// Persist session on every tab change. Debounced via a microtask so
// rapid-fire navigations don't thrash localStorage.
let sessionPersistQueued = false;
useTabs.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  if (sessionPersistQueued) return;
  sessionPersistQueued = true;
  queueMicrotask(() => {
    sessionPersistQueued = false;
    persistSession(useTabs.getState().tabs);
  });
});

// Local aliases to the pure helpers so the rest of this module's code
// reads naturally (most callers just want `hostOf` / `isExtractThin`).
const hostOf = hostOfImpl;
const isExtractThin = isExtractThinImpl;

export { normalizeUrl, hostOf };
