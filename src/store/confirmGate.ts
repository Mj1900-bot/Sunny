// confirmGate — pending-request queue for agent-side ConfirmGate prompts.
//
// Two producers push into this queue:
//
//   1) Rust agent_loop — emits `sunny://agent.confirm.request` whenever a
//      side-effectful tool is about to fire, then blocks the ReAct loop
//      up to 30 s waiting for `sunny://agent.confirm.response`. The
//      bridge inside `<ConfirmGateModal />` forwards those into the
//      queue via `push(...)`, and `resolve(...)` emits the response
//      event back to Rust.
//
//   2) The TS agent loop (`lib/agentLoop.ts`) via `askConfirm(...)`.
//      Voice turns run through that loop and wire its `confirmDangerous`
//      callback into this store so voice-driven dangerous tools surface
//      the same gate the chat pane uses. Those requests resolve against
//      a local resolver map instead of emitting over Tauri — emitting
//      would confuse the Rust-side waiter which never issued the
//      request in the first place.
//
// `resolve` dispatches on requester source: TS-originated requests
// (tracked in `localResolvers`) settle the in-flight Promise; everything
// else falls through to the Rust response path.
//
// Shape follows the project's immutable style — every setter returns
// fresh object references so zustand subscribers re-render cleanly.

import { create } from 'zustand';
import { emit } from '@tauri-apps/api/event';

export type ConfirmRequest = {
  readonly id: string;
  readonly name: string;
  readonly preview?: string;
  readonly requester?: string;
  readonly receivedAt: number;
};

export type ConfirmResponsePayload = {
  readonly id: string;
  readonly approved: boolean;
  readonly reason?: string;
};

export type AskConfirmInput = {
  readonly tool: string;
  readonly input?: unknown;
  readonly source?: string;
};

type ConfirmGateState = {
  readonly queue: ReadonlyArray<ConfirmRequest>;
  readonly push: (req: Omit<ConfirmRequest, 'receivedAt'>) => void;
  readonly resolve: (id: string, approved: boolean, reason?: string) => void;
  readonly askConfirm: (req: AskConfirmInput) => Promise<boolean>;
  readonly clear: () => void;
};

const RESPONSE_EVENT = 'sunny://agent.confirm.response';

// Local resolvers for TS-originated requests. Kept out of zustand state
// because Promises/functions aren't serialisable and don't need to
// participate in React reconciliation — only the queue does.
const localResolvers = new Map<string, (ok: boolean) => void>();

function emitResponse(payload: ConfirmResponsePayload): void {
  void emit(RESPONSE_EVENT, payload).catch((err: unknown) => {
    // The Rust side times out on its own, so a failed emit is logged but
    // not fatal. We surface it so `useVoiceChat` / devtools show why a
    // turn stalled when the event channel is down.
    console.error('[confirmGate] failed to emit response:', err);
  });
}

function makeLocalId(): string {
  return `ts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function previewFromInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  try {
    const raw = typeof input === 'string' ? input : JSON.stringify(input);
    if (raw.length === 0) return undefined;
    return raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
  } catch {
    // Circular or otherwise unserialisable — skip preview rather than
    // let JSON.stringify throw into the caller.
    return undefined;
  }
}

export const useConfirmGate = create<ConfirmGateState>((set, get) => ({
  queue: [],
  push: req => {
    // Dedupe by id — duplicate Rust emits (re-mount / HMR) must not
    // stack the same prompt twice on screen.
    const { queue } = get();
    if (queue.some(q => q.id === req.id)) return;
    const next: ConfirmRequest = {
      id: req.id,
      name: req.name,
      preview: req.preview,
      requester: req.requester,
      receivedAt: Date.now(),
    };
    set({ queue: [...queue, next] });
  },
  resolve: (id, approved, reason) => {
    const { queue } = get();
    if (!queue.some(q => q.id === id)) return;
    // TS-originated request: settle the local Promise. No Tauri emit,
    // because Rust never issued this request and the corresponding
    // response waiter doesn't exist there.
    const localResolver = localResolvers.get(id);
    if (localResolver) {
      localResolvers.delete(id);
      try {
        localResolver(approved);
      } catch (err) {
        console.error('[confirmGate] local resolver threw:', err);
      }
    } else {
      emitResponse({ id, approved, reason });
    }
    set({ queue: queue.filter(q => q.id !== id) });
  },
  askConfirm: req => {
    const id = makeLocalId();
    const requester = req.source ? `ts:${req.source}` : 'ts';
    const item: ConfirmRequest = {
      id,
      name: req.tool,
      preview: previewFromInput(req.input),
      requester,
      receivedAt: Date.now(),
    };
    return new Promise<boolean>(resolve => {
      localResolvers.set(id, resolve);
      set(state => ({ queue: [...state.queue, item] }));
    });
  },
  clear: () => {
    // Settle any in-flight TS requests as denied so awaiting callers
    // don't hang forever when the queue is force-cleared.
    for (const [id, resolver] of localResolvers) {
      localResolvers.delete(id);
      try {
        resolver(false);
      } catch (err) {
        console.error('[confirmGate] clear resolver threw:', err);
      }
    }
    set({ queue: [] });
  },
}));
