/**
 * AgentOverlay — always-visible top-right strip showing the agent's current
 * activity ("TYPING IN CHROME", "READING MAIL INBOX", etc.).
 *
 * Subscribes to `useAgentStore` and renders a one-line, pointer-events-none
 * strip that flashes on each new step, then transitions to a green
 * final-answer flash on success, or a red error flash on abort/failure,
 * before fading out. Never interacts with pointer events — purely
 * informational; the HUD behind it remains fully clickable.
 *
 * Sits at z-index 40 — above normal HUD chrome, below ConfirmGate (10000).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import {
  useAgentStore,
  type PlanStep,
  type AgentRunStatus,
} from '../store/agent';

// ---- constants ----

const MAX_WIDTH = 420;
const HEIGHT = 28;
const TEXT_MAX_CHARS = 80;
const INPUT_SUMMARY_MAX = 48;
const FLASH_MS = 300;
const DONE_HOLD_MS = 3000;
const ERROR_HOLD_MS = 4000;
const FADE_MS = 400;

// ---- types ----

type Phase =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly at: number }
  | { readonly kind: 'error'; readonly at: number; readonly text: string }
  | { readonly kind: 'fading'; readonly tone: 'green' | 'red'; readonly text: string };

// ---- pure helpers ----

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}\u2026`;
}

function isRelevant(step: PlanStep): boolean {
  return step.kind === 'tool_call' || step.kind === 'message' || step.kind === 'error';
}

function latestRelevant(steps: ReadonlyArray<PlanStep>): PlanStep | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i];
    if (s && isRelevant(s)) return s;
  }
  // Fallback: latest anything, if no relevant kind yet.
  return steps.length > 0 ? steps[steps.length - 1] ?? null : null;
}

function formatStep(step: PlanStep): string {
  if (step.kind === 'tool_call') {
    const tool = step.toolName?.trim() || 'tool';
    const summary = truncate(step.text.trim(), INPUT_SUMMARY_MAX);
    return summary.length > 0
      ? `\u26a1 ${tool} \u2014 ${summary}`
      : `\u26a1 ${tool}`;
  }
  return step.text;
}

function resolveDotColor(
  phase: Phase,
  status: AgentRunStatus,
): string {
  if (phase.kind === 'error') return 'var(--red)';
  if (phase.kind === 'done') return 'var(--green)';
  if (phase.kind === 'fading') {
    return phase.tone === 'green' ? 'var(--green)' : 'var(--red)';
  }
  if (status === 'running') return 'var(--cyan)';
  return 'var(--cyan)';
}

function resolveAccent(
  phase: Phase,
): { color: string; border: string; glow: string } {
  if (phase.kind === 'error') {
    return {
      color: 'var(--red)',
      border: 'var(--red)',
      glow: 'rgba(239,68,68,0.45)',
    };
  }
  if (phase.kind === 'done') {
    return {
      color: 'var(--green)',
      border: 'var(--green)',
      glow: 'rgba(34,197,94,0.40)',
    };
  }
  if (phase.kind === 'fading') {
    const isGreen = phase.tone === 'green';
    return {
      color: isGreen ? 'var(--green)' : 'var(--red)',
      border: 'var(--line-soft)',
      glow: isGreen ? 'rgba(34,197,94,0.30)' : 'rgba(239,68,68,0.30)',
    };
  }
  return {
    color: 'var(--cyan)',
    border: 'var(--line-soft)',
    glow: 'rgba(57,229,255,0.45)',
  };
}

// ---- component ----

export function AgentOverlay(): JSX.Element | null {
  const status = useAgentStore(s => s.status);
  const steps = useAgentStore(s => s.steps);
  const finalAnswer = useAgentStore(s => s.finalAnswer);

  const latest = useMemo(() => latestRelevant(steps), [steps]);
  const totalCount = steps.length;
  const relevantIndex = useMemo(() => {
    if (!latest) return 0;
    // 1-based position of latest relevant step among all steps.
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i]?.id === latest.id) return i + 1;
    }
    return totalCount;
  }, [latest, steps, totalCount]);

  const [phase, setPhase] = useState<Phase>({ kind: 'hidden' });
  const [flashAt, setFlashAt] = useState<number>(0);

  // Timer refs so we can clear on transitions / unmount. Storing in refs
  // (not state) avoids re-renders and lets us atomically swap out a
  // previous timer when a new phase kicks in.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStepIdRef = useRef<string | null>(null);

  const clearHold = (): void => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };
  const clearFade = (): void => {
    if (fadeTimerRef.current !== null) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  };
  const clearFlash = (): void => {
    if (flashTimerRef.current !== null) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  };

  // React to status transitions. Each run that starts kills any pending
  // done/error hold or fade — so a quick-done-then-quick-run sequence
  // instantly shows the new running strip without stranded timers.
  useEffect(() => {
    if (status === 'running') {
      clearHold();
      clearFade();
      setPhase({ kind: 'running' });
      return;
    }
    if (status === 'done') {
      clearHold();
      clearFade();
      setPhase({ kind: 'done', at: Date.now() });
      holdTimerRef.current = setTimeout(() => {
        setPhase({
          kind: 'fading',
          tone: 'green',
          text: truncate(finalAnswer || 'done', TEXT_MAX_CHARS),
        });
        fadeTimerRef.current = setTimeout(() => {
          setPhase({ kind: 'hidden' });
        }, FADE_MS);
      }, DONE_HOLD_MS);
      return;
    }
    if (status === 'aborted' || status === 'error') {
      clearHold();
      clearFade();
      const errText =
        steps.slice().reverse().find(s => s.kind === 'error')?.text
        || (status === 'aborted' ? 'aborted' : 'error');
      setPhase({
        kind: 'error',
        at: Date.now(),
        text: truncate(errText, TEXT_MAX_CHARS),
      });
      holdTimerRef.current = setTimeout(() => {
        setPhase({
          kind: 'fading',
          tone: 'red',
          text: truncate(errText, TEXT_MAX_CHARS),
        });
        fadeTimerRef.current = setTimeout(() => {
          setPhase({ kind: 'hidden' });
        }, FADE_MS);
      }, ERROR_HOLD_MS);
      return;
    }
    // idle: if we're not mid-transition, clear to hidden.
    if (phase.kind === 'running') {
      setPhase({ kind: 'hidden' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, finalAnswer]);

  // Flash pulse whenever a new step arrives during a running phase.
  useEffect(() => {
    const currentId = latest?.id ?? null;
    if (currentId !== null && currentId !== lastStepIdRef.current) {
      lastStepIdRef.current = currentId;
      if (status === 'running') {
        setFlashAt(Date.now());
        clearFlash();
        flashTimerRef.current = setTimeout(() => {
          setFlashAt(0);
        }, FLASH_MS);
      }
    }
  }, [latest, status]);

  // Cleanup all timers on unmount. Crucial — a parent can swap the HUD
  // mid-run and we must not leave dangling setTimeouts pinning closures.
  useEffect(() => {
    return () => {
      clearHold();
      clearFade();
      clearFlash();
    };
  }, []);

  // ---- render gate ----

  const showForStatus = status === 'running';
  const showForPhase =
    phase.kind === 'running'
    || phase.kind === 'done'
    || phase.kind === 'error'
    || phase.kind === 'fading';
  const recentFlash = flashAt !== 0 && Date.now() - flashAt < FLASH_MS + 50;

  if (!showForStatus && !showForPhase && !recentFlash) {
    return null;
  }

  // ---- content selection ----

  let text: string;
  if (phase.kind === 'done') {
    text = truncate(finalAnswer || 'done', TEXT_MAX_CHARS);
  } else if (phase.kind === 'error') {
    text = phase.text;
  } else if (phase.kind === 'fading') {
    text = phase.text;
  } else {
    text = latest ? truncate(formatStep(latest), TEXT_MAX_CHARS) : 'thinking\u2026';
  }

  const accent = resolveAccent(phase);
  const dotColor = resolveDotColor(phase, status);
  const isFading = phase.kind === 'fading';
  const isFlashing = flashAt !== 0;

  // ---- styles ----

  const containerStyle: CSSProperties = {
    position: 'absolute',
    top: 12,
    right: 18,
    zIndex: 40,
    maxWidth: MAX_WIDTH,
    height: HEIGHT,
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 10px',
    boxSizing: 'border-box',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--mono)',
    fontSize: 11,
    lineHeight: '28px',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: accent.color,
    background: 'rgba(2,8,12,0.62)',
    border: `1px solid ${accent.border}`,
    borderRadius: 4,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    boxShadow: isFlashing
      ? `0 0 0 1px ${accent.glow}, 0 0 14px ${accent.glow}`
      : `0 0 0 1px rgba(57,229,255,0.04)`,
    opacity: isFading ? 0 : 1,
    transition: `opacity ${FADE_MS}ms ease, box-shadow 300ms ease, border-color 300ms ease, color 300ms ease`,
  };

  const dotStyle: CSSProperties = {
    flexShrink: 0,
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: dotColor,
    boxShadow: `0 0 6px ${dotColor}, 0 0 12px ${dotColor}`,
    animation:
      phase.kind === 'running'
        ? 'sunny-overlay-pulse 1.1s ease-in-out infinite'
        : 'none',
  };

  const textStyle: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const badgeStyle: CSSProperties = {
    flexShrink: 0,
    fontSize: 9,
    letterSpacing: '0.14em',
    padding: '1px 6px',
    border: '1px solid var(--line-soft)',
    borderRadius: 3,
    color: 'rgba(230,248,255,0.6)',
    opacity: phase.kind === 'running' ? 0.55 : 0,
    transition: 'opacity 200ms ease',
  };

  const counter = totalCount > 0 ? `${relevantIndex}/${totalCount}` : '0/0';

  return (
    <div style={containerStyle} aria-hidden="true">
      <style>{keyframes}</style>
      <span style={dotStyle} />
      <span style={textStyle}>{text}</span>
      <span style={badgeStyle}>{counter}</span>
    </div>
  );
}

// Single keyframes string — inlined so the component has zero external
// CSS dependencies beyond the theme tokens already provided by the HUD.
const keyframes = `
@keyframes sunny-overlay-pulse {
  0%   { transform: scale(1);   opacity: 1;   }
  50%  { transform: scale(1.4); opacity: 0.55;}
  100% { transform: scale(1);   opacity: 1;   }
}
`;
