// Daemons store — persistent AI goals that SUNNY runs on schedule or on
// user-dispatched events. Wraps the Rust `daemons_*` commands (see
// src-tauri/src/daemons.rs) with a zustand cache so multiple pages share
// a single live list.
//
// Runtime is separate — see `lib/daemonRuntime.ts`, which polls
// `daemons_ready_to_fire` every tick and dispatches fires through the
// sub-agent runner.
//
// The wire-compatible `Daemon` shape is re-exported from the
// auto-generated ts-rs bindings (`src/bindings/Daemon.ts`). Regenerate
// with `cd src-tauri && cargo test --lib export_bindings_`.
//
// `DaemonSpec` keeps its legacy optional-fields shape here because
// callers (templates.ts, AgentsTab) omit fields like `at`, `on_event`,
// and `max_runs` when they don't apply. The Rust-side DaemonSpec has
// them as required-nullable; serde happily accepts missing fields as
// `None`, so the loose TS shape is wire-compatible.

import { create } from 'zustand';
import { invoke, invokeSafe, isTauri } from '../lib/tauri';
import type { Daemon as BindingDaemon } from '../bindings/Daemon';

// ---------------------------------------------------------------------------
// Wire-compatible types
// ---------------------------------------------------------------------------

export type DaemonKind = 'once' | 'interval' | 'on_event';

export type Daemon = BindingDaemon;

export type DaemonSpec = {
  readonly title: string;
  readonly kind: DaemonKind;
  readonly at?: number | null;
  readonly every_sec?: number | null;
  readonly on_event?: string | null;
  readonly goal: string;
  readonly max_runs?: number | null;
};

// ---------------------------------------------------------------------------
// API bindings
// ---------------------------------------------------------------------------

export async function daemonsList(): Promise<ReadonlyArray<Daemon>> {
  const out = await invokeSafe<ReadonlyArray<Daemon>>('daemons_list');
  return out ?? [];
}

export function daemonsAdd(spec: DaemonSpec): Promise<Daemon> {
  return invoke<Daemon>('daemons_add', { spec });
}

export function daemonsUpdate(id: string, patch: Partial<DaemonSpec> & Record<string, unknown>): Promise<Daemon> {
  return invoke<Daemon>('daemons_update', { id, patch });
}

export function daemonsDelete(id: string): Promise<void> {
  return invoke<void>('daemons_delete', { id });
}

export function daemonsSetEnabled(id: string, enabled: boolean): Promise<Daemon> {
  return invoke<Daemon>('daemons_set_enabled', { id, enabled });
}

export function daemonsReadyToFire(nowSecs: number): Promise<ReadonlyArray<Daemon>> {
  return invoke<ReadonlyArray<Daemon>>('daemons_ready_to_fire', { nowSecs });
}

export function daemonsMarkFired(
  id: string,
  nowSecs: number,
  status: string,
  output: string,
): Promise<Daemon> {
  return invoke<Daemon>('daemons_mark_fired', { id, nowSecs, status, output });
}

// ---------------------------------------------------------------------------
// Zustand cache + shared refresh
// ---------------------------------------------------------------------------

type DaemonsState = {
  readonly list: ReadonlyArray<Daemon>;
  readonly loaded: boolean;
  readonly lastError: string | null;
  readonly refresh: () => Promise<void>;
  readonly _setList: (list: ReadonlyArray<Daemon>) => void;
};

export const useDaemons = create<DaemonsState>((set) => ({
  list: [],
  loaded: false,
  lastError: null,

  refresh: async () => {
    if (!isTauri) {
      set({ loaded: true });
      return;
    }
    try {
      const list = await daemonsList();
      set({ list, loaded: true, lastError: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ lastError: msg, loaded: true });
    }
  },

  _setList: (list: ReadonlyArray<Daemon>) => set({ list }),
}));

// ---------------------------------------------------------------------------
// UX helpers
// ---------------------------------------------------------------------------

export function describeSchedule(d: Daemon): string {
  if (d.kind === 'once') {
    if (!d.at) return 'once · no time';
    const date = new Date(d.at * 1000);
    return `once · ${date.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })}`;
  }
  if (d.kind === 'interval') {
    return `every ${humanizeSecs(d.every_sec ?? 0)}`;
  }
  if (d.kind === 'on_event') {
    return `on event · ${d.on_event ?? '—'}`;
  }
  return d.kind;
}

export function humanizeSecs(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) {
    const h = s / 3600;
    return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
  }
  const d = s / 86_400;
  return d === Math.floor(d) ? `${d}d` : `${d.toFixed(1)}d`;
}

export function nextRunRelative(nextRun: number | null): string {
  if (nextRun === null) return '—';
  const diff = nextRun - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'now';
  if (diff < 60) return `in ${diff}s`;
  if (diff < 3600) return `in ${Math.round(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.round(diff / 3600)}h`;
  return `in ${Math.round(diff / 86400)}d`;
}

export function lastRunRelative(lastRun: number | null): string {
  if (lastRun === null) return 'never';
  const diff = Math.floor(Date.now() / 1000) - lastRun;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
