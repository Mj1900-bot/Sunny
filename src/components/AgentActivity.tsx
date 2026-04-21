import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useEventBus, type SunnyEvent } from '../hooks/useEventBus';
import { useAgentStore, type AgentRunStatus } from '../store/agent';

// ---------------------------------------------------------------------------
// AgentActivity — sprint-7 κ v4 rework.
//
// Before: a single flat line ("SUNNY · streaming … N tok") driven off raw
// `sunny://chat.chunk` events — a tokens counter, not a trace. You couldn't
// tell which tool was firing, which iteration you were on, or what the agent
// had just thought.
//
// Now: a horizontal trace strip fed by the sprint-5/6 event bus. We subscribe
// to `AgentStep` events via Agent B's `useEventBus` hook (push-mode-friendly:
// it simply returns an accumulating newest-first list) and render the last 8
// steps of the *current* turn, colour-coded by kind:
//
//   thinking  → amber   (agent reasoning)
//   tool_call → cyan    (invoking a tool)
//   tool_result → green (tool returned)
//   error     → red
//
// The strip auto-scrolls to the newest step. When the turn ends
// (done / aborted / error in the agent store) we keep the strip visible for
// TERMINAL_LINGER_MS and then fade out via opacity transition, leaving the
// rail + idle placeholder in its place.
// ---------------------------------------------------------------------------

const MAX_STEPS = 8;
const SCROLL_END_PX = 52;
const TERMINAL_LINGER_MS = 10_000;
const FADE_MS = 600;
const TEXT_MAX = 72;

type AgentStepEvent = Extract<SunnyEvent, { kind: 'AgentStep' }>;

type StepKind = 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'other';

type DisplayStep = {
  readonly key: string;
  readonly iteration: number;
  readonly kind: StepKind;
  readonly tool: string | null;
  readonly text: string;
  readonly at: number;
};

// --- Helpers ---------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
}

/**
 * Classify an AgentStep into one of our rendering buckets. The event bus
 * doesn't carry a machine-readable `kind` tag on AgentStep (only `text` +
 * optional `tool`), so we infer:
 *   - `tool` present + text prefix "->" (result) → tool_result
 *   - `tool` present                              → tool_call
 *   - text prefix "ERR"/"error"                   → error
 *   - fallback                                    → thinking
 */
function classify(evt: AgentStepEvent): StepKind {
  const text = evt.text ?? '';
  const lower = text.toLowerCase();
  if (lower.startsWith('err') || lower.startsWith('error') || lower.includes('failed')) {
    return 'error';
  }
  if (typeof evt.tool === 'string' && evt.tool.length > 0) {
    // Result rows conventionally start with "->" or "result" in SUNNY's
    // agent loop; if we see that arrow, treat it as a tool_result.
    if (text.startsWith('->') || text.startsWith('\u2192') || lower.startsWith('result')) {
      return 'tool_result';
    }
    return 'tool_call';
  }
  if (text.length === 0) return 'other';
  return 'thinking';
}

function kindColor(kind: StepKind): string {
  switch (kind) {
    case 'thinking':
      return 'var(--amber)';
    case 'tool_call':
      return 'var(--cyan)';
    case 'tool_result':
      return 'var(--green)';
    case 'error':
      return 'var(--red)';
    case 'other':
      return 'var(--ink-dim)';
  }
}

function kindGlow(kind: StepKind): string {
  switch (kind) {
    case 'thinking':
      return '0 0 10px rgba(255, 179, 71, 0.42)';
    case 'tool_call':
      return '0 0 10px rgba(57, 229, 255, 0.42)';
    case 'tool_result':
      return '0 0 10px rgba(125, 255, 154, 0.42)';
    case 'error':
      return '0 0 10px rgba(255, 77, 94, 0.55)';
    case 'other':
      return 'none';
  }
}

function kindLabel(kind: StepKind): string {
  switch (kind) {
    case 'thinking':
      return 'THINK';
    case 'tool_call':
      return 'CALL';
    case 'tool_result':
      return 'RESULT';
    case 'error':
      return 'ERR';
    case 'other':
      return 'STEP';
  }
}

/**
 * Take the newest-first stream from `useEventBus`, keep only AgentSteps from
 * the single most-recent turn (so we don't mix turns on a rerun), then reduce
 * to the last MAX_STEPS entries ordered oldest → newest (left to right).
 */
function selectCurrentTurnSteps(events: readonly SunnyEvent[]): readonly DisplayStep[] {
  const steps: AgentStepEvent[] = [];
  for (const e of events) {
    if (e.kind === 'AgentStep') steps.push(e);
  }
  if (steps.length === 0) return [];

  const newestTurn = steps[0].turn_id;
  const sameTurn = steps.filter(s => s.turn_id === newestTurn);

  // Newest-first → reverse for oldest-first display, then cap to the tail.
  const chronological = [...sameTurn].reverse();
  const tail = chronological.length > MAX_STEPS
    ? chronological.slice(chronological.length - MAX_STEPS)
    : chronological;

  return tail.map((evt): DisplayStep => ({
    key: `${evt.turn_id}|${evt.iteration}|${evt.at}`,
    iteration: evt.iteration,
    kind: classify(evt),
    tool: typeof evt.tool === 'string' && evt.tool.length > 0 ? evt.tool : null,
    text: evt.text ?? '',
    at: evt.at,
  }));
}

// --- Component -------------------------------------------------------------

export function AgentActivity() {
  const events = useEventBus({ kind: 'AgentStep', limit: MAX_STEPS * 4 });
  const status = useAgentStore(s => s.status);

  const steps = useMemo(() => selectCurrentTurnSteps(events), [events]);

  // Terminal-fade: once status flips to a terminal value, hold the strip
  // visible for TERMINAL_LINGER_MS then fade out.
  const [opacity, setOpacity] = useState<number>(1);
  const [hidden, setHidden] = useState<boolean>(false);
  const lingerRef = useRef<number | null>(null);
  const fadeRef = useRef<number | null>(null);

  useEffect(() => {
    const clearPending = (): void => {
      if (lingerRef.current !== null) {
        window.clearTimeout(lingerRef.current);
        lingerRef.current = null;
      }
      if (fadeRef.current !== null) {
        window.clearTimeout(fadeRef.current);
        fadeRef.current = null;
      }
    };

    if (status === 'running' || status === 'idle') {
      clearPending();
      setOpacity(1);
      setHidden(false);
      return;
    }

    // Terminal: done / aborted / error — linger, then fade, then hide.
    setOpacity(1);
    setHidden(false);
    lingerRef.current = window.setTimeout(() => {
      setOpacity(0);
      fadeRef.current = window.setTimeout(() => setHidden(true), FADE_MS);
    }, TERMINAL_LINGER_MS);

    return () => {
      clearPending();
    };
  }, [status]);

  // --- Auto-scroll rail (preserved from prior impl) -----------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const followEndRef = useRef(true);
  const programmaticScrollRef = useRef(false);

  const syncFollowFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (programmaticScrollRef.current) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) {
      followEndRef.current = true;
      setShowJumpLatest(false);
      return;
    }
    const dist = max - el.scrollLeft;
    const nearEnd = dist <= SCROLL_END_PX;
    followEndRef.current = nearEnd;
    setShowJumpLatest(!nearEnd);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !followEndRef.current) return;
    programmaticScrollRef.current = true;
    el.scrollLeft = el.scrollWidth - el.clientWidth;
    setShowJumpLatest(false);
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [steps]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', syncFollowFromScroll, { passive: true });
    return () => el.removeEventListener('scroll', syncFollowFromScroll);
  }, [syncFollowFromScroll]);

  useEffect(() => {
    if (steps.length === 0) {
      followEndRef.current = true;
      setShowJumpLatest(false);
    }
  }, [steps.length]);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollLeft = el.scrollWidth - el.clientWidth;
    followEndRef.current = true;
    setShowJumpLatest(false);
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  const isLive = status === 'running';
  const lastIndex = steps.length - 1;

  const rail = (
    <div className="agent-activity__rail" aria-hidden="true">
      <span className="agent-activity__label">TRACE</span>
      <span
        className={`agent-activity__dot${isLive ? ' agent-activity__dot--live' : ''}`}
        title={isLive ? 'Agent running' : statusTitle(status)}
      />
    </div>
  );

  const rootStyle: CSSProperties = {
    opacity,
    transition: `opacity ${FADE_MS}ms ease-out`,
  };

  if (hidden || steps.length === 0) {
    return (
      <div className="agent-activity" style={rootStyle}>
        {rail}
        <div className="agent-activity__scroll-wrap">
          <div className="agent-activity__idle">
            {isLive ? 'agent running · awaiting first step\u2026' : 'agent idle · awaiting signal'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-activity" style={rootStyle}>
      {rail}
      <div className="agent-activity__scroll-wrap">
        <div
          ref={scrollRef}
          className="agent-activity__scroll"
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {steps.map((s, i) => {
            const isLast = i === lastIndex;
            const color = kindColor(s.kind);
            const glow = kindGlow(s.kind);
            const iterTag = `i${s.iteration}`;
            const toolTag = s.tool !== null ? ` ${s.tool}` : '';
            const label = kindLabel(s.kind);
            const display = `${iterTag} · ${label}${toolTag} · ${truncate(s.text, TEXT_MAX)}`;
            return (
              <span key={s.key} style={{ display: 'contents' }}>
                {i > 0 ? (
                  <span className="agent-activity__sep" aria-hidden="true">│</span>
                ) : null}
                <span
                  className={`agent-activity__entry${isLast ? ' agent-activity__entry--hot' : ' agent-activity__entry--dim'}`}
                  style={{
                    color: isLast ? color : stepDimColor(color),
                    textShadow: isLast ? glow : undefined,
                  }}
                  title={`iter ${s.iteration} · ${label}${toolTag} · ${s.text}`}
                >
                  {display}
                </span>
              </span>
            );
          })}
        </div>
      </div>
      {showJumpLatest ? (
        <button
          type="button"
          className="agent-activity__jump"
          onClick={jumpToLatest}
          title="Scroll to latest activity"
        >
          LATEST
        </button>
      ) : null}
    </div>
  );
}

// Dim variant of a CSS color token for non-latest entries. We can't mutate
// `var(--cyan)` directly, so we layer a reduced-opacity wrapper via
// `color-mix` where supported, else fall back to the raw var (the container
// already dims via .agent-activity__entry--dim).
function stepDimColor(color: string): string | undefined {
  // Using color-mix keeps the hue consistent with the hot variant while
  // fading toward the ink background; modern Chromium/WebKit support this
  // natively. If a browser doesn't, the selector-level dim class still
  // applies a flat 48% ink fallback via sunny.css.
  return `color-mix(in srgb, ${color} 55%, rgba(230, 248, 255, 0.18))`;
}

function statusTitle(status: AgentRunStatus): string {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'running':
      return 'Agent running';
    case 'done':
      return 'Last run finished';
    case 'aborted':
      return 'Last run aborted';
    case 'error':
      return 'Last run errored';
  }
}
