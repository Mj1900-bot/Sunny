/**
 * useChatMessages — manages the messages[] list, streaming state, and the
 * send pipeline for ChatPanel.
 *
 * Owns: messages, sending, streamingIdRef, handleSend, onChatChunk/onChatDone
 * subscriptions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { onChatChunk, onChatDone } from '../../hooks/useSunny';
import { useVoiceChatStore } from '../../store/voiceChat';
import { makeId, saveHistory, loadHistory, MAX_LLM_TURNS } from './session';
import type { Message, Role } from './session';
import { unwrapAgentEnvelope } from './unwrapEnvelope';

/**
 * True while useVoiceChat is actively driving TTS for a turn. The voice
 * hook flips this in onSpeakStart and clears it after its speaker flush.
 * When set, the chat-panel pipeline MUST NOT call speak() — otherwise
 * two independent pipelines both send the reply to Kokoro, the backend
 * dedup can't catch it because voice streams by sentence while chat
 * speaks the whole reply (different strings → dedup miss), and the user
 * hears two overlapping voices.
 */
function isVoiceSpeaking(): boolean {
  return useVoiceChatStore.getState().isVoiceSpeaking;
}

type SendOptions = {
  chat: (text: string, opts: {
    provider: string;
    model: string;
    session_id: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  }) => Promise<string | null>;
  speak: (text: string) => Promise<void>;
  provider: string;
  model: string;
  sessionIdRef: React.MutableRefObject<string>;
  historyRef: React.MutableRefObject<Array<{ role: 'user' | 'assistant'; content: string }>>;
};

export function useChatMessages(opts: SendOptions) {
  const { chat, speak, provider, model, sessionIdRef, historyRef } = opts;

  const [messages, setMessages] = useState<Message[]>(() => loadHistory());
  const [sending, setSending] = useState(false);
  const streamingIdRef = useRef<string | null>(null);
  // Dupe-TTS guard. onChatDone (event) and handleSend's invoke-return
  // (belt-and-braces) both want to speak the final text. Whichever
  // path fires first flips this; the loser checks and skips. Reset
  // at the start of each handleSend call so the next turn is armed.
  const spokeForTurnRef = useRef(false);

  // Persist to localStorage on change
  useEffect(() => {
    saveHistory(messages);
  }, [messages]);

  // Subscribe to streaming chat chunks
  useEffect(() => {
    const unsubPromise = onChatChunk(({ delta, done }) => {
      if (!delta && !done) return;
      setMessages(prev => {
        const activeId = streamingIdRef.current;
        if (activeId) {
          return prev.map(m =>
            m.id === activeId ? { ...m, text: m.text + (delta ?? ''), streaming: !done } : m,
          );
        }
        // New turn starting (could be text OR voice-driven — voice turns
        // don't go through handleSend, so reset the dedup flag here too,
        // otherwise onChatDone bails permanently after the first turn).
        spokeForTurnRef.current = false;
        const id = makeId();
        streamingIdRef.current = id;
        return [
          ...prev,
          { id, role: 'sunny' as Role, text: delta ?? '', ts: Date.now(), streaming: !done },
        ];
      });
    });
    return () => { unsubPromise.then(fn => fn && fn()); };
  }, []);

  // Subscribe to chat done — finalize + speak.
  // If handleSend's invoke-return already finalized this turn (flips
  // spokeForTurnRef to true), bail out entirely — otherwise we'd
  // re-append a duplicate Sunny message AND speak again.
  useEffect(() => {
    const unsubPromise = onChatDone(full => {
      if (spokeForTurnRef.current) {
        // Invoke-return path already wrote the final message and
        // fired speak(). Clean up streamingIdRef and exit.
        streamingIdRef.current = null;
        setSending(false);
        return;
      }
      const activeId = streamingIdRef.current;
      streamingIdRef.current = null;
      const cleanFull = full && full.length > 0 ? unwrapAgentEnvelope(full) : '';
      // Detect tool-only turn: full was a non-answer envelope (unwrap
      // returned empty) but the raw full was non-empty. In that case
      // the streaming bubble holds the raw JSON — drop it entirely
      // rather than leaving '(no reply)' or the envelope text in the
      // transcript.
      const wasToolOnly = !!full && full.length > 0 && cleanFull.length === 0;
      setMessages(prev => {
        if (wasToolOnly && activeId) {
          return prev.filter(m => m.id !== activeId);
        }
        if (activeId && prev.some(m => m.id === activeId)) {
          return prev.map(m =>
            m.id === activeId
              ? { ...m, text: cleanFull.length > 0 ? cleanFull : m.text, streaming: false }
              : m,
          );
        }
        if (cleanFull.length > 0) {
          return [...prev, { id: makeId(), role: 'sunny' as Role, text: cleanFull, ts: Date.now() }];
        }
        return prev;
      });
      if (cleanFull.length > 0) {
        spokeForTurnRef.current = true;
        // Skip if useVoiceChat already owns TTS for this turn (voice
        // turn driving the chat panel via event-bus mirror). Without
        // this guard the user hears Kokoro twice in parallel.
        if (!isVoiceSpeaking()) {
          speak(cleanFull).catch(err => console.error('ChatPanel: speak failed', err));
        }
      }
      setSending(false);
    });
    return () => { unsubPromise.then(fn => fn && fn()); };
  }, [speak]);

  const handleSend = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      setSending(true);
      // Arm the dupe-TTS guard for this turn — one of onChatDone or
      // the invoke-return speak() call will flip it to true.
      spokeForTurnRef.current = false;
      const userMsg: Message = { id: makeId(), role: 'user', text, ts: Date.now() };
      const sunnyId = makeId();
      streamingIdRef.current = sunnyId;
      const sunnyMsg: Message = {
        id: sunnyId, role: 'sunny', text: '', ts: Date.now(), streaming: true,
      };
      setMessages(prev => [...prev, userMsg, sunnyMsg]);
      try {
        const reply = await chat(text, {
          provider,
          model,
          session_id: sessionIdRef.current,
          history: historyRef.current,
        });
        // Belt-and-braces finalization. onChatDone normally wraps up the
        // bubble, but may race or not fire. Using the invoke return value as
        // authoritative final text fixes that idempotently.
        const hasReply = typeof reply === 'string' && reply.length > 0;
        const cleanReply = hasReply ? unwrapAgentEnvelope(reply as string) : '';
        if (hasReply && cleanReply.length > 0) {
          // Store the unwrapped text in history so subsequent turns feed
          // human text back to the model, not the JSON envelope — the
          // envelope round-trip confuses smaller models into echoing.
          const next = [
            ...historyRef.current,
            { role: 'user' as const, content: text },
            { role: 'assistant' as const, content: cleanReply },
          ];
          const max = MAX_LLM_TURNS * 2;
          historyRef.current = next.length > max ? next.slice(-max) : next;
        }
        const doneAlreadyFired = streamingIdRef.current === null;
        streamingIdRef.current = null;
        // Tool-only turn: raw reply was a non-answer envelope and
        // unwrapped to nothing. Remove the placeholder sunnyMsg so we
        // don't leave '(no reply)' in the transcript.
        const wasToolOnly = hasReply && cleanReply.length === 0;
        setMessages(prev => {
          if (wasToolOnly) return prev.filter(m => m.id !== sunnyId);
          return prev.map(m => {
            if (m.id !== sunnyId) return m;
            const finalText = cleanReply.length > 0
              ? cleanReply
              : m.text.length > 0
              ? m.text
              : '(no reply)';
            return { ...m, text: finalText, streaming: false };
          });
        });
        if (cleanReply.length > 0 && !doneAlreadyFired && !spokeForTurnRef.current) {
          spokeForTurnRef.current = true;
          // Same guard as onChatDone — if voice owns TTS for this turn,
          // don't fire a parallel chat speak().
          if (!isVoiceSpeaking()) {
            speak(cleanReply).catch(err => console.error('ChatPanel: speak failed', err));
          }
        }
        setSending(false);
      } catch (error) {
        console.error('ChatPanel: chat failed', error);
        streamingIdRef.current = null;
        setMessages(prev =>
          prev
            .filter(m => m.id !== sunnyId || m.text.length > 0)
            .concat([{
              id: makeId(),
              role: 'system' as Role,
              text: `CHAT FAILED: ${error instanceof Error ? error.message : String(error)}`,
              ts: Date.now(),
            }]),
        );
        setSending(false);
      }
    },
    [chat, provider, model, sending, speak, sessionIdRef, historyRef],
  );

  return { messages, setMessages, sending, handleSend, streamingIdRef };
}
