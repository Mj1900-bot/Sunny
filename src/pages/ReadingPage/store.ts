/**
 * Reading list store — persists in localStorage. We purposefully do not
 * add a new Rust table for this; the frontend owns the state and hands
 * articles to Sunny via `askSunny(…)` when summaries are requested.
 */

import { useSyncExternalStore } from 'react';

export type ReadingItem = {
  id: string;
  url: string;
  title: string;
  domain: string;
  /** Unix seconds added. */
  added_at: number;
  /** 0 = unread, 1 = started, 2 = done. */
  status: 0 | 1 | 2;
  summary: string | null;
  /** Minutes of estimated read time. */
  minutes: number | null;
  /** First ~300 chars of article body, used for reader pane + TLDR context. */
  excerpt: string | null;
  /** User-managed tags. */
  tags: string[];
};

const KEY = 'sunny.reading.queue.v1';
/** Older builds wrote under this key; we read it once at boot and migrate. */
const LEGACY_KEY = 'sunny.reading.v1';

type State = { items: ReadingItem[] };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        const items = (parsed.items as Partial<ReadingItem>[]).map(i => ({
          ...i,
          excerpt: i.excerpt ?? null,
          tags: Array.isArray(i.tags) ? i.tags : [],
        })) as ReadingItem[];
        return { items };
      }
    }
  } catch { /* ignore */ }
  return { items: [] };
}

let state: State = load();
const subs = new Set<() => void>();

function commit(next: State) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  subs.forEach(fn => fn());
}

export function useReading(): ReadingItem[] {
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => subs.delete(fn); },
    () => state.items,
    () => state.items,
  );
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export type AddReadingExtras = {
  excerpt?: string | null;
  minutes?: number | null;
};

export function addReading(url: string, title?: string, extras?: AddReadingExtras): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  const id = `r-${Date.now().toString(36)}`;
  const item: ReadingItem = {
    id, url: trimmed, title: title?.trim() || trimmed,
    domain: domainOf(trimmed),
    added_at: Math.floor(Date.now() / 1000),
    status: 0,
    summary: null,
    minutes: extras?.minutes ?? null,
    excerpt: extras?.excerpt ?? null,
    tags: [],
  };
  commit({ items: [item, ...state.items] });
}

export function removeReading(id: string): void {
  commit({ items: state.items.filter(i => i.id !== id) });
}

export function setStatus(id: string, status: 0 | 1 | 2): void {
  commit({ items: state.items.map(i => i.id === id ? { ...i, status } : i) });
}

export function setSummary(id: string, summary: string): void {
  commit({ items: state.items.map(i => i.id === id ? { ...i, summary } : i) });
}

export function setExcerpt(id: string, excerpt: string): void {
  commit({ items: state.items.map(i => i.id === id ? { ...i, excerpt } : i) });
}

export function updateTags(id: string, tags: string[]): void {
  commit({ items: state.items.map(i => i.id === id ? { ...i, tags: [...tags] } : i) });
}

/** Normalize URL for duplicate detection (strip hash). */
export function normalizeReadingUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch {
    return u.trim().toLowerCase();
  }
}

/** Keep the first occurrence of each URL (list order = newest first). */
export function dedupeByUrl(): number {
  const seen = new Set<string>();
  const kept: ReadingItem[] = [];
  let removed = 0;
  for (const i of state.items) {
    const k = normalizeReadingUrl(i.url);
    if (seen.has(k)) {
      removed++;
      continue;
    }
    seen.add(k);
    kept.push(i);
  }
  if (removed > 0) commit({ items: kept });
  return removed;
}

export function bulkSetStatusForIds(ids: ReadonlyArray<string>, status: 0 | 1 | 2): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  commit({ items: state.items.map(i => (set.has(i.id) ? { ...i, status } : i)) });
}

/** Clone an item to the top of the queue (new id, reset to unread). */
export function duplicateReading(id: string): void {
  const i = state.items.find(x => x.id === id);
  if (!i) return;
  const nid = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const copy: ReadingItem = {
    ...i,
    id: nid,
    title: `${i.title} (copy)`,
    added_at: Math.floor(Date.now() / 1000),
    status: 0,
    summary: null,
  };
  commit({ items: [copy, ...state.items] });
}

function migrateRawItem(raw: unknown): ReadingItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<ReadingItem> & { url?: string };
  const u = typeof o.url === 'string' ? o.url.trim() : '';
  if (!u) return null;
  const st = o.status === 0 || o.status === 1 || o.status === 2 ? o.status : 0;
  return {
    id: typeof o.id === 'string' && o.id.length > 0 ? o.id : `r-${Date.now().toString(36)}`,
    url: u,
    title: typeof o.title === 'string' && o.title.length > 0 ? o.title : u,
    domain: domainOf(u),
    added_at: typeof o.added_at === 'number' ? o.added_at : Math.floor(Date.now() / 1000),
    status: st,
    summary: o.summary ?? null,
    minutes: typeof o.minutes === 'number' ? o.minutes : null,
    excerpt: o.excerpt ?? null,
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

export function exportQueueJson(): string {
  return JSON.stringify({ version: 1, exportedAt: Date.now(), items: state.items }, null, 2);
}

export function importQueueReplace(json: string): { ok: boolean; error?: string } {
  try {
    const parsed = JSON.parse(json) as { items?: unknown[] };
    if (!parsed || !Array.isArray(parsed.items)) return { ok: false, error: 'Expected { items: [...] }' };
    const items: ReadingItem[] = [];
    for (const raw of parsed.items) {
      const m = migrateRawItem(raw);
      if (m) items.push(m);
    }
    commit({ items });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
}

export function importQueueMerge(json: string): { added: number; error?: string } {
  let parsed: { items?: unknown[] };
  try {
    parsed = JSON.parse(json) as { items?: unknown[] };
  } catch (e) {
    return { added: 0, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
  if (!parsed?.items || !Array.isArray(parsed.items)) return { added: 0, error: 'Expected { items: [...] }' };

  const urls = new Set(state.items.map(i => normalizeReadingUrl(i.url)));
  const incoming: ReadingItem[] = [];
  for (const raw of parsed.items) {
    const m = migrateRawItem(raw);
    if (!m) continue;
    const k = normalizeReadingUrl(m.url);
    if (urls.has(k)) continue;
    urls.add(k);
    incoming.push({
      ...m,
      id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      added_at: Math.floor(Date.now() / 1000),
    });
  }
  if (incoming.length > 0) commit({ items: [...incoming, ...state.items] });
  return { added: incoming.length };
}
