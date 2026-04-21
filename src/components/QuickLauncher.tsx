import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { NAV_MODULES } from '../data/seeds';
import { NavIcon } from './NavIcons';
import { useView, type ViewKey } from '../store/view';
import { invokeSafe, isTauri } from '../lib/tauri';
import { askSunny } from '../lib/askSunny';
import {
  ASYNC_DEBOUNCE_MS,
  buildAskHits,
  buildSettingsHits,
  buildToolHits,
  dispatchSettingsJump,
  fetchMemoryHits,
  fetchSkillHits,
  type AskHit,
  type MemoryHit,
  type SettingsHit,
  type SkillHit,
  type ToolHit,
} from './CommandBar/hits';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GroupKind =
  | 'MODULES'
  | 'APPS'
  | 'AGENT'
  | 'FILES'
  | 'TOOLS'
  | 'MEMORIES'
  | 'SKILLS'
  | 'ASK'
  | 'SETTINGS';

type AppEntry = { readonly name: string; readonly path: string };
type FsEntry = {
  readonly name: string;
  readonly path: string;
  readonly is_dir: boolean;
  readonly size: number;
  readonly modified_secs: number;
};

type ModuleHit = {
  readonly kind: 'MODULES';
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly badge: string | undefined;
  readonly target: ViewKey;
  readonly score: number;
};

type AppHit = {
  readonly kind: 'APPS';
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly score: number;
};

type AgentHit = {
  readonly kind: 'AGENT';
  readonly id: string;
  readonly label: string;
  readonly goal: string;
  readonly score: number;
};

type FileHit = {
  readonly kind: 'FILES';
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly score: number;
};

type Hit =
  | ModuleHit
  | AppHit
  | AgentHit
  | FileHit
  | ToolHit
  | MemoryHit
  | SkillHit
  | AskHit
  | SettingsHit;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LABEL_TO_VIEW: Record<string, ViewKey> = {
  OVERVIEW: 'overview',
  FILES: 'files',
  APPS: 'apps',
  AUTO: 'auto',
  CALENDAR: 'calendar',
  SCREEN: 'screen',
  CONTACTS: 'contacts',
  MEMORY: 'memory',
  WEB: 'web',
  SCAN: 'scan',
  SETTINGS: 'settings',
  VAULT: 'vault',
};

const MAX_MODULES = 3;
const MAX_APPS = 6;
const MAX_AGENT = 3;
const MAX_FILES = 6;

// ASK slots first so an explicit "?foo" puts the quick-ask right at the top
// for a default Enter. SETTINGS / TOOLS / MEMORIES / SKILLS trail the
// filesystem so the palette still feels "spotlight-y" for common nav.
const GROUP_ORDER: readonly GroupKind[] = [
  'ASK',
  'MODULES',
  'APPS',
  'AGENT',
  'TOOLS',
  'FILES',
  'SETTINGS',
  'MEMORIES',
  'SKILLS',
];

const AGENT_EVENT = 'sunny://agent/run';

/** Fire a recursive `fs_search` walk once the query is substantive. */
const DEEP_SEARCH_MIN_LEN = 2;
const DEEP_SEARCH_DEBOUNCE_MS = 220;
const DEEP_SEARCH_MAX_RESULTS = 40;

// ---------------------------------------------------------------------------
// Scoring — subsequence + contains + position weighting. No external library.
// ---------------------------------------------------------------------------

function scoreMatch(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = candidate.toLowerCase();

  // Exact hit — highest tier.
  if (t === q) return 1000;

  // Prefix match — second tier.
  if (t.startsWith(q)) return 600 - Math.min(t.length, 100);

  // Contains match — third tier, earlier position wins.
  const idx = t.indexOf(q);
  if (idx >= 0) return 400 - idx * 4;

  // Subsequence match — last tier, earliest first-char wins and tight runs
  // score higher than spread-out ones.
  let i = 0;
  let firstIdx = -1;
  let spread = 0;
  let lastIdx = -1;
  for (let p = 0; p < t.length; p += 1) {
    if (t[p] === q[i]) {
      if (firstIdx === -1) firstIdx = p;
      if (lastIdx !== -1) spread += p - lastIdx - 1;
      lastIdx = p;
      i += 1;
      if (i === q.length) {
        return 200 - firstIdx * 2 - spread;
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// APPS cache — module-scope so remounts reuse the same lookup. The in-flight
// promise is also memoised so rapid open/close doesn't trigger duplicate IPC.
// ---------------------------------------------------------------------------

let APPS_CACHE: ReadonlyArray<AppEntry> | null = null;
let APPS_INFLIGHT: Promise<ReadonlyArray<AppEntry> | null> | null = null;

async function fetchApps(): Promise<ReadonlyArray<AppEntry> | null> {
  if (APPS_CACHE !== null) return APPS_CACHE;
  if (APPS_INFLIGHT !== null) return APPS_INFLIGHT;
  APPS_INFLIGHT = (async () => {
    const list = await invokeSafe<AppEntry[]>('list_apps');
    if (list !== null) APPS_CACHE = list;
    APPS_INFLIGHT = null;
    return list;
  })();
  return APPS_INFLIGHT;
}

// ---------------------------------------------------------------------------
// QuickLauncher component
// ---------------------------------------------------------------------------

export function QuickLauncher() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [apps, setApps] = useState<ReadonlyArray<AppEntry> | null>(null);
  const [files, setFiles] = useState<ReadonlyArray<FsEntry>>([]);
  const [deepFiles, setDeepFiles] = useState<ReadonlyArray<FsEntry>>([]);
  const [memoryHits, setMemoryHits] = useState<ReadonlyArray<MemoryHit>>([]);
  const [skillHits, setSkillHits] = useState<ReadonlyArray<SkillHit>>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const deepSearchTokenRef = useRef(0);
  const asyncTokenRef = useRef(0);

  // ---- Data fetch (once per mount) --------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await fetchApps();
      if (!cancelled) setApps(list);
    })();

    if (isTauri) {
      void (async () => {
        const entries = await invokeSafe<FsEntry[]>('fs_list', { path: '~' });
        if (cancelled) return;
        if (entries !== null) setFiles(entries);
      })();
    }

    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Global keydown: toggle on ⌘K / Ctrl+K, close on Escape -----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        // Skip if the user is typing in an input that ISN'T ours. Our own
        // input is detected via ref equality so ⌘K still closes while focused
        // inside the launcher.
        const tgt = e.target as HTMLElement | null;
        const isOurs = tgt === inputRef.current;
        const isTyping =
          tgt instanceof HTMLInputElement ||
          tgt instanceof HTMLTextAreaElement ||
          (tgt?.isContentEditable ?? false);
        if (isTyping && !isOurs) return;
        e.preventDefault();
        setOpen(prev => !prev);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // ---- External triggers (menu bar tray, app menu, etc.) ----------------
  // The tray's "Quick Launcher…" item fires an `sunny-ql-open` window event
  // so it can open us without having to simulate a keyboard shortcut.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onToggle = () => setOpen(prev => !prev);
    window.addEventListener('sunny-ql-open', onOpen);
    window.addEventListener('sunny-ql-toggle', onToggle);
    return () => {
      window.removeEventListener('sunny-ql-open', onOpen);
      window.removeEventListener('sunny-ql-toggle', onToggle);
    };
  }, []);

  // ---- Reset transient state on close -----------------------------------
  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(0);
      setDeepFiles([]);
      setMemoryHits([]);
      setSkillHits([]);
    }
  }, [open]);

  // ---- Async hits (memory search + skill list), debounced -------------
  // Both are fetched off the same token so a rapid-type burst never
  // leaves a stale slow fetch overwriting a newer fast one.
  useEffect(() => {
    if (!open || !isTauri) return;
    const q = query.trim();
    if (q.length === 0) {
      setMemoryHits([]);
      setSkillHits([]);
      return;
    }
    const token = ++asyncTokenRef.current;
    const timer = window.setTimeout(async () => {
      const [mem, sk] = await Promise.all([fetchMemoryHits(q), fetchSkillHits(q)]);
      if (token !== asyncTokenRef.current) return;
      setMemoryHits(mem);
      setSkillHits(sk);
    }, ASYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  // ---- Deep file search (debounced, recursive under $HOME) --------------
  // The shallow `fs_list('~')` fetch handled by the effect above only shows
  // top-level children of $HOME. As soon as the user types two or more
  // characters, fire a recursive `fs_search` so files anywhere in the
  // home tree become reachable from ⌘K without having to drill through
  // the FILES module first. Debounced + tokenised so only the latest
  // query's results ever land in state.
  useEffect(() => {
    if (!open || !isTauri) return;
    const q = query.trim();
    if (q.length < DEEP_SEARCH_MIN_LEN) {
      setDeepFiles([]);
      return;
    }
    const token = ++deepSearchTokenRef.current;
    const timer = window.setTimeout(async () => {
      const hits = await invokeSafe<FsEntry[]>('fs_search', {
        root: '~',
        query: q,
        maxResults: DEEP_SEARCH_MAX_RESULTS,
        maxVisited: 20_000,
      });
      if (token !== deepSearchTokenRef.current) return;
      setDeepFiles(hits ?? []);
    }, DEEP_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  // ---- Autofocus the input on open --------------------------------------
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // ---- Compute hits per group -------------------------------------------
  const moduleHits = useMemo<ReadonlyArray<ModuleHit>>(() => {
    const scored = NAV_MODULES.map(m => {
      const s = scoreMatch(query, m.label);
      return {
        kind: 'MODULES' as const,
        id: `mod.${m.label}`,
        label: m.label,
        icon: m.icon,
        badge: m.badge ?? '',
        target: LABEL_TO_VIEW[m.label] ?? 'overview',
        score: s,
      };
    }).filter(h => h.score > 0);
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_MODULES);
  }, [query]);

  const appHits = useMemo<ReadonlyArray<AppHit>>(() => {
    if (apps === null) return [];
    const scored = apps.map(a => ({
      kind: 'APPS' as const,
      id: `app.${a.path}`,
      label: a.name,
      path: a.path,
      score: scoreMatch(query, a.name),
    })).filter(h => h.score > 0);
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_APPS);
  }, [apps, query]);

  const agentHits = useMemo<ReadonlyArray<AgentHit>>(() => {
    const q = query.trim();
    if (!q) return [];
    // Single agent suggestion (shown 1-3 times is overkill — we just surface
    // one canonical entry with a score so it slots into Tab cycling).
    const hit: AgentHit = {
      kind: 'AGENT',
      id: `agent.${q}`,
      label: `Ask SUNNY: "${q}"`,
      goal: q,
      score: 300,
    };
    return [hit].slice(0, MAX_AGENT);
  }, [query]);

  const toolHits = useMemo<ReadonlyArray<ToolHit>>(() => buildToolHits(query), [query]);
  const askHits = useMemo<ReadonlyArray<AskHit>>(() => buildAskHits(query), [query]);
  const settingsHits = useMemo<ReadonlyArray<SettingsHit>>(
    () => buildSettingsHits(query),
    [query],
  );

  const fileHits = useMemo<ReadonlyArray<FileHit>>(() => {
    if (!isTauri) return [];
    // Merge the shallow `~` listing with the recursive search hits.
    // Dedupe by path; a deep-search hit (likely a better match) replaces
    // the shallow entry when both are present.
    const byPath = new Map<string, FsEntry>();
    for (const f of files) byPath.set(f.path, f);
    for (const f of deepFiles) byPath.set(f.path, f);
    if (byPath.size === 0) return [];
    const scored = Array.from(byPath.values()).map(f => ({
      kind: 'FILES' as const,
      id: `file.${f.path}`,
      label: f.name,
      path: f.path,
      score: scoreMatch(query, f.name),
    })).filter(h => h.score > 0);
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_FILES);
  }, [files, deepFiles, query]);

  // Flat visible list — keeps group order for index-based keyboard nav.
  const visible = useMemo<ReadonlyArray<Hit>>(() => {
    const out: Hit[] = [];
    for (const g of GROUP_ORDER) {
      if (g === 'ASK') out.push(...askHits);
      else if (g === 'MODULES') out.push(...moduleHits);
      else if (g === 'APPS') out.push(...appHits);
      else if (g === 'AGENT') out.push(...agentHits);
      else if (g === 'TOOLS') out.push(...toolHits);
      else if (g === 'FILES') out.push(...fileHits);
      else if (g === 'SETTINGS') out.push(...settingsHits);
      else if (g === 'MEMORIES') out.push(...memoryHits);
      else if (g === 'SKILLS') out.push(...skillHits);
    }
    return out;
  }, [
    askHits,
    moduleHits,
    appHits,
    agentHits,
    toolHits,
    fileHits,
    settingsHits,
    memoryHits,
    skillHits,
  ]);

  // Group index — first visible index per group, for Tab cycling.
  const groupStarts = useMemo<ReadonlyMap<GroupKind, number>>(() => {
    const map = new Map<GroupKind, number>();
    visible.forEach((h, i) => {
      if (!map.has(h.kind)) map.set(h.kind, i);
    });
    return map;
  }, [visible]);

  // Keep selected cursor within bounds when the list shrinks.
  useEffect(() => {
    setSelected(s => {
      if (visible.length === 0) return 0;
      if (s >= visible.length) return visible.length - 1;
      return s;
    });
  }, [visible.length]);

  // ---- Actions -----------------------------------------------------------

  const setView = useView.getState().setView;

  const activate = useCallback(
    (hit: Hit, modifiers?: { readonly reveal?: boolean }) => {
      if (hit.kind === 'MODULES') {
        useView.getState().setView(hit.target);
        setOpen(false);
        return;
      }
      if (hit.kind === 'APPS') {
        if (modifiers?.reveal) {
          // ⌘↵ on an app reveals the .app bundle in Finder instead of launching.
          void invokeSafe('finder_reveal', { path: hit.path });
        } else {
          void invokeSafe('open_app', { name: hit.label });
        }
        setOpen(false);
        return;
      }
      if (hit.kind === 'AGENT') {
        // Dispatch a CustomEvent that CommandBar (or any other listener) can
        // react to. Contract: type=sunny://agent/run, detail={ goal: string }.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(AGENT_EVENT, { detail: { goal: hit.goal } }),
          );
        }
        setOpen(false);
        return;
      }
      if (hit.kind === 'TOOLS') {
        // ⌘↵ copies the tool name only; plain ↵ drops a /tool stub into
        // the chat pipeline via askSunny so the user can fill arguments.
        if (modifiers?.reveal) {
          void navigator.clipboard?.writeText(hit.tool);
        } else {
          askSunny(`/tool ${hit.tool}`, 'quick-launcher');
        }
        setOpen(false);
        return;
      }
      if (hit.kind === 'ASK') {
        askSunny(hit.prompt, 'quick-launcher');
        setOpen(false);
        return;
      }
      if (hit.kind === 'MEMORIES') {
        askSunny(hit.prompt, 'quick-launcher');
        setOpen(false);
        return;
      }
      if (hit.kind === 'SKILLS') {
        useView.getState().setView('skills');
        setOpen(false);
        return;
      }
      if (hit.kind === 'SETTINGS') {
        useView.getState().setView('settings');
        dispatchSettingsJump(hit.tab);
        setOpen(false);
        return;
      }
      // FILES — ⌘↵ reveals in Finder instead of opening.
      if (modifiers?.reveal) {
        void invokeSafe('fs_reveal', { path: hit.path });
      } else {
        void invokeSafe('open_path', { path: hit.path });
      }
      setOpen(false);
    },
    // setView is referenced via getState() — no dependency needed, but we
    // include it for clarity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  void setView;

  // ---- Input keyboard handler (our own field) ---------------------------

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected(s => (visible.length === 0 ? 0 : (s + 1) % visible.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected(s =>
          visible.length === 0 ? 0 : (s - 1 + visible.length) % visible.length,
        );
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (visible.length === 0) return;
        // Find the current group, jump to the start of the next populated
        // group (wrapping).
        const current = visible[selected]?.kind ?? visible[0].kind;
        const order = GROUP_ORDER.filter(g => groupStarts.has(g));
        const idx = order.indexOf(current);
        const nextIdx = e.shiftKey
          ? (idx - 1 + order.length) % order.length
          : (idx + 1) % order.length;
        const nextGroup = order[nextIdx];
        const start = groupStarts.get(nextGroup);
        if (typeof start === 'number') setSelected(start);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const hit = visible[selected];
        if (hit) activate(hit, { reveal: e.metaKey || e.ctrlKey });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    },
    [visible, selected, groupStarts, activate],
  );

  if (!open) return null;

  const showAppsGroup = apps !== null;

  return (
    <div
      style={backdropStyle}
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Quick launcher"
    >
      <div style={cardStyle} onClick={e => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={headerTitleStyle}>SPOTLIGHT</span>
          <span style={headerKbdStyle}>⌘K</span>
        </div>
        {/* Screen-reader live region: announces result count on query change */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{ position: 'absolute', left: -9999, top: -9999, width: 1, height: 1, overflow: 'hidden' }}
        >
          {visible.length > 0 ? `${visible.length} result${visible.length === 1 ? '' : 's'}` : (query.trim() ? 'No results' : '')}
        </div>

        <input
          ref={inputRef}
          type="text"
          placeholder="Search modules · apps · files · tools · settings  (prefix ? to ask)"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          style={inputStyle}
          autoComplete="off"
          spellCheck={false}
          aria-label="Quick launcher search"
          aria-autocomplete="list"
          aria-controls="ql-listbox"
          aria-activedescendant={visible.length > 0 ? `ql-item-${selected}` : undefined}
        />

        <div id="ql-listbox" style={listStyle} role="listbox" aria-label="Quick launcher results">
          {visible.length === 0 ? (
            <div style={emptyStyle}>
              {query.trim() ? `No matches for "${query}".` : 'Type to search.'}
            </div>
          ) : (
            GROUP_ORDER.map(group => {
              if (group === 'APPS' && !showAppsGroup) return null;
              const items: ReadonlyArray<Hit> =
                group === 'MODULES'   ? moduleHits
                : group === 'APPS'    ? appHits
                : group === 'AGENT'   ? agentHits
                : group === 'TOOLS'   ? toolHits
                : group === 'FILES'   ? fileHits
                : group === 'ASK'     ? askHits
                : group === 'MEMORIES'? memoryHits
                : group === 'SKILLS'  ? skillHits
                : /* SETTINGS */        settingsHits;
              if (items.length === 0) return null;
              const baseIdx = groupStarts.get(group) ?? 0;
              return (
                <div key={group}>
                  <div style={sectionStyle}>{group}</div>
                  {items.map((hit, i) => {
                    const flatIdx = baseIdx + i;
                    const active = flatIdx === selected;
                    return (
                      <button
                        key={hit.id}
                        id={`ql-item-${flatIdx}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        style={itemStyle(active)}
                        onMouseEnter={() => setSelected(flatIdx)}
                        onClick={e => activate(hit, { reveal: e.metaKey || e.ctrlKey })}
                      >
                        <span style={iconStyle}>{renderHitIcon(hit)}</span>
                        <span style={labelStyle}>{hit.label}</span>
                        <span style={tagStyle(active)}>{hit.kind}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div style={footStyle}>
          <span>↑↓ navigate</span>
          <span>⇥ group</span>
          <span>↵ open</span>
          <span>⌘↵ reveal</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny inline glyphs (keep deps out of this file)
// ---------------------------------------------------------------------------

function renderHitIcon(hit: Hit) {
  switch (hit.kind) {
    case 'MODULES':  return <NavIcon name={hit.icon} />;
    case 'APPS':     return <GlyphApp />;
    case 'AGENT':    return <GlyphAgent />;
    case 'TOOLS':    return <GlyphTool />;
    case 'FILES':    return <GlyphFile />;
    case 'ASK':      return <GlyphAgent />;
    case 'MEMORIES': return <GlyphMemory />;
    case 'SKILLS':   return <GlyphSkill />;
    case 'SETTINGS': return <GlyphSettings />;
  }
}

function GlyphApp() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" />
    </svg>
  );
}

function GlyphAgent() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
      <circle cx="8" cy="8" r="6" />
      <path d="M5 8h6M8 5v6" />
    </svg>
  );
}

function GlyphFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
      <path d="M4 2h6l2 2v10H4z" />
      <path d="M10 2v3h2" />
    </svg>
  );
}

function GlyphTool() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
      <path d="M11 2.5l2.5 2.5L8 10.5 5.5 8z" />
      <path d="M5 8l-3 3 2 2 3-3" />
    </svg>
  );
}

function GlyphMemory() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
      <path d="M3 5c0-1.5 1-2.5 2.5-2.5S8 3.5 8 5s1 2.5 2.5 2.5S13 6.5 13 5" />
      <path d="M3 5v6c0 1.5 1 2.5 2.5 2.5S8 12.5 8 11s1-2.5 2.5-2.5S13 9.5 13 11" />
    </svg>
  );
}

function GlyphSkill() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
      <path d="M8 2l1.8 3.8L14 6.5l-3 2.9.8 4.1L8 11.6 4.2 13.5 5 9.4 2 6.5l4.2-.7z" />
    </svg>
  );
}

function GlyphSettings() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styles — HUD theme, inline for ownership isolation. No global CSS edits.
// ---------------------------------------------------------------------------

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: 'rgba(4, 10, 14, 0.72)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '14vh',
};

const cardStyle: CSSProperties = {
  width: 560,
  maxWidth: 'calc(100vw - 48px)',
  maxHeight: 520,
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(5, 15, 22, 0.96)',
  border: '1px solid var(--line-soft)',
  boxShadow: '0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(57, 229, 255, 0.18)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  position: 'relative',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '10px 14px',
  borderBottom: '1px solid var(--line-soft)',
  background: 'linear-gradient(90deg, rgba(57, 229, 255, 0.12), transparent)',
};

const headerTitleStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 11,
  letterSpacing: '0.32em',
  color: 'var(--cyan)',
  fontWeight: 800,
};

const headerKbdStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  letterSpacing: '0.1em',
  color: 'var(--ink-dim)',
};

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(4, 10, 16, 0.7)',
  color: 'var(--ink)',
  border: 0,
  borderBottom: '1px solid var(--line-soft)',
  padding: '13px 14px',
  outline: 'none',
  fontFamily: 'var(--mono)',
  fontSize: 13,
  letterSpacing: '0.1em',
};

const listStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '4px 0',
  minHeight: 120,
};

const sectionStyle: CSSProperties = {
  padding: '8px 14px 4px',
  fontFamily: 'var(--display)',
  fontSize: 9.5,
  letterSpacing: '0.28em',
  color: 'var(--cyan)',
  fontWeight: 700,
};

const emptyStyle: CSSProperties = {
  padding: '18px 14px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink-dim)',
};

function itemStyle(active: boolean): CSSProperties {
  return {
    all: 'unset',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    boxSizing: 'border-box',
    padding: '9px 14px',
    cursor: 'pointer',
    fontFamily: 'var(--mono)',
    fontSize: 12.5,
    color: active ? '#fff' : 'var(--ink)',
    borderLeft: `2px solid ${active ? 'var(--cyan)' : 'transparent'}`,
    background: active ? 'rgba(57, 229, 255, 0.12)' : 'transparent',
  };
}

const iconStyle: CSSProperties = {
  display: 'inline-flex',
  width: 16,
  height: 16,
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--cyan)',
  flexShrink: 0,
};

const labelStyle: CSSProperties = {
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  letterSpacing: '0.02em',
};

function tagStyle(active: boolean): CSSProperties {
  return {
    fontFamily: 'var(--display)',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.25em',
    padding: '2px 7px',
    border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-soft)'}`,
    color: active ? '#fff' : 'var(--cyan)',
    background: active ? 'rgba(57, 229, 255, 0.22)' : 'rgba(57, 229, 255, 0.05)',
    flexShrink: 0,
  };
}

const footStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  justifyContent: 'flex-end',
  padding: '7px 14px',
  borderTop: '1px solid var(--line-soft)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  letterSpacing: '0.08em',
};
