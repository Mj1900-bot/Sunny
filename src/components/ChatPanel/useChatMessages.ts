/**
 * useChatMessages — manages the messages[] list, streaming state, and the
 * send pipeline for ChatPanel.
 *
 * Owns: messages, sending, streamingIdRef, handleSend, onChatChunk/onChatDone
 * subscriptions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { onChatChunk, onChatDone } from '../../hooks/useSunny';
import { makeId, saveHistory, loadHistory, MAX_LLM_TURNS } from './session';
import type { Message, Role } from './session';

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

  // Subscribe to chat done — finalize + speak
  useEffect(() => {
    const unsubPromise = onChatDone(full => {
      const activeId = streamingIdRef.current;
      streamingIdRef.current = null;
      setMessages(prev => {
        if (activeId && prev.some(m => m.id === activeId)) {
          return prev.map(m =>
            m.id === activeId
              ? { ...m, text: full && full.length > 0 ? full : m.text, streaming: false }
              : m,
          );
        }
        if (full && full.length > 0) {
          return [...prev, { id: makeId(), role: 'sunny' as Role, text: full, ts: Date.now() }];
        }
        return prev;
      });
      const finalText = full && full.length > 0 ? full : '';
      if (finalText.length > 0) {
        speak(finalText).catch(err => console.error('ChatPanel: speak failed', err));
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
        if (hasReply) {
          const next = [
            ...historyRef.current,
            { role: 'user' as const, content: text },
            { role: 'assistant' as const, content: reply as string },
          ];
          const max = MAX_LLM_TURNS * 2;
          historyRef.current = next.length > max ? next.slice(-max) : next;
        }
        const doneAlreadyFired = streamingIdRef.current === null;
        streamingIdRef.current = null;
        setMessages(prev =>
          prev.map(m => {
            if (m.id !== sunnyId) return m;
            const finalText = hasReply
              ? (reply as string)
              : m.text.length > 0
              ? m.text
              : '(no reply)';
            return { ...m, text: finalText, streaming: false };
          }),
        );
        if (hasReply && !doneAlreadyFired) {
          speak(reply as string).catch(err => console.error('ChatPanel: speak failed', err));
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
