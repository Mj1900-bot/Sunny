import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react';
import { Panel } from './Panel';
import { SessionPicker } from './SessionPicker';
import { TranscriptView } from './TranscriptView';
import { useSunny } from '../hooks/useSunny';
import { listen } from '../lib/tauri';
import { onSunnyAsk } from '../lib/askSunny';
import { useView } from '../store/view';
import { useVoiceChatStore } from '../store/voiceChat';
import { makeId } from './ChatPanel/session';
import { useChatMessages } from './ChatPanel/useChatMessages';
import { useSessionManager } from './ChatPanel/useSessionManager';
import {
  ROLE_LABEL,
  ROLE_BORDER,
  ROLE_WHO_COLOR,
  ROLE_BG,
  bodyStyle,
  listStyle,
  formStyle,
  inputStyle,
  emptyStyle,
  sessionRowStyle,
  msgTextStyle,
  msgRoleStyle,
} from './ChatPanel/styles';

export function ChatPanel() {
  const { chat, speak } = useSunny();
  const provider = useView(s => s.settings.provider);
  const model = useView(s => s.settings.model);

  // Voice transcript mirror — written by useVoiceChat via Zustand (fix sprint-14/item-4).
  // Subscribe to turnSeq (monotonic counter) so a repeated identical transcript still
  // triggers the effect. transcript is read inside the effect via getState() to avoid
  // a double render when both fields update in the same Zustand batch.
  const voiceTurnSeq = useVoiceChatStore(s => s.turnSeq);

  const session = useSessionManager();

  const { messages, setMessages, sending, handleSend } = useChatMessages({
    chat,
    speak,
    provider,
    model,
    sessionIdRef: session.sessionIdRef,
    historyRef: session.historyRef,
  });

  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // On mount probe the Rust side for persisted turns if local history is empty.
  const didHydrateRef = useRef(false);
  useEffect(() => {
    if (didHydrateRef.current) return;
    didHydrateRef.current = true;
    const cleanup = session.probeHydration(messages.length > 0);
    return cleanup;
    // Intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll on new/updated messages
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Mirror voice transcripts from useVoiceChat into the chat panel.
  //
  // Sprint-14 fix: the old design dispatched window CustomEvents from
  // useVoiceChat and listened for them here. The duplicate-detection relied
  // on a 2 s time-window race between two independent event producers
  // (Tauri listener + window listener). Now useVoiceChat writes directly to
  // the voiceChat Zustand store and ChatPanel subscribes to `turnSeq` — a
  // monotonic counter bumped on every new transcript — so the effect fires
  // exactly once per voice turn, with no race. Tauri `sunny://voice.transcript`
  // is kept as a fallback for future backend-side transcript producers.
  useEffect(() => {
    if (voiceTurnSeq === 0) return;
    const text = useVoiceChatStore.getState().transcript;
    const cleaned = text.trim();
    if (!cleaned) return;
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'user' && last.text === cleaned) return prev;
      return [...prev, { id: makeId(), role: 'user', text: cleaned, ts: Date.now() }];
    });
  // voiceTurnSeq is the sole dependency — transcript is read via getState().
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceTurnSeq]);

  // Tauri-side transcript events (reserved for future backend producers;
  // not dispatched by current code but kept for forward compatibility).
  useEffect(() => {
    const tauriUnsub = listen<{ text?: string } | string>(
      'sunny://voice.transcript',
      payload => {
        const raw = typeof payload === 'string' ? payload : payload?.text ?? '';
        const cleaned = raw.trim();
        if (!cleaned) return;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'user' && last.text === cleaned) return prev;
          return [...prev, { id: makeId(), role: 'user', text: cleaned, ts: Date.now() }];
        });
      },
    );
    return () => { tauriUnsub.then(fn => fn && fn()); };
  }, [setMessages]);

  // Any module page can dispatch a prompt via askSunny() and it lands here
  // as if the user typed it. Single chat pipeline, no parallel brains.
  useEffect(() => {
    const dispose = onSunnyAsk(({ prompt }) => { void handleSend(prompt); });
    return dispose;
  }, [handleSend]);

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void handleSend(input);
    },
    [handleSend, input],
  );

  const onInputKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend(input);
      }
    },
    [handleSend, input],
  );

  const clear = useCallback(() => {
    session.clear(() => setMessages([]));
  }, [session, setMessages]);

  const resumeSession = useCallback(async (sid: string) => {
    await session.resumeSession(sid, msgs => setMessages(msgs));
  }, [session, setMessages]);

  const newChat = useCallback(() => { clear(); }, [clear]);

  const right = useMemo(
    () => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span>{messages.length} TURNS</span>
        <button
          type="button"
          onClick={clear}
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontFamily: 'var(--display)',
            fontSize: 9,
            letterSpacing: '0.22em',
            color: 'var(--ink-2)',
            padding: '2px 6px',
            border: '1px solid var(--line-soft)',
          }}
          title="Clear conversation"
          aria-label="Clear conversation history"
        >
          CLEAR
        </button>
      </span>
    ),
    [messages.length, clear],
  );

  // Dynamic styles depending on runtime state
  const sendBtnStyle: CSSProperties = {
    all: 'unset',
    cursor: sending ? 'default' : 'pointer',
    fontFamily: 'var(--display)',
    fontSize: 10,
    letterSpacing: '0.22em',
    color: sending ? 'var(--ink-dim)' : 'var(--cyan)',
    padding: '6px 10px',
    border: '1px solid var(--line-soft)',
    background: 'rgba(57, 229, 255, 0.06)',
    textAlign: 'center',
  };

  const rememberHintStyle: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--ink-dim)',
    letterSpacing: '0.04em',
    padding: '2px 4px',
    opacity: session.rememberedCount > 0 ? 1 : 0,
    transition: 'opacity 600ms ease-out',
    pointerEvents: 'none',
  };

  // Narrow the local Message[] to the LiveMessage shape TranscriptView
  // consumes. Memoised to avoid re-merging on unrelated state changes.
  const liveMessagesForTranscript = useMemo(
    () => messages.map(m => ({ role: m.role, text: m.text, ts: m.ts })),
    [messages],
  );

  return (
    <Panel id="p-screen" title="AI CHAT" right={right} bodyStyle={bodyStyle} bodyPad={0}>
      <TranscriptView
        sessionId={session.activeSessionId}
        liveMessages={liveMessagesForTranscript}
      />
      {session.rememberedCount > 0 ? (
        <div
          style={rememberHintStyle}
          role="status"
          aria-live="polite"
        >
          Remembering {session.rememberedCount} earlier{' '}
          {session.rememberedCount === 1 ? 'turn' : 'turns'}
        </div>
      ) : null}
      <div ref={bodyRef} style={listStyle} role="log" aria-live="polite" aria-label="Conversation messages" aria-relevant="additions">
        {messages.length === 0 ? (
          <div style={emptyStyle}>
            No conversation yet. Type below to talk to SUNNY.
          </div>
        ) : (
          messages.map(m => (
            <div
              key={m.id}
              aria-label={ROLE_LABEL[m.role] + (m.streaming ? ': (streaming)' : '')}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                padding: '6px 9px',
                border: '1px solid var(--line-soft)',
                borderLeft: `2px solid ${ROLE_BORDER[m.role]}`,
                background: ROLE_BG[m.role],
              }}
            >
              <div style={{ ...msgRoleStyle, color: ROLE_WHO_COLOR[m.role] }}>
                {ROLE_LABEL[m.role]}
                {m.streaming ? ' · …' : ''}
              </div>
              <div style={msgTextStyle}>
                {m.text || (m.streaming ? '…' : '')}
              </div>
            </div>
          ))
        )}
      </div>

      <div style={sessionRowStyle}>
        <SessionPicker
          currentSessionId={session.sessionIdRef.current}
          onResume={sid => { void resumeSession(sid); }}
          onNewChat={newChat}
        />
      </div>

      <form style={formStyle} onSubmit={onSubmit}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="Message SUNNY…"
          style={inputStyle}
          disabled={sending}
          aria-label="Message SUNNY"
        />
        <button type="submit" style={sendBtnStyle} disabled={sending}>
          SEND
        </button>
      </form>
    </Panel>
  );
}
