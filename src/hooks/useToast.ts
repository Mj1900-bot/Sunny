import { useMemo } from 'react';
import { useToastStore } from '../store/toasts';

type ToastApi = {
  readonly success: (text: string, ttlMs?: number) => string;
  readonly error: (text: string, ttlMs?: number) => string;
  readonly info: (text: string, ttlMs?: number) => string;
};

type UseToastReturn = {
  readonly toast: ToastApi;
};

// Stable API bound to the store's singleton — identities never change
// across renders because `useToastStore.getState` is stable.
const TOAST_API: ToastApi = {
  success: (text, ttlMs) => useToastStore.getState().push('success', text, ttlMs),
  error: (text, ttlMs) => useToastStore.getState().push('error', text, ttlMs),
  info: (text, ttlMs) => useToastStore.getState().push('info', text, ttlMs),
};

export function useToast(): UseToastReturn {
  // useMemo with empty deps guarantees the same object reference per hook call.
  // The underlying functions are module-level constants, so identities are
  // stable across renders AND across separate useToast() consumers.
  return useMemo(() => ({ toast: TOAST_API }), []);
}

// Imperative escape hatch for non-React callers (e.g. error boundaries,
// event listeners wired outside the component tree).
export const toast: ToastApi = TOAST_API;
