import { invoke as rawInvoke } from '@tauri-apps/api/core';
import { listen as rawListen, type UnlistenFn } from '@tauri-apps/api/event';

export type { UnlistenFn };

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error(`Tauri command "${cmd}" unavailable outside of Tauri runtime`);
  return rawInvoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  return rawListen<T>(event, e => cb(e.payload));
}

export async function invokeSafe<T>(cmd: string, args?: Record<string, unknown>, fallback?: T): Promise<T | null> {
  if (!isTauri) return fallback ?? null;
  try { return await rawInvoke<T>(cmd, args); }
  catch (e) { console.error(`invoke ${cmd} failed`, e); return fallback ?? null; }
}
