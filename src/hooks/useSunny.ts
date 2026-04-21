import { useCallback } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { invoke, invokeSafe, listen, isTauri } from '../lib/tauri';
import { useView } from '../store/view';
import type { SunnyEvent } from './useEventBus';
// Generated from the Rust `ai::ChatRequest` struct via scripts/gen-types.ts
// (pnpm gen:types). Replaces the hand-maintained ChatRequest interface —
// adding/renaming a field in Rust now propagates to the frontend on the
// next build instead of drifting silently.
import type { ChatRequest as GeneratedChatRequest } from '../bindings/ChatRequest';
import { invokeCommand } from '../types/commands.generated';

export type ChatRequest = GeneratedChatRequest;
export type ChatChunk = { delta: string; done: boolean };

export function useSunny() {
  const provider = useView(s => s.settings.provider);
  const model = useView(s => s.settings.model);
  const voiceEnabled = useView(s => s.settings.voiceEnabled);
  const voiceName = useView(s => s.settings.voiceName);
  const voiceRate = useView(s => s.settings.voiceRate);

  const chat = useCallback(
    (message: string, opts?: Partial<ChatRequest>) =>
      invokeCommand('chat', {
        req: {
          message,
          provider: opts?.provider ?? provider ?? null,
          model: opts?.model ?? model ?? null,
          session_id: opts?.session_id ?? null,
          history: opts?.history ?? [],
          chat_mode: opts?.chat_mode ?? null,
        },
      }),
    [provider, model],
  );

  const speak = useCallback(
    (text: string) => {
      if (!voiceEnabled) return Promise.resolve();
      return invokeSafe<void>('speak', {
        text,
        voice: voiceName,
        rate: voiceRate,
      });
    },
    [voiceEnabled, voiceName, voiceRate],
  );

  const speakStop = useCallback(() => invokeSafe('speak_stop'), []);

  const openApp = useCallback((name: string) => invoke<void>('open_app', { name }), []);
  const openPath = useCallback((path: string) => invoke<void>('open_path', { path }), []);
  const runShell = useCallback((cmd: string) => invoke<{ stdout: string; stderr: string; code: number }>('run_shell', { cmd }), []);
  const listApps = useCallback(() => invoke<Array<{ name: string; path: string }>>('list_apps'), []);
  const fsList = useCallback((path: string) => invoke<Array<{ name: string; path: string; is_dir: boolean; size: number; modified_secs: number }>>('fs_list', { path }), []);

  return { chat, speak, speakStop, openApp, openPath, runShell, listApps, fsList };
}

// Sprint-9 migration: chat streaming now rides the Rust event bus's
// `SunnyEvent::ChatChunk` variant exclusively. `onChatChunk` / `onChatDone`
// are adapters over `event_bus_subscribe` that preserve the legacy
// Promise<UnlistenFn> shape so existing callers (ChatPanel) keep working
// without knowing about the bus. Terminal (`done: true`) chunks feed both
// callbacks: `onChatChunk` sees `{delta, done:true}` and `onChatDone` sees
// the accumulated text for that turn_id.
type ChatChunkEvent = Extract<SunnyEvent, { kind: 'ChatChunk' }>;

async function subscribeBusChatChunks(
  onChunk: (evt: ChatChunkEvent) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const channel = new Channel<SunnyEvent>();
  channel.onmessage = (evt: SunnyEvent) => {
    if (evt?.kind === 'ChatChunk') onChunk(evt);
  };
  try {
    const id = await invoke<number>('event_bus_subscribe', { channel });
    return () => {
      invoke('event_bus_unsubscribe', { id }).catch(() => {
        /* ignore — best-effort teardown */
      });
    };
  } catch (error) {
    console.error('onChatChunk/onChatDone: subscribe failed', error);
    return () => undefined;
  }
}

export function onChatChunk(cb: (c: ChatChunk) => void) {
  return subscribeBusChatChunks(evt => {
    cb({ delta: evt.delta, done: evt.done });
  });
}

export function onChatDone(cb: (full: string) => void) {
  // Accumulate deltas per-turn so the terminal chunk can deliver the full
  // composed answer — matches the legacy `sunny://chat.done` payload shape.
  // Bus events carry `turn_id`, so multiple concurrent turns (rare but
  // possible: chat pane + voice) don't cross-contaminate.
  const accumulators = new Map<string, string>();
  return subscribeBusChatChunks(evt => {
    const prev = accumulators.get(evt.turn_id) ?? '';
    const next = prev + evt.delta;
    if (evt.done) {
      accumulators.delete(evt.turn_id);
      cb(next);
    } else {
      accumulators.set(evt.turn_id, next);
    }
  });
}

export function onMenuEvent(cb: (id: string) => void) {
  return listen<string>('sunny://menu', cb);
}

export function onNavEvent(cb: (view: string) => void) {
  return listen<string>('sunny://nav', cb);
}
