import { create } from 'zustand';
import { useView } from './view';

export type Confirmation = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly verb: 'RUN' | 'SEND' | 'DELETE' | 'OPEN' | 'EXECUTE' | string;
  readonly preview: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly createdAt: number;
};

export type ConfirmationInput = Omit<Confirmation, 'id' | 'createdAt'>;

type SafetyState = {
  readonly queue: ReadonlyArray<Confirmation>;
  readonly request: (c: ConfirmationInput) => Promise<boolean>;
  readonly accept: (id: string) => void;
  readonly reject: (id: string) => void;
};

// Resolvers are intentionally kept out of zustand state. Functions are not
// serialisable (devtools / persistence plugins choke on them), and stuffing
// callbacks through React state churn triggers the "non-serializable value"
// warnings. A module-local Map is enough — it lives for the lifetime of the
// tab, is only touched by `request` / `accept` / `reject`, and never has to
// participate in React's reconciliation.
const resolvers = new Map<string, (ok: boolean) => void>();

function makeId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function settle(id: string, ok: boolean): void {
  const fn = resolvers.get(id);
  if (fn) {
    resolvers.delete(id);
    try {
      fn(ok);
    } catch (error) {
      // A faulty resolver must never poison the queue drain.
      console.error('[safety] resolver threw:', error);
    }
  }
}

export const useSafety = create<SafetyState>((set, get) => ({
  queue: [],
  request: (input: ConfirmationInput) => {
    // Auto-approve low-risk actions when the user has opted in from the
    // Models tab. Medium and high risk always surface the modal — the
    // countdown guard on "high" is the last line of defence against an
    // agent-prompted rm -rf, so we never bypass it silently.
    if (input.risk === 'low' && useView.getState().settings.autoApproveSafe) {
      return Promise.resolve(true);
    }
    const id = makeId();
    const item: Confirmation = {
      ...input,
      id,
      createdAt: Date.now(),
    };
    return new Promise<boolean>(resolve => {
      resolvers.set(id, resolve);
      set(state => ({ queue: [...state.queue, item] }));
    });
  },
  accept: (id: string) => {
    const { queue } = get();
    // Only the head may be accepted — multiple dialogs are shown oldest-first
    // so the user's click always targets what's on screen.
    if (queue.length === 0 || queue[0].id !== id) return;
    set({ queue: queue.slice(1) });
    settle(id, true);
  },
  reject: (id: string) => {
    const { queue } = get();
    if (queue.length === 0 || queue[0].id !== id) return;
    set({ queue: queue.slice(1) });
    settle(id, false);
  },
}));
