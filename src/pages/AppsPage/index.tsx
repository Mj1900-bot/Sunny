import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import { ModuleView } from '../../components/ModuleView';
import { invoke, invokeSafe, isTauri } from '../../lib/tauri';

import type { App, WindowInfo, Category, ChipKey, ViewMode, SortKey } from './types';
import {
  RECENT_KEY,
  FAV_KEY,
  VIEW_KEY,
  SORT_KEY,
  RUNNING_POLL_MS,
  CATEGORY_ORDER,
  FAKE_APPS,
  ICON_FETCH_SIZE,
  ICON_FETCH_CONCURRENCY,
} from './constants';
import {
  classify,
  loadStringList,
  saveStringList,
  loadLaunchCounts,
  saveLaunchCounts,
  loadView,
  loadSort,
  pushRecent,
  toggleFav,
  matches,
  loadLaunchEvents,
  saveLaunchEvents,
  appendLaunchEvent,
  weeklyCount,
  buildHeatmap,
  type LaunchEvent,
} from './utils';
import {
  chipRowStyle,
  chipBtnBase,
  chipBtnActive,
  chipCountStyle,
  runningDotStyle,
  toolbarBtnStyle,
  toolbarBtnActive,
  emptyStyle,
  gridStyle,
  focusedPillStyle,
  retryBtnStyle,
  shortcutBarStyle,
} from './styles';

import { AppTile } from './components/AppTile';
import { AppRow } from './components/AppRow';
import { LaunchHeatmap } from './components/LaunchHeatmap';
import { QuickList } from './components/QuickList';

async function prefetchIcons(
  paths: readonly string[],
  cache: Map<string, string>,
  onEach: (path: string, b64: string) => void,
): Promise<void> {
  const queue = paths.filter(p => !cache.has(p));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const idx = cursor++;
      const path = queue[idx];
      if (!path) continue;
      const b64 = await invokeSafe<string>('app_icon_png', { app_path: path, size: ICON_FETCH_SIZE });
      if (b64) {
        cache.set(path, b64);
        onEach(path, b64);
      }
    }
  };
  const workers = Array.from({ length: Math.min(ICON_FETCH_CONCURRENCY, queue.length) }, () => worker());
  await Promise.all(workers);
}

const SEARCH_DEBOUNCE_MS = 120;
const FOCUSED_POLL_MS = 2_000;

export function AppsPage(): ReactElement {
  const [apps, setApps] = useState<readonly App[]>([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [recent, setRecent] = useState<readonly string[]>(() => loadStringList(RECENT_KEY, 8));
  const [favs, setFavs] = useState<readonly string[]>(() => loadStringList(FAV_KEY, 999));
  const [launches, setLaunches] = useState<Readonly<Record<string, number>>>(() => loadLaunchCounts());
  const [activeChip, setActiveChip] = useState<ChipKey>('ALL');
  const [focusIdx, setFocusIdx] = useState<number>(-1);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadView());
  const [sortKey, setSortKey] = useState<SortKey>(() => loadSort());
  const [runningApps, setRunningApps] = useState<ReadonlySet<string>>(new Set());
  const [focusedAppName, setFocusedAppName] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_iconVersion, setIconVersion] = useState(0);
  const iconCache = useRef<Map<string, string>>(new Map());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const gridWrapRef = useRef<HTMLDivElement | null>(null);

  // ── Depth features: timed launch events, recently-closed tracking ─────────
  const [launchEvents, setLaunchEvents] = useState<readonly LaunchEvent[]>(() => loadLaunchEvents());
  const prevWindowSet = useRef<ReadonlySet<string>>(new Set());
  const [recentlyClosed, setRecentlyClosed] = useState<readonly string[]>([]);

  useEffect(() => { localStorage.setItem(VIEW_KEY, viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem(SORT_KEY, sortKey); }, [sortKey]);
  useEffect(() => { saveLaunchCounts(launches); }, [launches]);
  useEffect(() => { saveLaunchEvents(launchEvents); }, [launchEvents]);

  // Debounce search to keep filtering cheap on 300+ app catalogs.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const showToast = useCallback((tone: 'ok' | 'err', msg: string) => {
    setToast({ tone, msg });
    window.setTimeout(() => setToast(t => (t && t.msg === msg ? null : t)), 2000);
  }, []);

  // ---- load app list ------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      if (!isTauri) {
        if (!cancelled) {
          setApps(FAKE_APPS);
          setLoading(false);
        }
        return;
      }
      const list = await invokeSafe<App[]>('list_apps');
      if (cancelled) return;
      if (list === null) {
        setErr('Unable to enumerate applications.');
        setApps([]);
      } else {
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
        setApps(sorted);
        let pending = 0;
        prefetchIcons(
          sorted.map(a => a.path),
          iconCache.current,
          () => {
            if (cancelled) return;
            pending += 1;
            if (pending >= 8) {
              pending = 0;
              setIconVersion(v => v + 1);
            }
          },
        ).then(() => {
          if (!cancelled) setIconVersion(v => v + 1);
        });
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // ---- focused-app polling ----------------------------------------------

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const sample = async () => {
      const f = await invokeSafe<{ bundle_id?: string | null; localized_name?: string | null } | null>(
        'window_focused_app',
      );
      if (cancelled) return;
      const name = f && typeof f.localized_name === 'string' ? f.localized_name : null;
      setFocusedAppName(prev => (prev === name ? prev : name));
    };
    void sample();
    const t = window.setInterval(sample, FOCUSED_POLL_MS);
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);

  // ---- running-app polling ----------------------------------------------

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const sample = async () => {
      const wins = await invokeSafe<WindowInfo[]>('window_list');
      if (cancelled || !wins) return;
      const names = new Set<string>();
      for (const w of wins) if (w.app_name) names.add(w.app_name);
      // Detect apps that disappeared since last poll → recently closed.
      const prev = prevWindowSet.current;
      const closed: string[] = [];
      for (const n of prev) {
        if (!names.has(n)) closed.push(n);
      }
      if (closed.length > 0) {
        setRecentlyClosed(rc => {
          const existing = new Set(rc);
          const freshClosed = closed.filter(n => !existing.has(n));
          return [...freshClosed, ...rc].slice(0, 8);
        });
      }
      prevWindowSet.current = names;
      setRunningApps(names);
    };
    void sample();
    const t = window.setInterval(sample, RUNNING_POLL_MS);
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);

  // ---- derived data -------------------------------------------------------

  const categoryOf = useMemo<ReadonlyMap<string, Category>>(() => {
    const m = new Map<string, Category>();
    for (const a of apps) m.set(a.name, classify(a.name));
    return m;
  }, [apps]);

  const favSet = useMemo(() => new Set(favs), [favs]);
  const recentIndex = useMemo<ReadonlyMap<string, number>>(() => {
    const m = new Map<string, number>();
    recent.forEach((n, i) => m.set(n, i));
    return m;
  }, [recent]);

  const chipCounts = useMemo<Readonly<Record<ChipKey, number>>>(() => {
    const out: Record<ChipKey, number> = {
      ALL: apps.length,
      FAVORITES: 0,
      RUNNING: 0,
      SYSTEM: 0, DEVELOPER: 0, DESIGN: 0, PRODUCTIVITY: 0,
      MEDIA: 0, GAMES: 0, UTILITIES: 0, OTHER: 0,
    };
    for (const a of apps) {
      if (favSet.has(a.name)) out.FAVORITES += 1;
      if (runningApps.has(a.name)) out.RUNNING += 1;
      const cat = categoryOf.get(a.name) ?? 'OTHER';
      if (cat !== 'OTHER') out[cat] += 1;
    }
    return out;
  }, [apps, favSet, runningApps, categoryOf]);

  const filtered = useMemo<readonly App[]>(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const list = apps.filter(a => {
      if (!matches(a.name, a.path, q)) return false;
      if (activeChip === 'ALL') return true;
      if (activeChip === 'FAVORITES') return favSet.has(a.name);
      if (activeChip === 'RUNNING') return runningApps.has(a.name);
      return categoryOf.get(a.name) === activeChip;
    });

    const byName = (a: App, b: App) => a.name.localeCompare(b.name);
    if (sortKey === 'name') return list.sort(byName);
    if (sortKey === 'recent') {
      return list.sort((a, b) => {
        const ra = recentIndex.get(a.name);
        const rb = recentIndex.get(b.name);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return byName(a, b);
      });
    }
    return list.sort((a, b) => {
      const la = launches[a.name] ?? 0;
      const lb = launches[b.name] ?? 0;
      if (la !== lb) return lb - la;
      return byName(a, b);
    });
  }, [apps, debouncedQuery, activeChip, favSet, runningApps, categoryOf, sortKey, recentIndex, launches]);

  const favApps = useMemo<readonly App[]>(() => {
    const byName = new Map<string, App>(apps.map(a => [a.name, a]));
    return favs.map(n => byName.get(n)).filter((a): a is App => a !== undefined);
  }, [apps, favs]);

  const recentApps = useMemo<readonly App[]>(() => {
    const byName = new Map<string, App>(apps.map(a => [a.name, a]));
    return recent.map(n => byName.get(n)).filter((a): a is App => a !== undefined);
  }, [apps, recent]);

  useEffect(() => { setFocusIdx(-1); }, [debouncedQuery, activeChip, apps.length, sortKey]);

  // Scroll focused tile/row into view whenever focus changes via keyboard.
  useEffect(() => {
    if (focusIdx < 0) return;
    const root = gridWrapRef.current;
    if (!root) return;
    const children = root.firstElementChild?.children;
    const el = children?.[focusIdx] as HTMLElement | undefined;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [focusIdx]);

  // ---- actions ------------------------------------------------------------

  const handleLaunch = useCallback(async (name: string): Promise<void> => {
    setRecent(prev => {
      const next = pushRecent(prev, name);
      saveStringList(RECENT_KEY, next);
      return next;
    });
    setLaunches(prev => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
    setLaunchEvents(prev => appendLaunchEvent(prev, name));
    if (!isTauri) {
      showToast('ok', `LAUNCH ${name.toUpperCase()} (dev)`);
      return;
    }
    try {
      await invoke<void>('open_app', { name });
      showToast('ok', `LAUNCHED ${name.toUpperCase()}`);
    } catch (e) {
      console.error('open_app failed', e);
      setErr(`Failed to launch "${name}".`);
      showToast('err', `LAUNCH FAILED`);
    }
  }, [showToast]);

  const handleToggleFav = useCallback((name: string): void => {
    setFavs(prev => {
      const next = toggleFav(prev, name);
      saveStringList(FAV_KEY, next);
      return next;
    });
  }, []);

  const handleReveal = useCallback(async (path: string): Promise<void> => {
    const r = await invokeSafe<string>('finder_reveal', { path });
    if (r === null && isTauri) showToast('err', 'REVEAL FAILED');
  }, [showToast]);

  const handleQuit = useCallback(async (name: string): Promise<void> => {
    const ok = window.confirm(`Quit ${name}?`);
    if (!ok) return;
    const r = await invokeSafe<string>('app_quit', { name });
    if (r === null) showToast('err', 'QUIT FAILED');
    else showToast('ok', `QUIT ${name.toUpperCase()}`);
  }, [showToast]);

  const handleHide = useCallback(async (name: string): Promise<void> => {
    const r = await invokeSafe<void>('app_hide', { name });
    if (r === null && isTauri) showToast('err', 'HIDE FAILED');
    else showToast('ok', `HIDE ${name.toUpperCase()}`);
  }, [showToast]);

  const handleCopyPath = useCallback(async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path);
      showToast('ok', 'COPIED');
    } catch {
      showToast('err', 'CLIPBOARD UNAVAILABLE');
    }
  }, [showToast]);

  // ---- keyboard ----------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const inInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      if (e.key === '/' && !inInput) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && !inInput) {
        if (e.key === 'g' || e.key === 'G') { e.preventDefault(); setViewMode('grid'); return; }
        if (e.key === 'l' || e.key === 'L') { e.preventDefault(); setViewMode('list'); return; }
      }

      if (inInput && e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== 'Escape') return;

      if (e.key === 'Escape') {
        if (query) { setQuery(''); return; }
        if (searchRef.current === document.activeElement) searchRef.current?.blur();
        setFocusIdx(-1);
        return;
      }

      if (filtered.length === 0) return;

      if (
        e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
        e.key === 'ArrowRight' || e.key === 'ArrowLeft' ||
        e.key === 'Home' || e.key === 'End' ||
        e.key === 'PageDown' || e.key === 'PageUp'
      ) {
        e.preventDefault();
        const cols = viewMode === 'list' ? 1 : Math.max(1, Math.floor(window.innerWidth / 160));
        const page = Math.max(cols * 3, 1);
        const idx = focusIdx < 0 ? 0 : focusIdx;
        let next = idx;
        if (e.key === 'ArrowDown') next = Math.min(filtered.length - 1, idx + cols);
        else if (e.key === 'ArrowUp') next = Math.max(0, idx - cols);
        else if (e.key === 'ArrowRight') next = Math.min(filtered.length - 1, idx + 1);
        else if (e.key === 'ArrowLeft') next = Math.max(0, idx - 1);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = filtered.length - 1;
        else if (e.key === 'PageDown') next = Math.min(filtered.length - 1, idx + page);
        else if (e.key === 'PageUp') next = Math.max(0, idx - page);
        setFocusIdx(next);
        return;
      }

      if (e.key === 'Enter' && focusIdx >= 0 && focusIdx < filtered.length) {
        e.preventDefault();
        const app = filtered[focusIdx];
        if (app) void handleLaunch(app.name);
        return;
      }

      if (!inInput && focusIdx >= 0 && focusIdx < filtered.length) {
        const app = filtered[focusIdx];
        if (!app) return;
        const isRunning = runningApps.has(app.name);
        if (e.key === 'f' || e.key === 'F') { e.preventDefault(); handleToggleFav(app.name); return; }
        if (e.key === 'r' || e.key === 'R') { e.preventDefault(); void handleReveal(app.path); return; }
        if ((e.key === 'h' || e.key === 'H') && isRunning) { e.preventDefault(); void handleHide(app.name); return; }
        if ((e.key === 'q' || e.key === 'Q') && isRunning) { e.preventDefault(); void handleQuit(app.name); return; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, focusIdx, query, viewMode, runningApps, handleLaunch, handleToggleFav, handleReveal, handleHide, handleQuit]);

  // ---- render -----------------------------------------------------------

  // ── Heatmap + weekly counts ───────────────────────────────────────────────
  const heatmapGrid = useMemo(() => buildHeatmap(launchEvents), [launchEvents]);
  const getWeeklyCount = useCallback(
    (name: string) => weeklyCount(launchEvents, name),
    [launchEvents],
  );

  // Handle QuickList reordering by persisting new fav order.
  const handleReorder = useCallback((newOrder: readonly string[]) => {
    setFavs(newOrder);
    saveStringList(FAV_KEY, newOrder);
  }, []);

  const badge = loading
    ? 'SCANNING'
    : `${filtered.length} / ${apps.length} \u00B7 \u2605 ${favs.length}${runningApps.size > 0 ? ` \u00B7 ${chipCounts.RUNNING} RUN` : ''}`;

  const showRecents = activeChip === 'ALL' && !debouncedQuery && sortKey === 'name' && recentApps.length > 0;
  const showFavSection = activeChip === 'ALL' && !debouncedQuery && sortKey === 'name' && favApps.length > 0;
  const focusedIsKnown = focusedAppName !== null
    && apps.some(a => a.name === focusedAppName);

  return (
    <ModuleView title="APPS" badge={badge}>
      <div className="section">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search applications by name, initials, or path   ·   /  to focus"
          autoFocus
        />
      </div>

      <div className="section" style={chipRowStyle}>
        {CATEGORY_ORDER.map(key => {
          const active = activeChip === key;
          const count = chipCounts[key] ?? 0;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActiveChip(key)}
              style={active ? { ...chipBtnBase, ...chipBtnActive } : chipBtnBase}
            >
              <span>{key}</span>
              {count > 0 && <span style={chipCountStyle}>{count}</span>}
              {key === 'RUNNING' && count > 0 && <span style={runningDotStyle} />}
            </button>
          );
        })}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <span
            style={{
              fontFamily: 'var(--display)',
              fontSize: 9,
              letterSpacing: '0.2em',
              color: 'var(--ink-dim)',
              alignSelf: 'center',
              marginRight: 4,
            }}
          >
            SORT
          </span>
          {(['name', 'recent', 'launches'] as const).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setSortKey(k)}
              style={sortKey === k ? toolbarBtnActive : toolbarBtnStyle}
              title={k === 'name' ? 'Alphabetical' : k === 'recent' ? 'Most recently launched first' : 'Most launched first'}
            >
              {k === 'name' ? 'A–Z' : k === 'recent' ? 'RECENT' : 'TOP'}
            </button>
          ))}
          <span
            style={{
              fontFamily: 'var(--display)',
              fontSize: 9,
              letterSpacing: '0.2em',
              color: 'var(--ink-dim)',
              alignSelf: 'center',
              margin: '0 4px 0 8px',
            }}
          >
            VIEW
          </span>
          <button
            type="button"
            onClick={() => setViewMode('grid')}
            style={viewMode === 'grid' ? toolbarBtnActive : toolbarBtnStyle}
            title="Grid view (⌘G)"
          >
            GRID
          </button>
          <button
            type="button"
            onClick={() => setViewMode('list')}
            style={viewMode === 'list' ? toolbarBtnActive : toolbarBtnStyle}
            title="List view (⌘L)"
          >
            LIST
          </button>
        </div>
      </div>

      {focusedAppName && (
        <div
          className="section"
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 2px' }}
        >
          <span style={focusedPillStyle} title="Currently focused application">
            <span style={runningDotStyle} />
            FOCUSED {'\u00B7'} {focusedAppName.toUpperCase()}
          </span>
          {focusedIsKnown && (
            <button
              type="button"
              style={toolbarBtnStyle}
              onClick={() => {
                const idx = filtered.findIndex(a => a.name === focusedAppName);
                if (idx >= 0) setFocusIdx(idx);
              }}
              title="Select focused app in list"
            >
              REVEAL IN LIST
            </button>
          )}
        </div>
      )}

      {err && (
        <div className="section" style={{ color: 'var(--red)', display: 'flex', alignItems: 'center' }}>
          <span>{err}</span>
          <button
            type="button"
            style={retryBtnStyle}
            onClick={() => setReloadTick(n => n + 1)}
          >
            RETRY
          </button>
        </div>
      )}

      {heatmapGrid.reduce((s, v) => s + v, 0) > 0 && (
        <div className="section" style={{ paddingTop: 4, paddingBottom: 4 }}>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.18em',
              color: 'var(--ink-dim)',
              marginBottom: 2,
            }}
          >
            LAUNCH ACTIVITY · 7-DAY HEATMAP
          </div>
          <LaunchHeatmap grid={heatmapGrid} />
        </div>
      )}

      {favApps.length > 0 && activeChip === 'ALL' && !debouncedQuery && (
        <div className="section" style={{ paddingTop: 6, paddingBottom: 6 }}>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.18em',
              color: 'var(--ink-dim)',
              marginBottom: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>QUICK LAUNCH</span>
            <span style={{ opacity: 0.5 }}>· drag to reorder</span>
          </div>
          <QuickList
            apps={favApps}
            iconCache={iconCache.current}
            runningSet={runningApps}
            onLaunch={handleLaunch}
            onReorder={handleReorder}
          />
        </div>
      )}

      {recentlyClosed.length > 0 && activeChip === 'ALL' && !debouncedQuery && (
        <>
          <h2>RECENTLY CLOSED</h2>
          <div className="section">
            <div style={gridStyle}>
              {recentlyClosed
                .map(n => apps.find(a => a.name === n))
                .filter((a): a is App => a !== undefined)
                .map(a => (
                  <AppTile
                    key={`closed-${a.path}`}
                    app={a}
                    category={categoryOf.get(a.name) ?? 'OTHER'}
                    isFav={favSet.has(a.name)}
                    focused={false}
                    isRunning={false}
                    launchCount={launches[a.name] ?? 0}
                    weeklyLaunches={getWeeklyCount(a.name)}
                    icon={iconCache.current.get(a.path) ?? null}
                    onLaunch={handleLaunch}
                    onToggleFav={handleToggleFav}
                    onReveal={handleReveal}
                    onQuit={handleQuit}
                    onHide={handleHide}
                    onCopyPath={handleCopyPath}
                  />
                ))}
            </div>
          </div>
        </>
      )}

      {showFavSection && (
        <>
          <h2>FAVORITES</h2>
          <div className="section">
            <div style={gridStyle}>
              {favApps.map(a => (
                <AppTile
                  key={`fav-${a.path}`}
                  app={a}
                  category={categoryOf.get(a.name) ?? 'OTHER'}
                  isFav
                  focused={false}
                  isRunning={runningApps.has(a.name)}
                  launchCount={launches[a.name] ?? 0}
                  weeklyLaunches={getWeeklyCount(a.name)}
                  icon={iconCache.current.get(a.path) ?? null}
                  onLaunch={handleLaunch}
                  onToggleFav={handleToggleFav}
                  onReveal={handleReveal}
                  onQuit={handleQuit}
                  onHide={handleHide}
                  onCopyPath={handleCopyPath}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {showRecents && (
        <>
          <h2>RECENTLY LAUNCHED</h2>
          <div className="section">
            <div style={gridStyle}>
              {recentApps.map(a => (
                <AppTile
                  key={`recent-${a.path}`}
                  app={a}
                  category={categoryOf.get(a.name) ?? 'OTHER'}
                  isFav={favSet.has(a.name)}
                  focused={false}
                  isRunning={runningApps.has(a.name)}
                  launchCount={launches[a.name] ?? 0}
                  weeklyLaunches={getWeeklyCount(a.name)}
                  icon={iconCache.current.get(a.path) ?? null}
                  onLaunch={handleLaunch}
                  onToggleFav={handleToggleFav}
                  onReveal={handleReveal}
                  onQuit={handleQuit}
                  onHide={handleHide}
                  onCopyPath={handleCopyPath}
                />
              ))}
            </div>
          </div>
        </>
      )}

      <h2>
        {activeChip === 'ALL'
          ? sortKey === 'launches'
            ? 'MOST LAUNCHED'
            : sortKey === 'recent'
            ? 'RECENT ACTIVITY'
            : 'ALL APPLICATIONS'
          : activeChip}
        {!isTauri && (
          <span
            style={{
              marginLeft: 10,
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--ink-dim)',
              letterSpacing: '0.15em',
            }}
          >
            [DEV PREVIEW]
          </span>
        )}
      </h2>

      <div
        ref={gridWrapRef}
        className="section"
        style={{ padding: viewMode === 'list' ? 0 : undefined }}
      >
        {loading ? (
          <div style={{ padding: 8, color: 'var(--ink-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>
            Scanning /Applications...
          </div>
        ) : filtered.length === 0 ? (
          <div style={emptyStyle}>
            {apps.length === 0 ? 'NO APPLICATIONS FOUND' : 'NO APPLICATIONS MATCH'}
            {apps.length > 0 && debouncedQuery && (
              <div style={{ marginTop: 10, fontSize: 10, letterSpacing: '0.2em' }}>
                TRY CLEARING SEARCH ({`"${debouncedQuery}"`}) OR CHANGING CATEGORY
              </div>
            )}
          </div>
        ) : viewMode === 'grid' ? (
          <div style={gridStyle}>
            {filtered.map((a, idx) => (
              <AppTile
                key={a.path}
                app={a}
                category={categoryOf.get(a.name) ?? 'OTHER'}
                isFav={favSet.has(a.name)}
                focused={idx === focusIdx}
                isRunning={runningApps.has(a.name)}
                launchCount={launches[a.name] ?? 0}
                icon={iconCache.current.get(a.path) ?? null}
                onLaunch={handleLaunch}
                onToggleFav={handleToggleFav}
                onReveal={handleReveal}
                onQuit={handleQuit}
                onHide={handleHide}
                onCopyPath={handleCopyPath}
              />
            ))}
          </div>
        ) : (
          <div>
            {filtered.map((a, idx) => (
              <AppRow
                key={a.path}
                app={a}
                category={categoryOf.get(a.name) ?? 'OTHER'}
                isFav={favSet.has(a.name)}
                focused={idx === focusIdx}
                isRunning={runningApps.has(a.name)}
                launchCount={launches[a.name] ?? 0}
                icon={iconCache.current.get(a.path) ?? null}
                onLaunch={handleLaunch}
                onToggleFav={handleToggleFav}
                onReveal={handleReveal}
                onQuit={handleQuit}
                onHide={handleHide}
                onCopyPath={handleCopyPath}
              />
            ))}
          </div>
        )}
      </div>

      <div style={shortcutBarStyle}>
        <span>/  SEARCH</span>
        <span>↵  LAUNCH</span>
        <span>↑↓→←  NAVIGATE</span>
        <span>⇞⇟  PAGE</span>
        <span>⇱⇲  JUMP</span>
        <span>F  FAV</span>
        <span>R  REVEAL</span>
        <span>H  HIDE</span>
        <span>Q  QUIT</span>
        <span>⌘G / ⌘L  VIEW</span>
        <span>ESC  CLEAR</span>
      </div>

      {toast && (
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 14,
            padding: '8px 14px',
            border: `1px solid ${toast.tone === 'err' ? 'rgba(255, 77, 94, 0.4)' : 'var(--line-soft)'}`,
            background: toast.tone === 'err' ? 'rgba(255, 77, 94, 0.08)' : 'rgba(6, 14, 22, 0.92)',
            color: toast.tone === 'err' ? 'var(--red)' : 'var(--cyan)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.18em',
            fontWeight: 700,
            pointerEvents: 'none',
          }}
        >
          {toast.msg}
        </div>
      )}
    </ModuleView>
  );
}
