// Transient per-proxy inbox: pending incoming messages awaiting AI reply, and
// generated drafts waiting for human review.
//
// This is intentionally separate from `src/store/proxy.ts` so the heavy,
// high-frequency state (arrives every ~5s when the watcher ticks) doesn't
// force re-serialisation of the lightweight proxy config. Nothing here is
// persisted — if the app quits mid-draft we'd rather regenerate than stash a
// stale suggestion.

import { create } from 'zustand';

export type ProxyDraft = Readonly<{
  id: string;
  /** chat_identifier */
  handle: string;
  /** Message body SUNNY generated. */
  body: string;
  /** Original incoming message we drafted in response to. */
  triggerText: string;
  /** ROWID of the trigger message so we can mark it seen on send. */
  triggerRowid: number;
  /** Wall-clock when the draft was produced. */
  createdAt: number;
  status: 'pending' | 'sent' | 'skipped' | 'error';
  /** Error message if status === 'error'. */
  errorMessage?: string;
}>;

type ProxyInboxState = {
  readonly drafts: ReadonlyArray<ProxyDraft>;
  readonly addDraft: (draft: Omit<ProxyDraft, 'id' | 'createdAt' | 'status'>) => string;
  readonly updateDraft: (id: string, patch: Partial<ProxyDraft>) => void;
  readonly removeDraft: (id: string) => void;
  readonly forHandle: (handle: string) => ReadonlyArray<ProxyDraft>;
  /**
   * Mark every pending draft for `handle` as skipped. Called when the user
   * sends a manual reply (so the proxy doesn't also fire one) and when the
   * engine detects the user already replied out-of-band.
   */
  readonly cancelPendingForHandle: (handle: string, reason?: 'superseded' | 'user-sent') => number;
};

function makeId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_DRAFTS = 40;

export const useProxyInbox = create<ProxyInboxState>((set, get) => ({
  drafts: [],
  addDraft: input => {
    const draft: ProxyDraft = {
      ...input,
      id: makeId(),
      createdAt: Date.now(),
      status: 'pending',
    };
    set(state => ({
      drafts: [draft, ...state.drafts].slice(0, MAX_DRAFTS),
    }));
    return draft.id;
  },
  updateDraft: (id, patch) => {
    set(state => ({
      drafts: state.drafts.map(d => (d.id === id ? { ...d, ...patch } : d)),
    }));
  },
  removeDraft: id => {
    set(state => ({ drafts: state.drafts.filter(d => d.id !== id) }));
  },
  forHandle: handle => get().drafts.filter(d => d.handle === handle),
  cancelPendingForHandle: (handle, reason = 'superseded') => {
    let cancelled = 0;
    set(state => ({
      drafts: state.drafts.map(d => {
        if (d.handle !== handle || d.status !== 'pending') return d;
        cancelled += 1;
        return {
          ...d,
          status: 'skipped' as const,
          errorMessage:
            reason === 'user-sent'
              ? 'You replied manually — SUNNY skipped this draft.'
              : 'Superseded by a newer message.',
        };
      }),
    }));
    return cancelled;
  },
}));
