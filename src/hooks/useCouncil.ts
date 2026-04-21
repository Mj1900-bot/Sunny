/**
 * useCouncil — subscribe to council streaming delta events and manage
 * per-member token accumulation.
 *
 * Calls `invoke('council_start', { prompt, members })` to kick off the
 * council, then subscribes to per-member `CouncilDelta` and `CouncilDone`
 * events via the Tauri raw listener.
 *
 * All state is immutable (Zustand / useState spread patterns).
 */
import { useCallback, useRef, useState } from 'react';
import { invoke, listen, isTauri } from '../lib/tauri';

export interface CouncilMember {
  readonly name: string;
  readonly model: string;
}

export interface MemberState {
  readonly name: string;
  readonly model: string;
  readonly tokens: string;
  readonly done: boolean;
}

export type CouncilStatus = 'idle' | 'running' | 'complete' | 'error';

export interface UseCouncilResult {
  readonly status: CouncilStatus;
  readonly members: readonly MemberState[];
  readonly synthesis: string | null;
  readonly error: string | null;
  readonly start: (prompt: string, members: CouncilMember[]) => void;
  readonly dismiss: () => void;
}

export function useCouncil(): UseCouncilResult {
  const [status, setStatus] = useState<CouncilStatus>('idle');
  const [members, setMembers] = useState<readonly MemberState[]>([]);
  const [synthesis, setSynthesis] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unlistensRef = useRef<Array<() => void>>([]);

  const cleanup = useCallback(() => {
    for (const fn of unlistensRef.current) fn();
    unlistensRef.current = [];
  }, []);

  const dismiss = useCallback(() => {
    cleanup();
    setStatus('idle');
    setMembers([]);
    setSynthesis(null);
    setError(null);
  }, [cleanup]);

  const start = useCallback(
    (prompt: string, councilMembers: CouncilMember[]) => {
      if (status === 'running') return;

      cleanup();

      const initial: MemberState[] = councilMembers.map(m => ({
        name: m.name,
        model: m.model,
        tokens: '',
        done: false,
      }));
      setMembers(initial);
      setStatus('running');
      setSynthesis(null);
      setError(null);

      const setup = async () => {
        if (!isTauri) {
          setError('Council requires Tauri runtime');
          setStatus('error');
          return;
        }

        try {
          // Subscribe to per-member delta events BEFORE invoking so no
          // events are missed during the async gap.
          const unlistenDelta = await listen<{
            member_idx: number;
            token: string;
            at: number;
          }>('sunny://council.delta', payload => {
            setMembers(prev =>
              prev.map((m, idx) =>
                idx === payload.member_idx
                  ? { ...m, tokens: m.tokens + payload.token }
                  : m,
              ),
            );
          });
          unlistensRef.current.push(unlistenDelta);

          const unlistenDone = await listen<{
            member_idx: number;
            final_text: string;
            at: number;
          }>('sunny://council.done', payload => {
            setMembers(prev =>
              prev.map((m, idx) =>
                idx === payload.member_idx
                  ? { ...m, tokens: payload.final_text, done: true }
                  : m,
              ),
            );
          });
          unlistensRef.current.push(unlistenDone);

          // Kick off the council run. The result is the synthesis text.
          const result = await invoke<string>('council_start', {
            prompt,
            members: councilMembers,
          });

          setSynthesis(result);
          setStatus('complete');
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          setStatus('error');
        }
      };

      void setup();
    },
    [status, cleanup],
  );

  return { status, members, synthesis, error, start, dismiss };
}
