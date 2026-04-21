/**
 * Local star/favorite ids for Notes — independent of Apple Notes sync.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'sunny.notes.favorites.v1';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const a = JSON.parse(raw) as unknown;
      if (Array.isArray(a)) return new Set(a.filter((x): x is string => typeof x === 'string'));
    }
  } catch { /* ignore */ }
  return new Set();
}

let favs = load();
const subs = new Set<() => void>();

export function useNoteFavorites(): ReadonlySet<string> {
  return useSyncExternalStore(
    fn => { subs.add(fn); return () => subs.delete(fn); },
    () => favs,
    () => favs,
  );
}

export function isNoteFavorite(id: string): boolean {
  return favs.has(id);
}

export function toggleNoteFavorite(id: string): void {
  const next = new Set(favs);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  favs = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...favs]));
  } catch { /* ignore */ }
  subs.forEach(fn => fn());
}
