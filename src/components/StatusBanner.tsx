import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { invokeSafe, isTauri } from '../lib/tauri';
import {
  useAgentStore,
  type AgentRunStatus,
  type PlanStep,
} from '../store/agent';
import { useEventBus, type SunnyEvent } from '../hooks/useEventBus';

// ---------------------------------------------------------------------------
// StatusBanner
//
// Two overlapping surfaces live here, stacked in the bottom-right corner:
//
//  1. Provider-offline banner (amber) — original contract, preserved as-is.
//     Shown when Ollama + OpenClaw gateway checks both fail, or when just
//     the gateway is down.
//
//  2. Live agent-run strip (cyan / amber / red) — NEW in sprint-4. Surfaces
//     the running agent's current step, step count, elapsed time, and the
//     tool it's actively calling. Fades on completion so it doesn't linger.
//
// Both are small, mono-font, and follow the existing amber/cyan/green HUD
// palette. The agent strip has intentionally softer glow so it doesn't
// compete with the orb when the eye is already drawn to the center of
// the HUD.
// ---------------------------------------------------------------------------

const POLL_MS = 25_000;
const OLLAMA_URL = 'http://127.0.0.1:11434/api/tags';

// How long we linger on a terminal agent status (done/error/aborted) before
// auto-hiding. Gives the user a beat to read the summary without the strip
// becoming permanent visual noise.
const TERMINAL_LINGER_MS = 6_000;

// Cross-session replay window — sprint-6 Agent θ. On mount we peek at the
// Rust event bus for the last run's `AgentStep` trail so a fresh reload can
// still show "what SUNNY was just doing". Anything older than
// `REPLAY_RECENCY_MS` is treated as stale and suppressed so we don't surface
// yesterday's run as if it were relevant.
const REPLAY_LIMIT = 20;
const REPLAY_RECENCY_MS = 5 * 60 * 1000;    // 5 minutes
const REPLAY_AUTOHIDE_MS = 30_000;          // 30 seconds visible after mount
const REPLAY_POLL_MS = 5_000;               // honour the no-faster-than-5s constraint

type ProviderStatus = {
  readonly openclaw: boolean;
  readonly ollama: boolean;
};

const INITIAL_STATUS: ProviderStatus = { openclaw: true, ollama: true };

async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch(OLLAMA_URL, { method: 'GET' });
    return res.ok;
  } catch (error) {
    console.error('ollama probe failed:', error);
    return false;
  }
}

async function checkOpenClaw(): Promise<boolean> {
  if (!isTauri) return false;
  const res = await invokeSafe<boolean>('openclaw_ping');
  return res === true;
}

function bannerMessage(status: ProviderStatus): string | null {
  if (!status.openclaw && !status.ollama) {
    return '\u26A0 NO AI PROVIDER REACHABLE';
  }
  if (!status.openclaw) {
    return '\u26A0 OPENCLAW GATEWAY OFFLINE \u2014 falling back to Ollama';
  }
  return null;
}

// --- Agent strip helpers ---------------------------------------------------

const STATUS_COLOR: Record<AgentRunStatus, string> = {
  idle: 'var(--cyan)',
  running: 'var(--cyan)',
  done: 'var(--green)',
  aborted: 'rgb(255, 82, 82)',
  error: 'rgb(255, 82, 82)',
};

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  idle: 'IDLE',
  running: 'RUN',
  done: 'DONE',
  aborted: 'ABORT',
  error: 'ERR',
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs.toString().padStart(2, '0')}s`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
}

// Pull the most recent meaningful step for display. Errors win over
// anything (so the user sees failures immediately), otherwise the newest
// non-message step wins, otherwise the tail.
function pickFocusStep(
  steps: ReadonlyArray<PlanStep>,
): PlanStep | null {
  if (steps.length === 0) return null;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].kind === 'error') return steps[i];
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const k = steps[i].kind;
    if (k === 'tool_call' || k === 'tool_result' || k === 'plan') return steps[i];
  }
  return steps[steps.length - 1];
}

// --- Replay helpers --------------------------------------------------------

type ReplaySummary = {
  readonly stepCount: number;
  readonly lastTool: string | null;
  readonly finishedAt: number;
};

// Filter to `AgentStep` events belonging to the single most-recent `turn_id`,
// then summarise them for the condensed echo line. Returns null if nothing
// is fresh enough or no AgentStep rows exist.
function buildReplaySummary(
  events: readonly SunnyEvent[],
  now: number,
): ReplaySummary | null {
  const steps: ReadonlyArray<Extract<SunnyEvent, { kind: 'AgentStep' }>> =
    events.filter((e): e is Extract<SunnyEvent, { kind: 'AgentStep' }> => e.kind === 'AgentStep');
  if (steps.length === 0) return null;

  const newest = steps[0];
  if (now - newest.at > REPLAY_RECENCY_MS) return null;

  const turnId = newest.turn_id;
  const sameTurn = steps.filter(s => s.turn_id === turnId);

  // Find the most recent tool invocation in this turn.
  const lastToolStep = sameTurn.find(s => typeof s.tool === 'string' && s.tool.length > 0);
  const lastTool = lastToolStep?.tool ?? null;

  return {
    stepCount: sameTurn.length,
    lastTool,
    finishedAt: newest.at,
  };
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function formatReplayLine(summary: ReplaySummary, now: number): string {
  const n = summary.stepCount;
  const head = `last run: ${n} ${n === 1 ? 'step' : 'steps'}`;
  const tool = summary.lastTool !== null ? ` \u00B7 used ${summary.lastTool} tool` : '';
  const ago = ` \u00B7 finished ${formatAgo(now - summary.finishedAt)}`;
  return `${head}${tool}${ago}`;
}

// --- Agent strip component -------------------------------------------------

const KEYFRAMES_ID = 'sunny-status-banner-keyframes';
function ensureKeyframes(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent =
    '@keyframes sunnySbPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }' +
    '@keyframes sunnySbFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }';
  document.head.appendChild(style);
}

function AgentStrip(): ReactElement | null {
  const status = useAgentStore(s => s.status);
  const goal = useAgentStore(s => s.goal);
  const steps = useAgentStore(s => s.steps);
  const startedAt = useAgentStore(s => s.startedAt);

  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [lingering, setLingering] = useState<boolean>(false);

  // Cross-session replay — pull the last run's AgentStep events from the
  // sprint-5 event bus via γ's hook. If γ's hook isn't wired to a backing
  // command yet (or we're running outside Tauri), it returns an empty array
  // and the replay line simply never renders.
  const replayEvents = useEventBus({
    kind: 'AgentStep',
    limit: REPLAY_LIMIT,
    pollMs: REPLAY_POLL_MS,
  });

  // Mount time anchors the 30 s auto-hide — the echo is a courtesy "what
  // was SUNNY doing" signal, not a permanent fixture.
  const [mountedAt] = useState<number>(() => Date.now());
  const [replayExpired, setReplayExpired] = useState<boolean>(false);
  // A live `now` tick so "finished N min ago" stays current without a full
  // re-render cascade on every poll.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    ensureKeyframes();
  }, []);

  // Tick elapsed only while running.
  useEffect(() => {
    if (status !== 'running' || startedAt === null) return;
    const tick = (): void => setElapsedMs(Date.now() - startedAt);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [status, startedAt]);

  // Auto-hide terminal status after a short linger so the strip doesn't
  // stick around forever after a run completes.
  useEffect(() => {
    if (status === 'running' || status === 'idle') {
      setLingering(false);
      return;
    }
    setLingering(true);
    const id = window.setTimeout(() => setLingering(false), TERMINAL_LINGER_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [status, steps.length]);

  // Auto-hide the replay echo 30 s after mount. Runs once; if a new run
  // starts in the meantime the live strip takes precedence anyway.
  useEffect(() => {
    const elapsed = Date.now() - mountedAt;
    const remaining = REPLAY_AUTOHIDE_MS - elapsed;
    if (remaining <= 0) {
      setReplayExpired(true);
      return;
    }
    const id = window.setTimeout(() => setReplayExpired(true), remaining);
    return () => {
      window.clearTimeout(id);
    };
  }, [mountedAt]);

  // Keep "finished N min ago" fresh — cheap 5 s tick, aligned with poll rate.
  useEffect(() => {
    if (replayExpired) return;
    const id = window.setInterval(() => setNowMs(Date.now()), REPLAY_POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [replayExpired]);

  const focusStep = useMemo(() => pickFocusStep(steps), [steps]);

  const replaySummary = useMemo<ReplaySummary | null>(() => {
    if (replayExpired) return null;
    return buildReplaySummary(replayEvents, nowMs);
  }, [replayEvents, replayExpired, nowMs]);

  // Replay should only surface when the live run is truly idle — a fresh
  // session with no current activity. The live strip always wins.
  const showReplay = status === 'idle' && replaySummary !== null;

  // Hidden when truly nothing to show (idle with no replay, or terminal
  // state already lingered past its window).
  if (status === 'idle' && !showReplay) return null;
  if (status !== 'running' && status !== 'idle' && !lingering) return null;

  const running = status === 'running';
  const color = STATUS_COLOR[status];

  const containerStyle: CSSProperties = {
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 899, // directly below the provider banner (900)
    minWidth: 260,
    maxWidth: 360,
    padding: '8px 12px',
    border: `1px solid ${color}`,
    background: 'rgba(4, 10, 16, 0.92)',
    color: 'var(--ink-2)',
    fontFamily: 'var(--mono)',
    fontSize: 11,
    letterSpacing: '0.06em',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    boxShadow: running
      ? `0 0 14px rgba(57, 229, 255, 0.18)`
      : `0 0 10px rgba(0, 0, 0, 0.5)`,
    animation: 'sunnySbFadeIn 180ms ease-out',
  };

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  };

  const pillStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '1px 6px',
    border: `1px solid ${color}`,
    color,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.2em',
    borderRadius: 2,
    animation: running ? 'sunnySbPulse 1.4s ease-in-out infinite' : undefined,
  };

  const dotStyle: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: color,
    boxShadow: `0 0 6px ${color}`,
  };

  const metaStyle: CSSProperties = {
    color: 'var(--ink-dim)',
    fontSize: 9,
    letterSpacing: '0.18em',
    fontVariantNumeric: 'tabular-nums',
  };

  const goalStyle: CSSProperties = {
    color: 'var(--ink)',
    fontSize: 11,
    lineHeight: 1.35,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const stepStyle: CSSProperties = {
    color: focusStep?.kind === 'error' ? STATUS_COLOR.error : 'var(--cyan)',
    fontSize: 10,
    letterSpacing: '0.04em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const toolBadge: CSSProperties = {
    padding: '0 4px',
    border: '1px solid var(--line-soft)',
    color: 'var(--amber)',
    fontSize: 9,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    borderRadius: 2,
  };

  const stepCount = steps.length;

  // Replay-only render: idle store + fresh bus events. Compact single-line
  // echo using `var(--ink-dim)` to visually demote it below live-run cyan.
  if (status === 'idle') {
    if (replaySummary === null) return null;
    const replayContainerStyle: CSSProperties = {
      position: 'fixed',
      right: 16,
      bottom: 16,
      zIndex: 899,
      minWidth: 260,
      maxWidth: 360,
      padding: '6px 10px',
      border: '1px solid var(--line-soft)',
      background: 'rgba(4, 10, 16, 0.82)',
      color: 'var(--ink-dim)',
      fontFamily: 'var(--mono)',
      fontSize: 10,
      letterSpacing: '0.06em',
      boxShadow: '0 0 8px rgba(0, 0, 0, 0.4)',
      animation: 'sunnySbFadeIn 180ms ease-out',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Previous agent run summary"
        style={replayContainerStyle}
        title={formatReplayLine(replaySummary, nowMs)}
      >
        {formatReplayLine(replaySummary, nowMs)}
      </div>
    );
  }

  // Live / lingering render — `var(--cyan)` accents via STATUS_COLOR mean
  // the active run always reads brighter than the dim replay echo.
  return (
    <div role="status" aria-live="polite" aria-label="Agent run status" style={containerStyle}>
      <div style={rowStyle}>
        <span style={pillStyle} aria-hidden="true">
          <span style={dotStyle} />
          {STATUS_LABEL[status]}
        </span>
        <span style={metaStyle}>
          {stepCount} {stepCount === 1 ? 'STEP' : 'STEPS'}
        </span>
        {running ? <span style={metaStyle}>{formatElapsed(elapsedMs)}</span> : null}
      </div>
      {goal ? <div style={goalStyle} title={goal}>{truncate(goal, 72)}</div> : null}
      {focusStep ? (
        <div style={stepStyle} title={focusStep.text}>
          {focusStep.toolName !== undefined ? (
            <span style={toolBadge}>{focusStep.toolName}</span>
          ) : null}
          {focusStep.toolName !== undefined ? ' ' : ''}
          {truncate(focusStep.text, 72)}
        </div>
      ) : running ? (
        <div style={{ ...stepStyle, color: 'var(--ink-dim)' }}>{'awaiting first step\u2026'}</div>
      ) : null}
    </div>
  );
}

// --- Provider-offline banner (original) ------------------------------------

export function StatusBanner() {
  const [status, setStatus] = useState<ProviderStatus>(INITIAL_STATUS);
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;

    const probe = async () => {
      const [openclaw, ollama] = await Promise.all([checkOpenClaw(), checkOllama()]);
      if (!alive) return;
      setStatus(prev => (prev.openclaw === openclaw && prev.ollama === ollama ? prev : { openclaw, ollama }));
    };

    probe();
    const id = window.setInterval(probe, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const message = bannerMessage(status);
  const showProvider = !dismissed && message !== null;

  return (
    <>
      {showProvider ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 900,
            width: 300,
            padding: '10px 14px',
            border: '1px solid var(--amber)',
            background: 'rgba(10, 6, 0, 0.88)',
            color: 'var(--amber)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.08em',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: '1px solid var(--amber)',
              color: 'var(--amber)',
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.12em',
              padding: '2px 6px',
              cursor: 'pointer',
            }}
            aria-label="Dismiss connection status banner"
          >
            DISMISS
          </button>
        </div>
      ) : null}
      {/* Live agent-run strip. Sits directly beneath the provider banner
          (z-index 899 vs 900). When the provider banner is absent the strip
          visually occupies the same spot; when both are present the amber
          provider banner stacks on top and the agent strip remains visible
          just below the fold. Auto-hides on idle, auto-lingers briefly on
          terminal states (done / aborted / error). */}
      <AgentStrip />
    </>
  );
}
