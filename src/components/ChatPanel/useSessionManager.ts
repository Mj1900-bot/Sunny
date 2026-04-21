/**
 * useSessionManager — manages session id lifecycle and resumption for ChatPanel.
 *
 * Owns: sessionIdRef, activeSessionId, historyRef, clear, resumeSession, and
 * the mount-time "Remembering N earlier turns" hydration hint.
 */
import { useCallback, useRef, useState } from 'react';
import { invokeSafe } from '../../lib/tauri';
import {
  loadSessionId,
  rotateSessionId,
  persistSessionId,
  turnsToMessages,
  MAX_LLM_TURNS,
} from './session';
import type { Message, Turn } from './session';

const REMEMBER_HINT_MS = 5000;

type SessionManagerResult = {
  sessionIdRef: React.MutableRefObject<string>;
  historyRef: React.MutableRefObject<Array<{ role: 'user' | 'assistant'; content: string }>>;
  activeSessionId: string;
  rememberedCount: number;
  clear: (onClear: () => void) => void;
  resumeSession: (sid: string, onMessages: (msgs: Message[]) => void) => Promise<void>;
  probeHydration: (hasLocalMessages: boolean) => () => void;
};

export function useSessionManager(): SessionManagerResult {
  const sessionIdRef = useRef<string>(loadSessionId());
  const historyRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => sessionIdRef.current,
  );
  const [rememberedCount, setRememberedCount] = useState<number>(0);

  const clear = useCallback((onClear: () => void) => {
    const rotated = rotateSessionId();
    sessionIdRef.current = rotated;
    setActiveSessionId(rotated);
    historyRef.current = [];
    onClear();
  }, []);

  // On mount, probe the Rust side for persisted turns (Sprint-7 D).
  // Returns a cleanup function — caller is responsible for running in useEffect.
  const probeHydration = useCallback((hasLocalMessages: boolean) => {
    if (hasLocalMessages) return () => {};
    let cancelled = false;
    let fadeTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      try {
        const tail = await invokeSafe<Turn[]>(
          'conversation_tail',
          { sessionId: sessionIdRef.current, limit: 4 },
        );
        if (cancelled) return;
        if (!Array.isArray(tail) || tail.length === 0) return;
        const valid = tail.filter(
          (t): t is Turn =>
            !!t &&
            typeof t === 'object' &&
            typeof (t as Turn).role === 'string' &&
            typeof (t as Turn).content === 'string',
        );
        if (valid.length === 0) return;
        setRememberedCount(valid.length);
        fadeTimer = setTimeout(() => {
          if (!cancelled) setRememberedCount(0);
        }, REMEMBER_HINT_MS);
      } catch (error) {
        console.error('ChatPanel: conversation_tail probe failed', error);
      }
    })();

    return () => {
      cancelled = true;
      if (fadeTimer) clearTimeout(fadeTimer);
    };
  }, []);

  // Resume a past session: switch session_id, load tail, seed LLM history.
  const resumeSession = useCallback(async (
    sid: string,
    onMessages: (msgs: Message[]) => void,
  ) => {
    if (!sid || sid === sessionIdRef.current) return;
    sessionIdRef.current = sid;
    setActiveSessionId(sid);
    persistSessionId(sid);
    try {
      const tail = await invokeSafe<Turn[]>(
        'conversation_tail',
        { sessionId: sid, limit: 20 },
      );
      if (Array.isArray(tail) && tail.length > 0) {
        const valid = tail.filter(
          (t): t is Turn =>
            !!t &&
            typeof t === 'object' &&
            typeof (t as Turn).role === 'string' &&
            typeof (t as Turn).content === 'string',
        );
        const msgs = turnsToMessages(valid);
        onMessages(msgs);
        const replay = valid
          .filter(t => t.role === 'user' || t.role === 'assistant')
          .map(t => ({ role: t.role as 'user' | 'assistant', content: t.content }));
        const max = MAX_LLM_TURNS * 2;
        historyRef.current = replay.length > max ? replay.slice(-max) : replay;
      } else {
        onMessages([]);
        historyRef.current = [];
      }
    } catch (error) {
      console.error('ChatPanel: resumeSession failed', error);
      onMessages([]);
      historyRef.current = [];
    }
  }, []);

  return {
    sessionIdRef,
    historyRef,
    activeSessionId,
    rememberedCount,
    clear,
    resumeSession,
    probeHydration,
  };
}
