/**
 * ConfirmGate — modal confirmation dialog for dangerous agent actions.
 *
 * Mount once at the root (below the dashboard). When any call site invokes
 * `useSafety.getState().request(...)` a confirmation is queued and the gate
 * shows the oldest pending prompt. Multiple queued prompts surface one at a
 * time, FIFO, with a 150ms gap between resolutions so the user clearly sees
 * that a new prompt has arrived.
 *
 * Usage example (do NOT wire this to any tool yet — agent 3 owns tools.ts):
 *
 *   const approved = await useSafety.getState().request({
 *     title: 'Run shell command',
 *     description: 'SUNNY wants to execute a shell command on your Mac.',
 *     verb: 'RUN',
 *     preview: 'rm -rf ~/Downloads/tmp/*',
 *     risk: 'high',
 *   });
 *   if (approved) await invokeSafe('run_shell', { cmd });
 *
 * Behaviour notes:
 * - `Esc` rejects, `Enter` accepts (but only once any HIGH-risk countdown
 *   has elapsed).
 * - HIGH-risk prompts disable APPROVE for 3 seconds and tick down 3…2…1 to
 *   prevent reflexive approve-spam.
 * - Backdrop clicks are ignored — confirmation MUST be explicit.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { useSafety, type Confirmation } from '../store/safety';
import { useView } from '../store/view';

type Risk = Confirmation['risk'];

const RISK_COLOR: Record<Risk, string> = {
  low: '#22d3ee',     // cyan-400
  medium: '#f59e0b',  // amber-500
  high: '#ef4444',    // red-500
};

const RISK_GLOW: Record<Risk, string> = {
  low: 'rgba(34, 211, 238, 0.35)',
  medium: 'rgba(245, 158, 11, 0.4)',
  high: 'rgba(239, 68, 68, 0.5)',
};

const HIGH_RISK_COUNTDOWN_S = 3;
const TRANSITION_MS = 150;

export function ConfirmGate(): JSX.Element | null {
  const head = useSafety(s => s.queue[0]);
  const accept = useSafety(s => s.accept);
  const reject = useSafety(s => s.reject);

  // `visible` lags `head` by TRANSITION_MS so successive prompts do a brief
  // fade-out / fade-in instead of swapping instantly. This makes it obvious
  // that the second dialog is a *new* decision, not a mis-click.
  const [visible, setVisible] = useState<Confirmation | null>(head ?? null);
  const [phase, setPhase] = useState<'in' | 'out'>(head ? 'in' : 'out');

  useEffect(() => {
    if (head && !visible) {
      setVisible(head);
      setPhase('in');
      return;
    }
    if (head && visible && head.id !== visible.id) {
      setPhase('out');
      const t = window.setTimeout(() => {
        setVisible(head);
        setPhase('in');
      }, TRANSITION_MS);
      return () => window.clearTimeout(t);
    }
    if (!head && visible) {
      setPhase('out');
      const t = window.setTimeout(() => setVisible(null), TRANSITION_MS);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [head, visible]);

  if (!visible) return null;

  return (
    <ConfirmCard
      key={visible.id}
      item={visible}
      phase={phase}
      onAccept={() => accept(visible.id)}
      onReject={() => reject(visible.id)}
    />
  );
}

type CardProps = {
  readonly item: Confirmation;
  readonly phase: 'in' | 'out';
  readonly onAccept: () => void;
  readonly onReject: () => void;
};

function ConfirmCard({ item, phase, onAccept, onReject }: CardProps): JSX.Element {
  const { risk, verb, title, description, preview } = item;
  const color = RISK_COLOR[risk];
  const glow = RISK_GLOW[risk];
  const reducedMotion = useView(s => s.settings.reducedMotion);

  const needsCountdown = risk === 'high';
  const [countdown, setCountdown] = useState<number>(needsCountdown ? HIGH_RISK_COUNTDOWN_S : 0);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  // Countdown ticker — only active for HIGH risk prompts.
  useEffect(() => {
    if (!needsCountdown) return;
    if (countdown <= 0) return;
    const t = window.setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [needsCountdown, countdown]);

  const approveReady = !needsCountdown || countdown <= 0;

  // Focus CANCEL by default — safer landing spot than APPROVE if the user
  // hits Space / Enter reflexively.
  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, [item.id]);

  // Keyboard: Esc rejects, Enter accepts (only after countdown).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onReject();
        return;
      }
      if (e.key === 'Enter') {
        if (!approveReady) return;
        e.preventDefault();
        onAccept();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [approveReady, onAccept, onReject]);

  const approveLabel = useMemo(() => {
    if (approveReady) return 'APPROVE';
    return `APPROVE (${countdown})`;
  }, [approveReady, countdown]);

  const backdrop: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 10000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(4, 10, 14, 0.7)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    opacity: phase === 'in' ? 1 : 0,
    transition: `opacity ${TRANSITION_MS}ms ease-out`,
  };

  const card: CSSProperties = {
    position: 'relative',
    minWidth: 480,
    maxWidth: 640,
    padding: '0',
    background: 'rgba(8, 16, 22, 0.96)',
    border: '1px solid rgba(140, 190, 210, 0.18)',
    boxShadow: `0 0 0 1px rgba(0,0,0,0.4), 0 24px 72px rgba(0,0,0,0.65), 0 0 48px ${glow}`,
    color: 'var(--cyan, #c7f4ff)',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    transform: phase === 'in' ? 'translateY(0) scale(1)' : 'translateY(6px) scale(0.98)',
    opacity: phase === 'in' ? 1 : 0,
    transition: `opacity ${TRANSITION_MS}ms ease-out, transform ${TRANSITION_MS}ms ease-out`,
  };

  const leftBar: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    background: color,
    boxShadow: `0 0 12px ${glow}`,
  };

  // Subtle outer pulse ring — layered behind the card so it breathes
  // independently of the fade-in transition that drives `card.opacity`.
  // Disabled under `reducedMotion`.
  const pulseRing: CSSProperties = {
    position: 'absolute',
    inset: -2,
    pointerEvents: 'none',
    border: `1px solid ${color}`,
    opacity: 0.35,
    animation: reducedMotion ? 'none' : 'sunny-confirm-pulse 2.4s ease-in-out infinite',
  };

  const header: CSSProperties = {
    padding: '16px 22px 12px 26px',
    borderBottom: '1px solid rgba(140, 190, 210, 0.14)',
    fontSize: 11,
    letterSpacing: '0.28em',
    textTransform: 'uppercase',
    color,
  };

  const body: CSSProperties = {
    padding: '18px 22px 6px 26px',
  };

  const titleStyle: CSSProperties = {
    fontFamily: '"Orbitron", ui-sans-serif, system-ui, sans-serif',
    fontSize: 16,
    letterSpacing: '0.28em',
    textTransform: 'uppercase',
    color: 'var(--cyan, #c7f4ff)',
    marginBottom: 10,
  };

  const descStyle: CSSProperties = {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'rgba(220, 240, 250, 0.82)',
    marginBottom: 14,
  };

  const previewStyle: CSSProperties = {
    maxHeight: 180,
    overflow: 'auto',
    padding: '10px 12px',
    margin: 0,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'rgba(210, 235, 245, 0.92)',
    background: 'rgba(0, 0, 0, 0.35)',
    border: '1px solid rgba(140, 190, 210, 0.12)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  const footer: CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '14px 22px 18px 26px',
    borderTop: '1px solid rgba(140, 190, 210, 0.14)',
    marginTop: 16,
  };

  const secondaryBtn: CSSProperties = {
    padding: '8px 18px',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 11,
    letterSpacing: '0.22em',
    textTransform: 'uppercase',
    color: 'rgba(220, 240, 250, 0.82)',
    background: 'transparent',
    border: '1px solid rgba(140, 190, 210, 0.28)',
    cursor: 'pointer',
  };

  const primaryBtn: CSSProperties = {
    padding: '8px 18px',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 11,
    letterSpacing: '0.22em',
    textTransform: 'uppercase',
    color: '#05131a',
    background: approveReady ? color : 'rgba(140, 190, 210, 0.18)',
    border: `1px solid ${approveReady ? color : 'rgba(140, 190, 210, 0.28)'}`,
    boxShadow: approveReady ? `0 0 18px ${glow}` : 'none',
    cursor: approveReady ? 'pointer' : 'not-allowed',
    opacity: approveReady ? 1 : 0.75,
    fontWeight: 600,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`confirm-title-${item.id}`}
      aria-describedby={`confirm-desc-${item.id}`}
      style={backdrop}
    >
      <style>{`
        @keyframes sunny-confirm-pulse {
          0%, 100% { opacity: 0.22; transform: scale(1); }
          50%      { opacity: 0.55; transform: scale(1.012); }
        }
      `}</style>
      <div style={card}>
        <div style={pulseRing} aria-hidden="true" />
        <div style={leftBar} aria-hidden="true" />
        <div style={header}>
          CONFIRM &middot; {verb}
        </div>
        <div style={body}>
          <div id={`confirm-title-${item.id}`} style={titleStyle}>
            {title}
          </div>
          <div id={`confirm-desc-${item.id}`} style={descStyle}>
            {description}
          </div>
          <pre style={previewStyle} aria-label="Action preview">
            {preview}
          </pre>
        </div>
        <div style={footer}>
          <button
            ref={cancelBtnRef}
            type="button"
            style={secondaryBtn}
            onClick={onReject}
          >
            CANCEL
          </button>
          <button
            type="button"
            style={primaryBtn}
            disabled={!approveReady}
            aria-disabled={!approveReady}
            onClick={() => {
              if (!approveReady) return;
              onAccept();
            }}
          >
            {approveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
