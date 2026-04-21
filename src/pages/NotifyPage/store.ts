/**
 * Lightweight notification log — we hijack `notify_send` and also record
 * any locally-generated notifications here. Real macOS notifications are
 * fire-and-forget; persisting them here gives the user a feed + replay.
 */

import { useSyncExternalStore } from 'react';
import { invokeSafe } from '../../lib/tauri';
import { useView } from '../../store/view';

// macOS afplay sound names supported by `notify_send` sanitizer in Rust.
export const NOTIFY_SOUNDS = [
  'default', 'Frog', 'Glass', 'Hero', 'Submarine', 'Tink', 'Sosumi',
] as const;
export type NotifySound = typeof NOTIFY_SOUNDS[number];

export type NotifyRecord = {
  id: string;
  title: string;
  body: string;
  at: number;
  tone: 'info' | 'ok' | 'warn' | 'error';
  /** If set, Sunny wrote this notification proactively. */
  from_sunny: boolean;
  sound?: NotifySound | null;
};

const KEY = 'sunny.notify.log.v1';
// Default retention — settings.notifyLogCap can override at runtime. This
// hardcoded floor is the cap when no settings snapshot is available (e.g.
// during initial hydration) and also the ceiling we expose in MODULES.
const FALLBACK_MAX = 200;

/** Read the effective retention cap. Lives outside React so the commit
 *  path can use it without a hook. Returns FALLBACK_MAX if the settings
 *  store hasn't hydrated yet or the value is nonsensical. */
function currentMax(): number {
  try {
    const n = useView.getState().settings.notifyLogCap;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 25 && n <= 5000) return n;
  } catch { /* store not ready */ }
  return FALLBACK_MAX;
}

type State = { items: NotifyRecord[] };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) return parsed as State;
    }
  } catch { /* ignore */ }
  return { items: [] };
}

let state: State = load();
const subs = new Set<() => void>();

function commit(next: State) {
  state = { items: next.items.slice(0, currentMax()) };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  subs.forEach(fn => fn());
}

// Re-trim the feed whenever the user drags the MODULES · NOTIFY FEED CAP
// slider down below the current count. Subscribing at module scope means
// we don't need any hook wired inside the page — the log self-heals.
if (typeof window !== 'undefined') {
  let lastCap = currentMax();
  useView.subscribe(s => {
    const nextCap = s.settings.notifyLogCap;
    if (nextCap === lastCap) return;
    lastCap = nextCap;
    if (state.items.length > nextCap) {
      commit({ items: state.items });
    }
  });
}

export function useNotifyLog(): ReadonlyArray<NotifyRecord> {
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => subs.delete(fn); },
    () => state.items,
    () => state.items,
  );
}

export function recordNotify(n: Omit<NotifyRecord, 'id' | 'at'> & Partial<Pick<NotifyRecord, 'at'>>): NotifyRecord {
  const rec: NotifyRecord = {
    id: `n-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    at: n.at ?? Math.floor(Date.now() / 1000),
    ...n,
  };
  commit({ items: [rec, ...state.items] });
  return rec;
}

export function clearNotify(id: string): void {
  commit({ items: state.items.filter(i => i.id !== id) });
}

export function clearAll(): void { commit({ items: [] }); }

export async function sendMacNotification(
  title: string,
  body: string,
  sound?: NotifySound | null,
): Promise<NotifyRecord> {
  await invokeSafe('notify_send', { title, body, sound: sound ?? null });
  return recordNotify({ title, body, tone: 'info', from_sunny: false, sound: sound ?? null });
}
