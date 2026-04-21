/**
 * usePlanExecuteBridge — listens for `sunny://plan-execute.step` events the
 * Rust plan_execute composite emits (plan/start, step/start, step/result,
 * step/error, recover/*, done/done). Stub implementation: logs each event
 * and exposes the latest snapshot via a zustand store so a future panel can
 * render it without another bridge refactor.
 *
 * The Rust-side payload shape:
 *   {
 *     phase: 'plan' | 'step' | 'recover' | 'done' | 'error',
 *     kind:  'start' | 'result' | 'timeout' | 'fallback' | 'done' | 'error' | 'abort',
 *     step_n?: number,
 *     total?: number,
 *     tool_name?: string,
 *     summary: string,
 *     result?: string,
 *     elapsed_ms: number,
 *   }
 *
 * Keep this minimal. When the UI grows a panel, extend the store rather
 * than the bridge so the contract here stays stable.
 */

import { useEffect } from 'react';
import { create } from 'zustand';

import { listen } from '../lib/tauri';

export type PlanExecuteEvent = {
  readonly phase: 'plan' | 'step' | 'recover' | 'done' | 'error' | string;
  readonly kind:
    | 'start'
    | 'result'
    | 'timeout'
    | 'fallback'
    | 'done'
    | 'error'
    | 'abort'
    | string;
  readonly step_n?: number;
  readonly total?: number;
  readonly tool_name?: string;
  readonly summary: string;
  readonly result?: string;
  readonly elapsed_ms: number;
};

type PlanExecuteState = {
  readonly events: ReadonlyArray<PlanExecuteEvent>;
  readonly lastEvent: PlanExecuteEvent | null;
  readonly running: boolean;
  readonly push: (event: PlanExecuteEvent) => void;
  readonly reset: () => void;
};

const MAX_BUFFER = 200;

export const usePlanExecuteLive = create<PlanExecuteState>((set) => ({
  events: [],
  lastEvent: null,
  running: false,
  push: (event) =>
    set((state) => {
      const next = state.events.length >= MAX_BUFFER
        ? [...state.events.slice(1), event]
        : [...state.events, event];
      const running = !(event.phase === 'done' && event.kind === 'done');
      return { events: next, lastEvent: event, running };
    }),
  reset: () => set({ events: [], lastEvent: null, running: false }),
}));

function isPlanExecuteEvent(value: unknown): value is PlanExecuteEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.phase === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.summary === 'string' &&
    typeof v.elapsed_ms === 'number'
  );
}

export function usePlanExecuteBridge(): void {
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    (async () => {
      const stop = await listen<unknown>('sunny://plan-execute.step', (payload) => {
        if (!active) return;
        if (!isPlanExecuteEvent(payload)) return;
        usePlanExecuteLive.getState().push(payload);
      });
      if (!active) {
        stop();
        return;
      }
      unlisten = stop;
    })();

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);
}
