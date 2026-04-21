import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { IMG_EXTS, LS_HIDDEN, LS_PINNED, LS_RECENTS, LS_VIEW } from './constants';
import {
  basename, fmtSize, getExt, joinPath, kindBucket,
  kindLabel, parentPath, readJson, splitSegments, writeJson,
} from './utils';
import type {
  Entry, FsDirSize, FsReadText, KindFilter, SortDir, SortKey, ViewMode,
} from './types';

// ---------------------------------------------------------------------------
// Central hook — owns ALL page state, derived data, effects, and callbacks.
// ---------------------------------------------------------------------------

export function useFilesState() {
  const [path, setPath] = useState('~');
  const [draft, setDraft] = useState('~');
  const [entries, setEntries] = useState<ReadonlyArray<Entry>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [loading, setLoading] = useState(false);

  const [query, setQuery] = useState('');
  const [recursiveResults, setRecursiveResults] = useState<ReadonlyArray<Entry> | null>(null);
  const [recursiveBusy, setRecursiveBusy] = useState(false);

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [showHidden, setShowHidden] = useState<boolean>(() => readJson(LS_HIDDEN, false));
  const [viewMode, setViewMode] = useState<ViewMode>(() => readJson<ViewMode>(LS_VIEW, 'list'));
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [lastAnchor, setLastAnchor] = useState<string | null>(null);

  const [preview, setPreview] = useState<FsReadText | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [dirMeta, setDirMeta] = useState<FsDirSize | null>(null);
  const [dirMetaFor, setDirMetaFor] = useState<string | null>(null);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [creating, setCreating] = useState<null | 'file' | 'folder'>(null);
  const [createDraft, setCreateDraft] = useState('');
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(null);

  const [pinned, setPinned] = useState<ReadonlyArray<string>>(() => readJson<string[]>(LS_PINNED, []));
  const [recents, setRecents] = useState<ReadonlyArray<string>>(() => readJson<string[]>(LS_RECENTS, []));

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Tracks the last successful listing completion for the "REFRESHED Ns AGO"
  // footer. Stored as epoch millis because we compute a delta in ms (not secs).
  const lastLoaded = useRef<number>(Date.now());
  const [lastLoadedAt, setLastLoadedAt] = useState<number>(() => Date.now());

  // ---- persistence --------------------------------------------------------

  useEffect(() => { writeJson(LS_PINNED, pinned); }, [pinned]);
  useEffect(() => { writeJson(LS_RECENTS, recents); }, [recents]);
  useEffect(() => { writeJson(LS_VIEW, viewMode); }, [viewMode]);
  useEffect(() => { writeJson(LS_HIDDEN, showHidden); }, [showHidden]);

  // ---- data loading --------------------------------------------------------

  const load = useCallback(async (p: string) => {
    setErr(null);
    setLoading(true);
    const list = await invokeSafe<ReadonlyArray<Entry>>('fs_list', { path: p });
    setLoading(false);
    if (list === null) {
      setErr(isTauri ? 'Unable to read directory' : 'Not available outside Tauri runtime');
      setEntries([]);
    } else {
      setEntries(list);
    }
    setSelected(new Set());
    setFocusPath(null);
    setRecursiveResults(null);
    // Stamp both the ref (authoritative) and state (so consumers re-render
    // when the listing completes). The ref is exposed for callers that only
    // need the latest value without subscribing.
    const now = Date.now();
    lastLoaded.current = now;
    setLastLoadedAt(now);
  }, []);

  useEffect(() => {
    setDraft(path);
    void load(path);
    setRecents(prev => {
      const next = [path, ...prev.filter(x => x !== path)].slice(0, 8);
      return next;
    });
  }, [path, reloadTick, load]);

  // Recompute current time whenever the listing changes so relative labels stay fresh.
  const nowSecs = useMemo(() => {
    void entries;
    return Math.floor(Date.now() / 1000);
  }, [entries]);

  // ---- toast --------------------------------------------------------------

  const showToast = useCallback((tone: 'ok' | 'err', msg: string) => {
    setToast({ tone, msg });
    window.setTimeout(() => setToast(t => (t && t.msg === msg ? null : t)), 2400);
  }, []);

  // ---- derived data --------------------------------------------------------

  const baseEntries = recursiveResults ?? entries;

  const filtered = useMemo(() => {
    let list = [...baseEntries];
    if (!showHidden) list = list.filter(e => !e.name.startsWith('.'));
    if (kindFilter !== 'all') list = list.filter(e => kindBucket(e) === kindFilter);
    const q = query.trim().toLowerCase();
    if (q && !recursiveResults) list = list.filter(e => e.name.toLowerCase().includes(q));
    return list;
  }, [baseEntries, showHidden, kindFilter, query, recursiveResults]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1; // dirs always first
      switch (sortKey) {
        case 'size': return (a.size - b.size) * dir;
        case 'modified': return (a.modified_secs - b.modified_secs) * dir;
        case 'kind': {
          const ak = kindLabel(a).toLowerCase();
          const bk = kindLabel(b).toLowerCase();
          return ak.localeCompare(bk) * dir || a.name.localeCompare(b.name);
        }
        default: return a.name.localeCompare(b.name) * dir;
      }
    });
    return list;
  }, [filtered, sortKey, sortDir]);

  const counts = useMemo(() => {
    const dir = entries.reduce((n, e) => n + (e.is_dir ? 1 : 0), 0);
    return { total: entries.length, dir, file: entries.length - dir };
  }, [entries]);

  const selectedEntries = useMemo(
    () => sorted.filter(e => selected.has(e.path)),
    [sorted, selected],
  );

  const selectedSize = useMemo(
    () => selectedEntries.reduce((n, e) => n + (e.is_dir ? 0 : e.size), 0),
    [selectedEntries],
  );

  const segments = useMemo(() => splitSegments(path), [path]);
  const parent = useMemo(() => parentPath(path), [path]);

  const submitDraft = useCallback(() => {
    if (draft.trim() && draft !== path) setPath(draft.trim());
  }, [draft, path]);

  const isPinned = useCallback((p: string) => pinned.includes(p), [pinned]);

  const togglePin = useCallback((p: string) => {
    setPinned(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);
  }, []);

  // ---- selection ----------------------------------------------------------

  const onRowClick = useCallback((e: Entry, ev: React.MouseEvent) => {
    const meta = ev.metaKey || ev.ctrlKey;
    const shift = ev.shiftKey;
    setFocusPath(e.path);
    if (shift && lastAnchor) {
      const idxA = sorted.findIndex(x => x.path === lastAnchor);
      const idxB = sorted.findIndex(x => x.path === e.path);
      if (idxA >= 0 && idxB >= 0) {
        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        const next = new Set<string>(meta ? selected : []);
        for (let i = lo; i <= hi; i++) next.add(sorted[i].path);
        setSelected(next);
        return;
      }
    }
    if (meta) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(e.path)) next.delete(e.path); else next.add(e.path);
        return next;
      });
      setLastAnchor(e.path);
      return;
    }
    // Bare click = navigate (dir) or open (file)
    if (e.is_dir) {
      setPath(e.path);
    } else {
      void invokeSafe('open_path', { path: e.path });
    }
    setSelected(new Set([e.path]));
    setLastAnchor(e.path);
  }, [lastAnchor, selected, sorted]);

  const selectAll = useCallback(() => {
    setSelected(new Set(sorted.map(e => e.path)));
  }, [sorted]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  // ---- actions ------------------------------------------------------------

  const onCopyPath = useCallback(async (p: string | string[]) => {
    try {
      const text = Array.isArray(p) ? p.join('\n') : p;
      await navigator.clipboard.writeText(text);
      showToast('ok', Array.isArray(p) ? `COPIED ${p.length} PATHS` : 'COPIED');
    } catch {
      showToast('err', 'clipboard unavailable');
    }
  }, [showToast]);

  const onReveal = useCallback(async (p: string) => {
    const r = await invokeSafe<void>('fs_reveal', { path: p });
    if (r === null && !isTauri) showToast('err', 'reveal unavailable outside tauri');
  }, [showToast]);

  const uniqueTarget = useCallback((dir: string, name: string): string => {
    const existing = new Set(entries.map(e => e.name));
    if (!existing.has(name)) return joinPath(dir, name);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; i < 999; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!existing.has(candidate)) return joinPath(dir, candidate);
    }
    return joinPath(dir, `${stem} (copy)${ext}`);
  }, [entries]);

  const onDuplicate = useCallback(async (e: Entry) => {
    const dir = parentPath(e.path) ?? path;
    const target = uniqueTarget(dir, basename(e.path));
    const r = await invokeSafe<void>('fs_copy', { from: e.path, to: target });
    if (r === null) showToast('err', 'duplicate failed');
    else { showToast('ok', `DUPLICATED ${basename(target)}`); setReloadTick(t => t + 1); }
  }, [path, uniqueTarget, showToast]);

  const onTrashMany = useCallback(async (paths: ReadonlyArray<string>) => {
    if (paths.length === 0) return;
    const label = paths.length === 1 ? basename(paths[0]) : `${paths.length} ITEMS`;
    const ok = window.confirm(`Move ${label} to Trash?`);
    if (!ok) return;
    let failed = 0;
    for (const p of paths) {
      const r = await invokeSafe<void>('fs_trash', { path: p });
      if (r === null) failed += 1;
    }
    if (failed) showToast('err', `TRASH FAILED · ${failed}/${paths.length}`);
    else showToast('ok', `TRASHED ${label}`);
    setReloadTick(t => t + 1);
  }, [showToast]);

  const startRename = useCallback((e: Entry) => {
    setRenaming(e.path);
    setRenameDraft(e.name);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renaming) return;
    const next = renameDraft.trim();
    if (!next || next === basename(renaming)) {
      setRenaming(null);
      return;
    }
    if (next.includes('/')) {
      showToast('err', 'name cannot contain /');
      return;
    }
    const dir = parentPath(renaming) ?? path;
    const to = joinPath(dir, next);
    const r = await invokeSafe<void>('fs_rename', { from: renaming, to });
    if (r === null) {
      showToast('err', 'rename failed');
    } else {
      showToast('ok', `RENAMED · ${next}`);
      setReloadTick(t => t + 1);
    }
    setRenaming(null);
  }, [renaming, renameDraft, path, showToast]);

  const commitCreate = useCallback(async () => {
    if (!creating) return;
    const name = createDraft.trim();
    if (!name || name.includes('/')) {
      setCreating(null);
      setCreateDraft('');
      return;
    }
    const target = joinPath(path, name);
    const cmd = creating === 'folder' ? 'fs_mkdir' : 'fs_new_file';
    const r = await invokeSafe<void>(cmd, { path: target });
    if (r === null) {
      showToast('err', `create failed · ${name}`);
    } else {
      showToast('ok', `${creating === 'folder' ? 'CREATED FOLDER' : 'CREATED FILE'} · ${name}`);
      setReloadTick(t => t + 1);
    }
    setCreating(null);
    setCreateDraft('');
  }, [creating, createDraft, path, showToast]);

  const runRecursiveSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setRecursiveResults(null); return; }
    setRecursiveBusy(true);
    const r = await invokeSafe<ReadonlyArray<Entry>>('fs_search', {
      root: path, query: q, maxResults: 500, maxVisited: 50_000,
    });
    setRecursiveBusy(false);
    if (r === null) showToast('err', 'search failed');
    else setRecursiveResults(r);
  }, [path, showToast]);

  // ---- preview ------------------------------------------------------------

  useEffect(() => {
    const onlyOne = selectedEntries.length === 1 ? selectedEntries[0] : null;
    // Clear previous previews
    setPreview(null);
    setPreviewFor(null);
    setDirMeta(null);
    setDirMetaFor(null);
    if (!onlyOne) return;
    if (onlyOne.is_dir) {
      setDirMetaFor(onlyOne.path);
      void invokeSafe<FsDirSize>('fs_dir_size', { path: onlyOne.path, maxEntries: 20_000 })
        .then(r => { if (r) { setDirMeta(r); } });
      return;
    }
    const ext = getExt(onlyOne.name);
    const isImg = IMG_EXTS.has(ext);
    if (isImg) return; // image previewed via <img> + convertFileSrc
    if (onlyOne.size > 2 * 1024 * 1024) return; // skip very large files
    setPreviewFor(onlyOne.path);
    void invokeSafe<FsReadText>('fs_read_text', { path: onlyOne.path, maxBytes: 128 * 1024 })
      .then(r => { if (r) setPreview(r); });
  }, [selectedEntries]);

  // ---- scroll focused row into view --------------------------------------

  useEffect(() => {
    if (!focusPath || !listRef.current) return;
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(focusPath) : focusPath.replace(/["\\]/g, '\\$&');
    const el = listRef.current.querySelector(`[data-path="${esc}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [focusPath]);

  // ---- keyboard ----------------------------------------------------------

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA';
      const meta = ev.metaKey || ev.ctrlKey;

      // Global meta-key shortcuts (work even while focus is in fields)
      if (meta && (ev.key === 'r' || ev.key === 'R')) {
        ev.preventDefault();
        setReloadTick(t => t + 1);
        return;
      }
      if (meta && ev.key === 'f') {
        ev.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (meta && ev.shiftKey && (ev.key === 'n' || ev.key === 'N')) {
        ev.preventDefault();
        setCreating('folder');
        setCreateDraft('New Folder');
        return;
      }
      if (meta && (ev.key === 'n' || ev.key === 'N')) {
        ev.preventDefault();
        setCreating('file');
        setCreateDraft('untitled.txt');
        return;
      }
      if (meta && (ev.key === 'a' || ev.key === 'A') && !inField) {
        ev.preventDefault();
        selectAll();
        return;
      }

      if (inField) return;

      if (ev.key === '/') { ev.preventDefault(); searchRef.current?.focus(); return; }
      if (ev.key === 'Escape') {
        if (query) setQuery('');
        else clearSelection();
        return;
      }
      if (ev.key === 'Backspace') {
        ev.preventDefault();
        if (parent) setPath(parent);
        return;
      }
      if (ev.key === 'Enter' && focusPath) {
        ev.preventDefault();
        const e = sorted.find(x => x.path === focusPath);
        if (!e) return;
        if (e.is_dir) setPath(e.path);
        else void invokeSafe('open_path', { path: e.path });
        return;
      }
      if (ev.key === 'r' && focusPath) {
        ev.preventDefault();
        void invokeSafe('fs_reveal', { path: focusPath });
        return;
      }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected.size > 0) {
        ev.preventDefault();
        void onTrashMany(Array.from(selected));
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'j' || ev.key === 'k') {
        ev.preventDefault();
        if (sorted.length === 0) return;
        const idx = focusPath ? sorted.findIndex(e => e.path === focusPath) : -1;
        const down = ev.key === 'ArrowDown' || ev.key === 'j';
        const delta = down ? 1 : -1;
        const nextIdx = Math.max(0, Math.min(sorted.length - 1, idx < 0 ? 0 : idx + delta));
        const next = sorted[nextIdx];
        setFocusPath(next.path);
        if (!ev.shiftKey) {
          setSelected(new Set([next.path]));
          setLastAnchor(next.path);
        } else if (lastAnchor) {
          const idxA = sorted.findIndex(x => x.path === lastAnchor);
          const [lo, hi] = idxA < nextIdx ? [idxA, nextIdx] : [nextIdx, idxA];
          const nset = new Set<string>();
          for (let i = lo; i <= hi; i++) nset.add(sorted[i].path);
          setSelected(nset);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parent, focusPath, sorted, selected, query, lastAnchor, onTrashMany, selectAll, clearSelection]);

  // ---- header badge -------------------------------------------------------

  const headerBadge = useMemo(() => {
    const parts: string[] = [];
    parts.push(`${counts.total} ITEMS`);
    parts.push(`${counts.dir} DIR`);
    parts.push(`${counts.file} FILE`);
    if (selected.size > 0) parts.push(`${selected.size} SEL`);
    if (recursiveResults) parts.push('RECURSIVE');
    return parts.join(' · ');
  }, [counts, selected.size, recursiveResults]);

  return {
    // navigation
    path, setPath, draft, setDraft, submitDraft, segments, parent,
    // listing
    entries, err, loading, sorted, counts, nowSecs,
    reloadTick, setReloadTick,
    // search
    query, setQuery, recursiveResults, setRecursiveResults,
    recursiveBusy, runRecursiveSearch, searchRef,
    // filtering / sorting / view
    kindFilter, setKindFilter, showHidden, setShowHidden,
    viewMode, setViewMode, sortKey, setSortKey, sortDir, setSortDir,
    // selection
    selected, focusPath, selectedEntries, selectedSize,
    onRowClick, selectAll, clearSelection,
    // preview
    preview, previewFor, dirMeta, dirMetaFor,
    // rename / create
    renaming, setRenaming, renameDraft, setRenameDraft,
    startRename, commitRename,
    creating, setCreating, createDraft, setCreateDraft, commitCreate,
    // actions
    onCopyPath, onReveal, onDuplicate, onTrashMany,
    // bookmarks
    pinned, recents, isPinned, togglePin,
    // toast
    toast,
    showToast,
    // freshness
    lastLoaded, lastLoadedAt,
    // misc
    headerBadge, listRef, fmtSize,
  } as const;
}
