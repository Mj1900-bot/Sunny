/**
 * BRAINSTORM — conversational sounding board mode.
 *
 * Distinct conversational contract:
 *   • 3-sentence turns (server-side post-process)
 *   • One question per turn
 *   • Willing to disagree
 *   • Orb shifts to amber-white when active
 *
 * Entry:
 *   • Voice phrase "let's brainstorm"
 *   • Chat command /brainstorm
 *   • Idle >3 min on blank note (idle prompt)
 *
 * Exit:
 *   • "let's do it" / "take action" → switch to task mode
 *
 * Council panel is available as an optional deliberation layer via
 * the CouncilPanel component + useCouncil hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { CouncilPanel } from '../../components/CouncilPanel';
import {
  PageGrid, PageCell, Section, ToolbarButton,
} from '../_shared';
import { useBrainstormMode } from '../../hooks/useBrainstormMode';
import { useCouncil } from '../../hooks/useCouncil';
import { useSunny } from '../../hooks/useSunny';
import { useView } from '../../store/view';

type ChatEntry = {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: number;
};

const DEFAULT_COUNCIL_MEMBERS = [
  { name: 'GLM', model: 'glm-5.1' },
  { name: 'QWEN30B', model: 'qwen3:30b' },
  { name: 'QWEN9B', model: 'qwen3.5:9b' },
] as const;

const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3 min

export function BrainstormPage() {
  const { mode, enterBrainstorm, exitBrainstorm, detectPhrase,
    idlePromptVisible, showIdlePrompt, dismissIdlePrompt, isIdleSuppressed } = useBrainstormMode();
  const council = useCouncil();
  const { chat } = useSunny();
  const provider = useView(s => s.settings.provider);
  const model = useView(s => s.settings.model);

  const [history, setHistory] = useState<readonly ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [councilOpen, setCouncilOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Enter brainstorm mode when this page opens.
  useEffect(() => {
    enterBrainstorm();
    return () => exitBrainstorm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle detection — show prompt if blank note for >3 min.
  useEffect(() => {
    idleTimerRef.current = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      if (
        idle > IDLE_THRESHOLD_MS &&
        history.length === 0 &&
        !idlePromptVisible &&
        !isIdleSuppressed()
      ) {
        showIdlePrompt();
      }
    }, 30_000);
    return () => {
      if (idleTimerRef.current !== null) clearInterval(idleTimerRef.current);
    };
  }, [history.length, idlePromptVisible, showIdlePrompt, isIdleSuppressed]);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    lastActivityRef.current = Date.now();
    setInput('');
    setSending(true);

    // Check for mode-switch phrases first.
    const phraseResult = detectPhrase(text);
    if (phraseResult === 'exited') {
      setHistory(prev => [
        ...prev,
        { role: 'user', text, at: Date.now() },
        { role: 'assistant', text: 'Switching to task mode. Ready to help.', at: Date.now() },
      ]);
      setSending(false);
      return;
    }
    if (phraseResult === 'entered') {
      setHistory(prev => [
        ...prev,
        { role: 'user', text, at: Date.now() },
        { role: 'assistant', text: "Let's brainstorm. What's on your mind?", at: Date.now() },
      ]);
      setSending(false);
      return;
    }

    setHistory(prev => [...prev, { role: 'user', text, at: Date.now() }]);

    try {
      const reply = await chat(text, {
        provider: provider ?? null,
        model: model ?? null,
        // chat_mode is passed through ChatRequest's optional field
        // to select the brainstorm system prompt variant.
        ...(({ chat_mode: 'brainstorm' } as Record<string, unknown>)),
      });

      const trimmed = typeof reply === 'string' ? reply.trim() : '';
      setHistory(prev => [
        ...prev,
        { role: 'assistant', text: trimmed, at: Date.now() },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHistory(prev => [
        ...prev,
        { role: 'assistant', text: `Error: ${msg}`, at: Date.now() },
      ]);
    } finally {
      setSending(false);
    }
  }, [input, sending, chat, provider, model, detectPhrase]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleCouncil = useCallback(() => {
    const lastUserMsg = [...history].reverse().find(h => h.role === 'user');
    if (!lastUserMsg) return;
    setCouncilOpen(true);
    council.start(lastUserMsg.text, [...DEFAULT_COUNCIL_MEMBERS]);
  }, [history, council]);

  const isActive = mode === 'brainstorm';

  // Amber-white orb tint when brainstorm mode is active.
  const orbTintStyle = isActive
    ? ({
        '--orb-tint': 'rgba(255, 200, 100, 0.18)',
      } as React.CSSProperties)
    : {};

  return (
    <ModuleView title="BRAINSTORM · SOUNDING BOARD">
      <div style={orbTintStyle}>
        <PageGrid>
          {/* Mode indicator */}
          <PageCell span={12}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 10px',
              border: `1px solid ${isActive ? 'rgba(255, 200, 100, 0.55)' : 'var(--line-soft)'}`,
              background: isActive
                ? 'rgba(255, 200, 100, 0.06)'
                : 'rgba(6, 14, 22, 0.55)',
              transition: 'all 200ms ease',
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: isActive ? 'rgba(255, 200, 100, 0.9)' : 'var(--ink-dim)',
                flexShrink: 0,
                transition: 'background 200ms ease',
              }} aria-hidden />
              <span style={{
                fontFamily: 'var(--display)', fontSize: 9,
                letterSpacing: '0.22em',
                color: isActive ? 'rgba(255, 220, 140, 0.9)' : 'var(--ink-dim)',
              }}>
                {isActive ? 'BRAINSTORM MODE ACTIVE — 3-SENTENCE TURNS' : 'TASK MODE'}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {!isActive && (
                  <ToolbarButton tone="amber" onClick={enterBrainstorm}>
                    ENTER BRAINSTORM
                  </ToolbarButton>
                )}
                {isActive && (
                  <ToolbarButton tone="cyan" onClick={exitBrainstorm}>
                    BACK TO TASK
                  </ToolbarButton>
                )}
              </div>
            </div>
          </PageCell>

          {/* Idle prompt */}
          {idlePromptVisible && (
            <PageCell span={12}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12,
                padding: '10px 14px',
                border: '1px dashed rgba(255, 200, 100, 0.5)',
                background: 'rgba(255, 200, 100, 0.04)',
                fontFamily: 'var(--label)', fontSize: 12,
                color: 'var(--ink-2)',
              }}>
                <span>Want a sounding board? I can help you think through something.</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <ToolbarButton tone="amber" onClick={enterBrainstorm}>
                    YES, LET'S GO
                  </ToolbarButton>
                  <ToolbarButton onClick={dismissIdlePrompt}>
                    NOT NOW
                  </ToolbarButton>
                </div>
              </div>
            </PageCell>
          )}

          {/* Chat area */}
          <PageCell span={councilOpen ? 8 : 12}>
            <Section title="CONVERSATION">
              <div
                ref={bodyRef}
                style={{
                  minHeight: 280,
                  maxHeight: 460,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: '4px 2px',
                }}
                aria-label="Brainstorm conversation"
                aria-live="polite"
              >
                {history.length === 0 && (
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11,
                    color: 'var(--ink-dim)', textAlign: 'center',
                    padding: '32px 16px',
                    opacity: 0.6,
                  }}>
                    Start the conversation. I keep replies to three sentences and ask one question per turn.
                  </div>
                )}
                {history.map((entry, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      alignSelf: entry.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '82%',
                    }}
                  >
                    <span style={{
                      fontFamily: 'var(--display)', fontSize: 8,
                      letterSpacing: '0.22em', fontWeight: 700,
                      color: entry.role === 'user' ? 'rgba(255, 200, 100, 0.8)' : 'var(--cyan)',
                      paddingLeft: entry.role === 'assistant' ? 4 : 0,
                    }}>
                      {entry.role === 'user' ? 'YOU' : 'SUNNY'}
                    </span>
                    <div style={{
                      padding: '8px 11px',
                      border: '1px solid var(--line-soft)',
                      borderLeft: entry.role === 'assistant'
                        ? '2px solid var(--cyan)'
                        : '2px solid rgba(255, 200, 100, 0.6)',
                      background: entry.role === 'user'
                        ? 'rgba(255, 200, 100, 0.05)'
                        : 'rgba(57, 229, 255, 0.04)',
                      fontFamily: 'var(--label)', fontSize: 12,
                      color: 'var(--ink)',
                      lineHeight: 1.62,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {entry.text}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div style={{
                    alignSelf: 'flex-start',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    color: 'var(--ink-dim)', padding: '6px 10px',
                    opacity: 0.7,
                  }}>
                    thinking…
                  </div>
                )}
              </div>

              {/* Input */}
              <div style={{
                display: 'flex', gap: 8, alignItems: 'flex-end',
                marginTop: 8,
              }}>
                <textarea
                  value={input}
                  onChange={e => {
                    setInput(e.target.value);
                    lastActivityRef.current = Date.now();
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={isActive
                    ? 'Share an idea or ask — ENTER to send, SHIFT+ENTER for new line'
                    : 'Type /brainstorm or "let\'s brainstorm" to enter sounding board mode'}
                  disabled={sending}
                  rows={3}
                  style={{
                    all: 'unset',
                    boxSizing: 'border-box',
                    flex: 1,
                    padding: '9px 12px',
                    fontFamily: 'var(--label)', fontSize: 12,
                    color: 'var(--ink)',
                    border: '1px solid var(--line-soft)',
                    background: 'rgba(0, 0, 0, 0.35)',
                    lineHeight: 1.55,
                    resize: 'none',
                    opacity: sending ? 0.6 : 1,
                  }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <ToolbarButton
                    tone="amber"
                    onClick={() => void handleSend()}
                    disabled={!input.trim() || sending}
                  >
                    SEND
                  </ToolbarButton>
                  <ToolbarButton
                    tone="cyan"
                    onClick={handleCouncil}
                    disabled={history.filter(h => h.role === 'user').length === 0 || council.status === 'running'}
                  >
                    COUNCIL
                  </ToolbarButton>
                </div>
              </div>
            </Section>
          </PageCell>

          {/* Council panel inline */}
          {councilOpen && (
            <PageCell span={4}>
              <CouncilPanel
                status={council.status}
                members={council.members}
                synthesis={council.synthesis}
                error={council.error}
                onDismiss={() => {
                  council.dismiss();
                  setCouncilOpen(false);
                }}
              />
            </PageCell>
          )}
        </PageGrid>
      </div>
    </ModuleView>
  );
}
