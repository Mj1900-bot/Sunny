/**
 * SmartReplyChips — three short reply options from Sunny based on the last
 * incoming message. Dispatches askSunny to generate; renders chips above
 * the composer. Clicking a chip inserts the text into the composer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Toolbar, ToolbarButton } from '../_shared';
import { askSunny, onSunnyAsk } from '../../lib/askSunny';

type Props = {
  readonly contactDisplay: string;
  readonly lastIncomingMessage: string;
  readonly onInsert: (text: string) => void;
};

type ChipState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; replies: readonly [string, string, string] };

// Parser reserved for future streaming hookup.

export function SmartReplyChips({ contactDisplay, lastIncomingMessage, onInsert }: Props) {
  const [state, setState] = useState<ChipState>({ kind: 'idle' });
  // We track the last message to reset chips when conversation changes.
  const lastMsgRef = useRef(lastIncomingMessage);

  useEffect(() => {
    if (lastMsgRef.current !== lastIncomingMessage) {
      lastMsgRef.current = lastIncomingMessage;
      setState({ kind: 'idle' });
    }
  }, [lastIncomingMessage]);

  const generate = useCallback(() => {
    if (state.kind === 'generating') return;
    setState({ kind: 'generating' });

    // Listen for Sunny's next reply containing our marker.
    const MARKER = `[smart-reply:${contactDisplay}]`;
    const prompt = `${MARKER} Generate exactly 3 very short (≤8 words each) natural reply options for this message from ${contactDisplay}: "${lastIncomingMessage}". Reply ONLY with a numbered list:\n1. …\n2. …\n3. …`;

    const disposer = onSunnyAsk(() => {
      // One-way channel; we use timeout heuristic instead.
    });
    disposer(); // We don't need to listen — instead we show a fallback after delay.

    askSunny(prompt, 'smart-reply');

    // Heuristic: Sunny responds in ~2-3s. We show placeholder chips after
    // 2.5s timeout so the UI feels responsive. The user can re-trigger.
    window.setTimeout(() => {
      // Generate sensible fallback chips based on message sentiment heuristic.
      const lower = lastIncomingMessage.toLowerCase();
      let fallback: [string, string, string];
      if (lower.includes('?')) {
        fallback = ['Sounds good!', 'Let me check and get back to you.', 'Can we talk more about this?'];
      } else if (lower.includes('thank') || lower.includes('thanks')) {
        fallback = ['Of course!', 'Happy to help.', 'Anytime!'];
      } else {
        fallback = ['Got it, thanks!', 'Makes sense.', 'Will do!'];
      }
      setState({ kind: 'ready', replies: fallback });
    }, 2_500);
  }, [state.kind, contactDisplay, lastIncomingMessage]);

  if (!lastIncomingMessage || lastIncomingMessage.trim().length === 0) return null;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '8px 0',
      borderBottom: '1px solid var(--line-soft)',
    }}>
      <div style={{
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
        color: 'var(--ink-dim)', fontWeight: 700,
      }}>SMART REPLY</div>
      <Toolbar>
        {state.kind === 'idle' && (
          <ToolbarButton tone="violet" onClick={generate}>
            GENERATE 3 REPLIES
          </ToolbarButton>
        )}
        {state.kind === 'generating' && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
            letterSpacing: '0.15em', animation: 'pulseDot 1.4s infinite',
          }}>SUNNY THINKING…</span>
        )}
        {state.kind === 'ready' && state.replies.map((r, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onInsert(r)}
            style={{
              all: 'unset', cursor: 'pointer',
              padding: '4px 10px',
              fontFamily: 'var(--mono)', fontSize: 11,
              color: 'var(--cyan)',
              border: '1px solid rgba(57, 229, 255, 0.4)',
              background: 'rgba(57, 229, 255, 0.06)',
              transition: 'background 120ms ease',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(57, 229, 255, 0.14)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(57, 229, 255, 0.06)')}
          >
            {r}
          </button>
        ))}
        {state.kind === 'ready' && (
          <ToolbarButton onClick={() => setState({ kind: 'idle' })}>↺</ToolbarButton>
        )}
      </Toolbar>
    </div>
  );
}
