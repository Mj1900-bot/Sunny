/**
 * useAutopilotSettings — central state + sync hook for the Autopilot tab.
 *
 * Responsibilities:
 *   1. On mount: call `settings_get` (or stub), populate local state.
 *   2. On change: debounce 300 ms, call `settings_update` with partial diff.
 *   3. On `sunny://settings/changed` event: reconcile with incoming payload.
 *   4. Optimistic UI: track which fields are "pending" (awaiting server ACK).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAutopilotSettings,
  updateAutopilotSettings,
  subscribeSettingsChanged,
} from './autopilotCommands';
import {
  parseAutopilotSettings,
  AUTOPILOT_DEFAULTS,
  type AutopilotSettings,
  type PendingKeys,
} from './autopilotTypes';

const DEBOUNCE_MS = 300;

export type UseAutopilotSettingsResult = {
  readonly settings: AutopilotSettings;
  readonly pending: PendingKeys;
  readonly patch: (diff: Partial<AutopilotSettings>) => void;
};

export function useAutopilotSettings(): UseAutopilotSettingsResult {
  const [settings, setSettings] = useState<AutopilotSettings>(AUTOPILOT_DEFAULTS);
  const [pending, setPending] = useState<Set<keyof AutopilotSettings>>(new Set());

  // Holds the latest committed snapshot so the debounced flush always
  // uses the freshest state, not a stale closure copy.
  const committedRef = useRef<AutopilotSettings>(AUTOPILOT_DEFAULTS);
  const debounceTimerRef = useRef<number | null>(null);
  const pendingDiffRef = useRef<Partial<AutopilotSettings>>({});

  // On mount: load settings from backend / stub
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const loaded = await fetchAutopilotSettings();
        if (alive) {
          setSettings(loaded);
          committedRef.current = loaded;
        }
      } catch {
        // fetchAutopilotSettings never throws, but guard anyway
      }
    })();
    return () => { alive = false; };
  }, []);

  // Subscribe to cross-instance updates
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await subscribeSettingsChanged((raw: unknown) => {
        // Reconcile: merge validated incoming payload over current state
        const incoming = parseAutopilotSettings(raw);
        if (!incoming) return;
        setSettings(prev => {
          const next = { ...prev, ...incoming };
          committedRef.current = next;
          return next;
        });
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  const flushUpdate = useCallback(async (diff: Partial<AutopilotSettings>): Promise<void> => {
    const base = committedRef.current;
    try {
      await updateAutopilotSettings(base, diff);
      const next: AutopilotSettings = { ...base, ...diff };
      committedRef.current = next;
    } finally {
      // Clear pending indicators for keys in this batch
      setPending(prev => {
        const next = new Set(prev);
        for (const k of Object.keys(diff) as Array<keyof AutopilotSettings>) {
          next.delete(k);
        }
        return next;
      });
    }
  }, []);

  const patch = useCallback((diff: Partial<AutopilotSettings>): void => {
    // Optimistic: apply immediately to the UI
    setSettings(prev => ({ ...prev, ...diff }));

    // Mark keys as pending
    setPending(prev => {
      const next = new Set(prev);
      for (const k of Object.keys(diff) as Array<keyof AutopilotSettings>) {
        next.add(k);
      }
      return next;
    });

    // Accumulate into the pending diff
    pendingDiffRef.current = { ...pendingDiffRef.current, ...diff };

    // Debounce the backend flush
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      const batchedDiff = pendingDiffRef.current;
      pendingDiffRef.current = {};
      void flushUpdate(batchedDiff);
    }, DEBOUNCE_MS);
  }, [flushUpdate]);

  return { settings, pending, patch };
}
