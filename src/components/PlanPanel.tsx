import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  useAgentStore,
  type AgentRunStatus,
  type PlanStep,
  type PlanStepKind,
} from '../store/agent';

const ERROR_COLOR = 'rgb(255, 82, 82)';

const STATUS_COLORS: Record<AgentRunStatus, string> = {
  idle: 'var(--cyan)',
  running: 'var(--amber)',
  done: 'var(--green)',
  aborted: ERROR_COLOR,
  error: ERROR_COLOR,
};

const STATUS_LABELS: Record<AgentRunStatus, string> = {
  idle: 'IDLE',
  running: 'RUNNING',
  done: 'DONE',
  aborted: 'ABORTED',
  error: 'ERROR',
};

const KIND_ICON: Record<PlanStepKind, string> = {
  plan: '▸',
  tool_call: '⚡',
  tool_result: '◎',
  message: '✎',
  error: '✕',
};

const KIND_COLOR: Record<PlanStepKind, string> = {
  plan: 'var(--cyan)',
  tool_call: 'var(--amber)',
  tool_result: 'var(--green)',
  message: 'var(--ink-2)',
  error: ERROR_COLOR,
};

const PANEL_STYLE: CSSProperties = {
  position: 'fixed',
  right: 18,
  bottom: 18,
  width: 420,
  maxHeight: 520,
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--line-soft)',
  background: 'rgba(4, 10, 16, 0.92)',
  boxShadow: '0 0 18px rgba(57, 229, 255, 0.12), 0 10px 30px rgba(0,0,0,0.55)',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  color: 'var(--ink-2)',
  zIndex: 50,
  overflow: 'hidden',
};

const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderBottom: '1px solid var(--line-soft)',
  fontSize: 10,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  userSelect: 'none',
};

const HEADER_TITLE_STYLE: CSSProperties = {
  color: 'var(--cyan)',
  fontWeight: 700,
};

const HEADER_META_STYLE: CSSProperties = {
  color: 'var(--ink-dim)',
  fontSize: 10,
  letterSpacing: '0.18em',
};

const HEADER_SPACER_STYLE: CSSProperties = { flex: 1 };

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '6px 10px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const COLLAPSED_NOTE_STYLE: CSSProperties = {
  padding: '8px 10px',
  color: 'var(--ink-dim)',
  fontSize: 10,
  letterSpacing: '0.22em',
};

const STEP_ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '14px 1fr auto',
  gridTemplateRows: 'auto auto',
  columnGap: 8,
  rowGap: 2,
  alignItems: 'start',
  padding: '4px 0',
  borderBottom: '1px solid rgba(57, 229, 255, 0.06)',
};

const STEP_TEXT_STYLE: CSSProperties = {
  gridColumn: '2 / 3',
  gridRow: '1 / 2',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  lineHeight: 1.4,
  color: 'var(--ink)',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  wordBreak: 'break-word',
};

const STEP_META_STYLE: CSSProperties = {
  gridColumn: '2 / 4',
  gridRow: '2 / 3',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 9,
  color: 'var(--ink-dim)',
  letterSpacing: '0.12em',
};

const TOOL_BADGE_STYLE: CSSProperties = {
  display: 'inline-block',
  padding: '1px 5px',
  border: '1px solid var(--line-soft)',
  color: 'var(--cyan-2, var(--cyan))',
  fontSize: 9,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  borderRadius: 2,
};

const TIME_STYLE: CSSProperties = {
  gridColumn: '3 / 4',
  gridRow: '1 / 2',
  fontSize: 9,
  color: 'var(--ink-dim)',
  letterSpacing: '0.08em',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

function badgeStyle(status: AgentRunStatus): CSSProperties {
  const color = STATUS_COLORS[status];
  return {
    padding: '2px 6px',
    border: `1px solid ${color}`,
    color,
    fontSize: 9,
    letterSpacing: '0.22em',
    fontWeight: 700,
    borderRadius: 2,
    animation: status === 'running' ? 'sunnyPulse 1.4s ease-in-out infinite' : undefined,
  };
}

function buttonStyle(
  color: string,
  disabled: boolean,
): CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${disabled ? 'var(--line-soft)' : color}`,
    color: disabled ? 'var(--ink-dim)' : color,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 9,
    letterSpacing: '0.22em',
    fontWeight: 700,
    padding: '2px 8px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    borderRadius: 2,
    opacity: disabled ? 0.55 : 1,
  };
}

const CARET_BUTTON_STYLE: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--ink-dim)',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  cursor: 'pointer',
  padding: '0 4px',
  lineHeight: 1,
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const ss = (totalSeconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatRelative(stepAt: number, startedAt: number | null): string {
  const base = startedAt ?? stepAt;
  const deltaMs = Math.max(0, stepAt - base);
  if (deltaMs < 1000) return `+${(deltaMs / 1000).toFixed(1)}s`;
  if (deltaMs < 60_000) return `+${(deltaMs / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(deltaMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `+${m}m${s.toString().padStart(2, '0')}s`;
}

// --- Keyframes injection (once, module scope) -------------------------------
// Kept local so PlanPanel is self-contained — doesn't depend on sunny.css edits.
const KEYFRAMES_ID = 'sunny-plan-panel-keyframes';
function ensureKeyframes(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent =
    '@keyframes sunnyPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }';
  document.head.appendChild(style);
}

// --- Auto-scroll hook -------------------------------------------------------
// Sticks to the bottom as new steps arrive, but only while the user hasn't
// deliberately scrolled up. Threshold is generous (24px) so tiny momentum
// overshoots don't break the stick.
function useStickyAutoScroll(
  ref: React.RefObject<HTMLDivElement | null>,
  deps: ReadonlyArray<unknown>,
): void {
  const stickRef = useRef<boolean>(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (): void => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      stickRef.current = distanceFromBottom < 24;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    // Depend on caller-provided deps (e.g. steps array). The ref is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// --- Sub-components ---------------------------------------------------------

function StepRow({
  step,
  startedAt,
}: {
  readonly step: PlanStep;
  readonly startedAt: number | null;
}) {
  const iconColor = KIND_COLOR[step.kind];
  const iconStyle: CSSProperties = {
    gridColumn: '1 / 2',
    gridRow: '1 / 2',
    color: iconColor,
    fontSize: 11,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    lineHeight: 1.4,
    textAlign: 'center',
  };
  const textStyle: CSSProperties =
    step.kind === 'error'
      ? { ...STEP_TEXT_STYLE, color: ERROR_COLOR }
      : STEP_TEXT_STYLE;
  return (
    <div style={STEP_ROW_STYLE}>
      <span style={iconStyle} aria-hidden="true">
        {KIND_ICON[step.kind]}
      </span>
      <span style={textStyle} title={step.text}>
        {step.text}
      </span>
      <span style={TIME_STYLE}>{formatRelative(step.at, startedAt)}</span>
      {step.toolName !== undefined || step.durationMs !== undefined ? (
        <span style={STEP_META_STYLE}>
          {step.toolName !== undefined ? (
            <span style={TOOL_BADGE_STYLE}>{step.toolName}</span>
          ) : null}
          {step.durationMs !== undefined ? (
            <span>{step.durationMs}ms</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

// --- Main component --------------------------------------------------------

export function PlanPanel() {
  const status = useAgentStore(s => s.status);
  const steps = useAgentStore(s => s.steps);
  const startedAt = useAgentStore(s => s.startedAt);
  const requestAbort = useAgentStore(s => s.requestAbort);
  const clearRun = useAgentStore(s => s.clearRun);

  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Inject pulse keyframes on mount.
  useEffect(() => {
    ensureKeyframes();
  }, []);

  // Elapsed-time ticker — only runs while status === 'running'.
  useEffect(() => {
    if (status !== 'running' || startedAt === null) {
      setElapsedMs(0);
      return;
    }
    const tick = (): void => setElapsedMs(Date.now() - startedAt);
    tick();
    const handle = window.setInterval(tick, 500);
    return () => {
      window.clearInterval(handle);
    };
  }, [status, startedAt]);

  useStickyAutoScroll(bodyRef, [steps.length, collapsed]);

  const onToggle = useCallback(() => {
    setCollapsed(prev => !prev);
  }, []);

  const onStop = useCallback(() => {
    requestAbort();
  }, [requestAbort]);

  const onClear = useCallback(() => {
    clearRun();
  }, [clearRun]);

  const stepCount = steps.length;
  const running = status === 'running';

  const elapsedLabel = useMemo(() => formatElapsed(elapsedMs), [elapsedMs]);

  // Hidden entirely when there's nothing to show.
  if (status === 'idle' && stepCount === 0) return null;

  return (
    <aside style={PANEL_STYLE} aria-label="Agent plan panel">
      <div style={HEADER_STYLE}>
        <span style={HEADER_TITLE_STYLE}>AGENT</span>
        <span style={badgeStyle(status)}>{STATUS_LABELS[status]}</span>
        <span style={HEADER_META_STYLE}>
          {stepCount} {stepCount === 1 ? 'STEP' : 'STEPS'}
        </span>
        {running ? (
          <span style={HEADER_META_STYLE}>{elapsedLabel}</span>
        ) : null}
        <span style={HEADER_SPACER_STYLE} />
        <button
          type="button"
          onClick={onStop}
          disabled={!running}
          style={buttonStyle(ERROR_COLOR, !running)}
          aria-label="Stop agent run"
        >
          STOP
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={running}
          style={buttonStyle('var(--cyan)', running)}
          aria-label="Clear agent run"
        >
          CLEAR
        </button>
        <button
          type="button"
          onClick={onToggle}
          style={CARET_BUTTON_STYLE}
          aria-label={collapsed ? 'Expand plan panel' : 'Collapse plan panel'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {collapsed ? (
        <div style={COLLAPSED_NOTE_STYLE}>
          {stepCount} {stepCount === 1 ? 'STEP' : 'STEPS'} HIDDEN
        </div>
      ) : (
        <div style={BODY_STYLE} ref={bodyRef}>
          {stepCount === 0 ? (
            <div style={COLLAPSED_NOTE_STYLE}>WAITING FOR FIRST STEP…</div>
          ) : (
            steps.map(step => (
              <StepRow key={step.id} step={step} startedAt={startedAt} />
            ))
          )}
        </div>
      )}
    </aside>
  );
}
