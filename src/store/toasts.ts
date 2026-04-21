import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';

export type Toast = {
  readonly id: string;
  readonly kind: ToastKind;
  readonly text: string;
  readonly ttlMs: number;
  readonly createdAt: number;
};

type ToastState = {
  readonly toasts: readonly Toast[];
  readonly push: (kind: ToastKind, text: string, ttlMs?: number) => string;
  readonly dismiss: (id: string) => void;
};

const DEFAULT_TTL_MS = 4000;
const MAX_TOASTS = 5;

function makeId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text, ttlMs = DEFAULT_TTL_MS) => {
    const id = makeId();
    const next: Toast = {
      id,
      kind,
      text,
      ttlMs,
      createdAt: Date.now(),
    };
    set(state => {
      const appended = [...state.toasts, next];
      // Drop oldest (front) when exceeding cap.
      const trimmed =
        appended.length > MAX_TOASTS
          ? appended.slice(appended.length - MAX_TOASTS)
          : appended;
      return { toasts: trimmed };
    });
    if (ttlMs > 0) {
      setTimeout(() => {
        // Read latest state at fire time — toast may already be gone.
        const current = get().toasts;
        if (current.some(t => t.id === id)) {
          get().dismiss(id);
        }
      }, ttlMs);
    }
    return id;
  },
  dismiss: id =>
    set(state => ({
      toasts: state.toasts.filter(t => t.id !== id),
    })),
}));
