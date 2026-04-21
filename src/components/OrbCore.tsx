import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Panel } from './Panel';
import type { SystemMetrics } from '../hooks/useMetrics';
import { VoiceButton } from './VoiceButton';
import { useVoiceChat, type VoiceState } from '../hooks/useVoiceChat';

import { useEventBus, type SunnyEvent } from '../hooks/useEventBus';
import { useAgentStore, type PlanStep } from '../store/agent';
import { useView } from '../store/view';

type StepStatusKind = 'tool_call' | 'tool_result' | 'message' | 'error';
type StepStatus = { text: string; kind: StepStatusKind };

// Color palette for each step kind — subtle, distinguishable at a glance but
// not shouty. Cyan matches the orb's primary tint; amber reuses the YOU label
// color for continuity; red is reserved for error so it reads as alarming.
const STEP_COLORS: Record<StepStatusKind, string> = {
  tool_call: 'var(--cyan)',
  tool_result: 'var(--amber)',
  message: 'currentColor',
  error: '#ff6b6b',
};

// Turn the latest ReAct step into a short status line for the orb footer.
// Keeps `SUNNY is thinking…` as a fallback when the agent hasn't emitted
// anything yet — but the moment the first tool call fires, the user sees
// exactly what the agent is doing instead of a blind spinner.
function stepToStatus(step: PlanStep | null): StepStatus | null {
  if (!step) return null;
  switch (step.kind) {
    case 'tool_call':
      return {
        text: step.toolName ? `calling ${step.toolName}…` : 'calling tool…',
        kind: 'tool_call',
      };
    case 'tool_result':
      return {
        text: step.toolName ? `${step.toolName} done` : 'tool done',
        kind: 'tool_result',
      };
    case 'message': {
      const t = step.text.trim();
      if (t.length === 0) return null;
      return {
        text: t.length > 70 ? `${t.slice(0, 69)}…` : t,
        kind: 'message',
      };
    }
    case 'error':
      return { text: `error: ${step.text.slice(0, 50)}`, kind: 'error' };
    default:
      return null;
  }
}

type AgentFlash = 'green' | 'red' | null;
const DONE_FLASH_MS = 1200;
const ERROR_FLASH_MS = 1200;
// Amber pulse raised by the voice-path constitution verifier when a
// `confirm_destructive_ran` violation fires. Sprint-12 ζ: the pulse is a
// subtle audit cue — the tool already ran, so we don't block TTS; we
// just surface that the reply lacked an explicit confirmation phrase.
const CONSTITUTION_AMBER_PULSE_MS = 1000;
const CONSTITUTION_AMBER_PULSE_EVENT = 'sunny-constitution-amber-pulse';

const CTX_LIMIT_K = 16;
const CHARS_PER_TOKEN = 4;
const CHAT_HISTORY_KEY = 'sunny.chat.history.v1';
/** Rolling window for HUD "tokens per second" (output, from stream chunks). */
const TOKEN_RATE_WINDOW_MS = 1000;
const TOKEN_RATE_MIN_WINDOW_S = 0.09;
const TOKEN_RATE_TICK_MS = 100;
/** Slower decay poll when no stream is active — avoids 10×/s idle CPU burn. */
const TOKEN_RATE_IDLE_TICK_MS = 2000;

type TokenRateSample = { t: number; c: number };

function tokenRatePerSecond(samples: TokenRateSample[], now: number): number {
  const cutoff = now - TOKEN_RATE_WINDOW_MS;
  const fresh = samples.filter(s => s.t >= cutoff);
  if (fresh.length === 0) return 0;
  const sum = fresh.reduce((a, s) => a + s.c, 0);
  const t0 = fresh.reduce((m, s) => Math.min(m, s.t), fresh[0].t);
  const spanS = Math.max(TOKEN_RATE_MIN_WINDOW_S, (now - t0) / 1000);
  return sum / spanS;
}

function formatTokenRate(r: number): string {
  if (r <= 0) return '0';
  if (r < 10) return r.toFixed(1);
  return String(Math.round(r));
}

type ChatChunkEvent = Extract<SunnyEvent, { kind: 'ChatChunk' }>;

function makeSessionHex(): string {
  const raw = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return raw.toUpperCase();
}

function lambdaFor(v: VoiceState): number {
  if (v === 'speaking') return 0.99;
  if (v === 'thinking' || v === 'transcribing') return 0.88;
  return 0.65;
}

function neuralStatus(state: OrbState): string {
  if (state === 'thinking' || state === 'speaking') return 'ACTIVE';
  if (state === 'alert') return 'ALERT';
  return 'IDLE';
}

function historyLength(): number {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!raw) return 0;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'alert';

const STATES: Record<OrbState, { energy: number; speed: number; chaos: number; label: string; sub: string }> = {
  idle:      { energy: 0.25, speed: 0.6, chaos: 0.1, label: 'IDLE',      sub: 'STANDBY' },
  listening: { energy: 0.55, speed: 1.0, chaos: 0.25, label: 'LISTENING', sub: 'ONLINE · READY' },
  thinking:  { energy: 0.75, speed: 1.4, chaos: 0.6,  label: 'THINKING',  sub: 'PROCESSING' },
  speaking:  { energy: 1.0,  speed: 1.8, chaos: 0.9,  label: 'SPEAKING',  sub: 'TTS · ACTIVE' },
  alert:     { energy: 1.1,  speed: 2.4, chaos: 1.0,  label: 'ALERT',     sub: 'ATTENTION REQUIRED' },
};

type Props = { metrics: SystemMetrics | null; intensity?: number; latencyMs?: number };

type OrbStatePolicy = 'fixed' | 'load' | 'voice' | 'focus';

// Load-reactive hysteresis thresholds. Deliberately asymmetric so the orb
// doesn't flicker when CPU sits right on a boundary (e.g. build spikes).
const CPU_CALM_ENTER = 25;  // drop into idle below this
const CPU_CALM_EXIT  = 35;  // … but only leave idle once we climb above this
const CPU_BUSY_ENTER = 65;  // climb into thinking above this
const CPU_BUSY_EXIT  = 55;  // … but only leave thinking once we drop below this
const TEMP_ALERT_C   = 82;  // hardware getting hot
const TEMP_CLEAR_C   = 76;  // and the threshold to leave alert

/**
 * Decide the orb's baseline state from system metrics. Voice activity is
 * layered on top by `voiceToOrbState` in the caller — this function only
 * owns the ambient/system channel. Policy is user-selectable in Settings.
 *
 *   fixed  — stay on `listening` (matches the design mockup exactly)
 *   load   — idle when CPU calm, thinking when CPU busy, alert when hot
 *   voice  — idle (voice hook drives the foreground state exclusively)
 *   focus  — listening when the app is active, idle when backgrounded
 *
 * Uses hysteresis on `prev` so a CPU value straddling a threshold doesn't
 * flip-flop the orb every 1.4s metrics tick.
 */
function pickOrbState(
  metrics: SystemMetrics | null,
  prev: OrbState,
  policy: OrbStatePolicy,
): OrbState {
  if (policy === 'fixed' || policy === 'voice') return 'listening';

  if (policy === 'focus') {
    if (typeof document === 'undefined') return 'listening';
    return document.visibilityState === 'visible' && document.hasFocus()
      ? 'listening'
      : 'idle';
  }

  // policy === 'load'
  if (!metrics) return prev;
  const cpu = Number.isFinite(metrics.cpu) ? metrics.cpu : 0;
  const temp = Number.isFinite(metrics.temp_c) ? metrics.temp_c : 0;

  if (prev === 'alert') {
    if (temp < TEMP_CLEAR_C) return cpu > CPU_BUSY_EXIT ? 'thinking' : 'listening';
    return 'alert';
  }
  if (temp >= TEMP_ALERT_C) return 'alert';

  if (prev === 'idle') {
    return cpu > CPU_CALM_EXIT ? 'listening' : 'idle';
  }
  if (prev === 'thinking') {
    if (cpu < CPU_BUSY_EXIT) return cpu < CPU_CALM_ENTER ? 'idle' : 'listening';
    return 'thinking';
  }
  if (cpu < CPU_CALM_ENTER) return 'idle';
  if (cpu > CPU_BUSY_ENTER) return 'thinking';
  return 'listening';
}

function truncateTail(s: string, max = 140): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - (max - 1));
}

function voiceToOrbState(v: VoiceState, _error: string | null): OrbState | null {
  // Errors are shown inline next to the mic button. They don't hijack the
  // orb state — that would make a missing whisper install look like a
  // system-wide emergency.
  switch (v) {
    case 'recording': return 'listening';
    case 'transcribing': return 'thinking';
    case 'thinking': return 'thinking';
    case 'speaking': return 'speaking';
    case 'idle': return null;
    default: return null;
  }
}

export function OrbCore({ metrics, intensity = 1, latencyMs }: Props) {
  const [state, setState] = useState<OrbState>('listening');
  const [baseState, setBaseState] = useState<OrbState>('listening');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringARef = useRef<SVGGElement>(null);
  const ringBRef = useRef<SVGGElement>(null);
  const voice = useVoiceChat();

  // Respect prefers-reduced-motion: halt rAF loops and CSS animations when the
  // user has requested reduced motion. We listen for changes so toggling the
  // system setting mid-session takes effect immediately without a reload.
  const [reducedMotion, setReducedMotion] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const [sessionHex] = useState<string>(() => makeSessionHex());
  const [tokenEstimate, setTokenEstimate] = useState<number>(0);
  const [tokenRatePerSec, setTokenRatePerSec] = useState<number>(0);
  const tokenRateSamplesRef = useRef<TokenRateSample[]>([]);
  /** Timestamp (performance.now) of the last received stream chunk — used to gate the decay ticker. */
  const lastChunkAtRef = useRef<number>(0);
  const historyLenRef = useRef<number>(historyLength());

  // Agent activity — the orb's outer ring mirrors the background agent's lifecycle
  // without stomping on voice visuals. Voice state still owns the core orb; the
  // ring is purely additive and sits behind everything else.
  const agentStatus = useAgentStore(s => s.status);
  // Subscribe to the last ReAct step so the footer can show live progress
  // ("calling calendar_list_events…") instead of a featureless "thinking…".
  // Selector returns just the tail so the component only re-renders on new
  // steps, not on every store update.
  const lastStep = useAgentStore(s => (s.steps.length > 0 ? s.steps[s.steps.length - 1] : null));
  const prevAgentStatusRef = useRef(agentStatus);
  const [agentFlash, setAgentFlash] = useState<AgentFlash>(null);
  // Constitution kick — `confirm_destructive_ran` fired on the voice path.
  // Independent channel from `agentFlash` so a running-agent amber breathe
  // and a constitution audit pulse don't race each other's timers.
  const [constAmberPulse, setConstAmberPulse] = useState<boolean>(false);

  useEffect(() => {
    const prev = prevAgentStatusRef.current;
    prevAgentStatusRef.current = agentStatus;
    // Skip the initial mount — flashing green on reload would be a lie.
    if (prev === agentStatus) return;
    if (agentStatus === 'done') {
      setAgentFlash('green');
      const t = window.setTimeout(() => setAgentFlash(null), DONE_FLASH_MS);
      return () => window.clearTimeout(t);
    }
    if (agentStatus === 'error' || agentStatus === 'aborted') {
      setAgentFlash('red');
      const t = window.setTimeout(() => setAgentFlash(null), ERROR_FLASH_MS);
      return () => window.clearTimeout(t);
    }
    // Running / idle don't use the flash channel — running uses the ring.
    setAgentFlash(null);
    return undefined;
  }, [agentStatus]);

  // Subscribe to constitution amber-pulse events dispatched by the voice
  // path's `sanitizeVoiceAnswer` when a `confirm_destructive_ran` warning
  // fires. One-second pulse, then self-clears. A rapid second pulse while
  // the first is still live just re-arms the timer — visually indistinct
  // from a sustained pulse, which is the desired UX.
  useEffect(() => {
    let clearTimer: number | null = null;
    const onPulse = () => {
      setConstAmberPulse(true);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        setConstAmberPulse(false);
        clearTimer = null;
      }, CONSTITUTION_AMBER_PULSE_MS);
    };
    window.addEventListener(CONSTITUTION_AMBER_PULSE_EVENT, onPulse);
    return () => {
      window.removeEventListener(CONSTITUTION_AMBER_PULSE_EVENT, onPulse);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
    };
  }, []);

  // Live transcript — user speech in, AI response out. No fake wake-word cycling.
  const [userLine, setUserLine] = useState<string>('');
  const [sunnyLine, setSunnyLine] = useState<string>('');

  const orbStatePolicy = useView(s => s.settings.orbStatePolicy);

  useEffect(() => {
    setBaseState(prev => pickOrbState(metrics, prev, orbStatePolicy));
  }, [metrics, orbStatePolicy]);

  // Focus-reactive policy needs to re-run on visibility / focus changes too,
  // not just metrics ticks — otherwise backgrounding the app wouldn't flip
  // the orb until the next 1.4s tick.
  useEffect(() => {
    if (orbStatePolicy !== 'focus') return;
    const update = () => setBaseState(prev => pickOrbState(metrics, prev, orbStatePolicy));
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [orbStatePolicy, metrics]);

  useEffect(() => {
    const override = voiceToOrbState(voice.state, voice.error);
    setState(override ?? baseState);
  }, [voice.state, voice.error, baseState]);

  // Track token usage from streaming chat chunks (accumulates for CTX · …),
  // and a rolling-window rate for TOK/S (output tokens / second).
  //
  // Sprint-9 migration: subscribed to the Rust event bus via `useEventBus`
  // instead of the legacy `sunny://chat.chunk` Tauri listener. The bus
  // returns events newest-first and accumulates as they arrive, so we
  // track the newest seen key per-event and only count fresh deltas.
  const chatChunkEvents = useEventBus({ kind: 'ChatChunk', limit: 200 });
  const lastSeenChunkKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (chatChunkEvents.length === 0) return;
    // Events are newest-first — walk oldest→newest so counters accumulate
    // in natural order, stopping at the last key we already processed.
    const lastSeen = lastSeenChunkKeyRef.current;
    const freshOldestFirst: ChatChunkEvent[] = [];
    for (const e of chatChunkEvents) {
      if (e.kind !== 'ChatChunk') continue;
      const key =
        typeof e.seq === 'number'
          ? `seq|${e.seq}`
          : `at|${e.at}|${e.turn_id}|${e.delta.length}|${e.done ? 1 : 0}`;
      if (key === lastSeen) break;
      freshOldestFirst.unshift(e);
    }
    if (freshOldestFirst.length === 0) return;
    const newest = freshOldestFirst[freshOldestFirst.length - 1];
    lastSeenChunkKeyRef.current =
      typeof newest.seq === 'number'
        ? `seq|${newest.seq}`
        : `at|${newest.at}|${newest.turn_id}|${newest.delta.length}|${newest.done ? 1 : 0}`;

    const now = performance.now();
    let totalAdded = 0;
    for (const e of freshOldestFirst) {
      const delta = typeof e.delta === 'string' ? e.delta : '';
      if (delta.length === 0) continue;
      const added = Math.max(1, Math.ceil(delta.length / CHARS_PER_TOKEN));
      tokenRateSamplesRef.current.push({ t: now, c: added });
      totalAdded += added;
    }
    if (totalAdded === 0) return;
    lastChunkAtRef.current = now;
    tokenRateSamplesRef.current = tokenRateSamplesRef.current.filter(
      s => now - s.t <= TOKEN_RATE_WINDOW_MS,
    );
    setTokenRatePerSec(tokenRatePerSecond(tokenRateSamplesRef.current, now));
    setTokenEstimate(prev => prev + totalAdded);
  }, [chatChunkEvents]);

  // Decay TOK/S when chunks stop (rolling window empties).
  // Adaptive rate: 100ms while streaming (for smooth HUD), 2s when idle
  // so we don't burn 10 JS executions/sec for an empty filter.
  useEffect(() => {
    let id: ReturnType<typeof window.setInterval>;

    const schedule = (ms: number) => {
      id = window.setInterval(() => {
        const now = performance.now();
        tokenRateSamplesRef.current = tokenRateSamplesRef.current.filter(
          s => now - s.t <= TOKEN_RATE_WINDOW_MS,
        );
        setTokenRatePerSec(tokenRatePerSecond(tokenRateSamplesRef.current, now));
        // Switch cadence based on whether chunks arrived recently.
        const isStreaming = now - lastChunkAtRef.current < TOKEN_RATE_WINDOW_MS * 2;
        const nextMs = isStreaming ? TOKEN_RATE_TICK_MS : TOKEN_RATE_IDLE_TICK_MS;
        if (nextMs !== ms) {
          window.clearInterval(id);
          schedule(nextMs);
        }
      }, ms);
    };

    schedule(TOKEN_RATE_IDLE_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Reset token counter when the user clears chat history (history shrinks).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== CHAT_HISTORY_KEY) return;
      const next = historyLength();
      if (next < historyLenRef.current) {
        setTokenEstimate(0);
        tokenRateSamplesRef.current = [];
        setTokenRatePerSec(0);
      }
      historyLenRef.current = next;
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Mirror the voice hook's streamed response into the orb footer.
  useEffect(() => {
    const r = voice.response;
    if (typeof r === 'string' && r.length > 0) {
      setSunnyLine(truncateTail(r));
    }
  }, [voice.response]);

  // Pick up the user's transcribed utterance from the voice pipeline.
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text === 'string' && text.trim().length > 0) {
        setUserLine(text.trim());
        // A fresh user turn clears the stale Sunny line.
        setSunnyLine('');
      }
    };
    window.addEventListener('sunny-voice-transcript', handler);
    return () => window.removeEventListener('sunny-voice-transcript', handler);
  }, []);

  // ── Fix 1 + Fix 4: unified rAF loop (canvas particles + SVG ring rotation)
  // The --cyan CSS var and any other per-frame CSS-var reads are cached once
  // per effect run (i.e. when state/intensity/reducedMotion change), not on
  // every frame. Both the canvas draw and the SVG ring spin share a single
  // requestAnimationFrame handle so the scheduler is called once per paint.
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true }); if (!ctx) return;

    const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));

    const particles = Array.from({ length: 72 }, () => ({
      a: Math.random() * Math.PI * 2,
      r: 70 + Math.random() * 130,
      s: 0.2 + Math.random() * 0.8,
      size: 0.5 + Math.random() * 1.75,
      twinklePhase: Math.random() * Math.PI * 2,
      twinkleHz: 0.4 + Math.random() * 1.2,
    }));

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) {
      (ctx as CanvasRenderingContext2D & { imageSmoothingQuality: string }).imageSmoothingQuality = 'high';
    }

    // Fix 1: cache --cyan (and any other CSS var) once per effect, not per frame.
    const hex2rgb = (h: string) => {
      const v = h.replace('#', '').trim();
      if (v.length !== 6) return [57, 229, 255] as const;
      return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)] as const;
    };
    const cachedCyanHex = getComputedStyle(document.body).getPropertyValue('--cyan').trim() || '#39e5ff';
    const [r1, g1, b1] = hex2rgb(cachedCyanHex);

    let T = 0;
    let orbGlow = 0;
    let raf = 0;
    let pulseAcc = 0;
    let lastNow = performance.now();

    // Fix 4: SVG ring state kept here, updated in the same rAF tick.
    const degPerSecA = 0.22 * 60;
    const degPerSecB = -0.22 * 0.6 * 60;
    let angleA = 0;
    let angleB = 0;

    const TWO_PI = Math.PI * 2;
    /** Finer tessellation = smoother organic rings (device-aware step). */
    const ringStep = () => Math.max(0.022, 0.038 / dpr);

    const draw = (now: number) => {
      const rawDt = (now - lastNow) / 1000;
      const dt = Math.min(0.048, Math.max(0, rawDt));
      lastNow = now;
      T += dt;

      // Fix 4: advance ring angles in the same frame budget.
      angleA += degPerSecA * dt;
      angleB += degPerSecB * dt;
      if (ringARef.current) ringARef.current.style.transform = `rotate(${angleA}deg)`;
      if (ringBRef.current) ringBRef.current.style.transform = `rotate(${angleB}deg)`;

      pulseAcc += dt;
      if (pulseAcc >= 0.22) {
        pulseAcc = 0;
        if (state === 'listening' && Math.random() < 0.35) {
          orbGlow = Math.max(orbGlow, 0.55 + Math.random() * 0.38);
        }
        if (state === 'speaking') {
          orbGlow = Math.max(orbGlow, 0.75 + Math.random() * 0.28);
        }
        if (state === 'thinking') {
          orbGlow = Math.max(orbGlow, 0.22 + Math.random() * 0.12);
        }
      }

      const glowDecay = Math.pow(0.78, dt * 60);
      orbGlow *= glowDecay;

      const S = STATES[state];
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = (H / 2) * 0.92;
      const scale = Math.min(W, H) / 560;
      const baseR = 90 * scale * intensity;

      // Fix 1: use cached r1/g1/b1 — no getComputedStyle per frame.
      const glowR = baseR * 3.3 * (1 + orbGlow * 0.28);
      const halo = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, glowR);
      const a0 = 0.35 * (S.energy + orbGlow * 0.38);
      halo.addColorStop(0, `rgba(${r1},${g1},${b1},${a0})`);
      halo.addColorStop(0.35, `rgba(${r1},${g1},${b1},${a0 * 0.45})`);
      halo.addColorStop(0.72, `rgba(${r1},${g1},${b1},${a0 * 0.12})`);
      halo.addColorStop(1, `rgba(${r1},${g1},${b1},0)`);
      ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1, 1.35 * dpr);
      const step = ringStep();
      for (let layer = 0; layer < 4; layer++) {
        ctx.beginPath();
        const rr = baseR * (1.05 + layer * 0.12) * (1 + orbGlow * 0.14);
        const amp = (3 + layer * 4) * S.chaos;
        const fr = 4 + layer * 2;
        const t1 = T * S.speed * (1 + layer * 0.28);
        const t2 = T * S.speed * 0.68;
        let first = true;
        for (let a = 0; a <= TWO_PI + step * 0.5; a += step) {
          const n = Math.sin(a * fr + t1) * amp + Math.cos(a * (fr + 1.3) + t2) * amp * 0.52;
          const x = cx + Math.cos(a) * (rr + n);
          const y = cy + Math.sin(a) * (rr + n);
          if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(${r1},${g1},${b1},${0.34 - layer * 0.065 + orbGlow * 0.18})`;
        ctx.stroke();
      }

      const bodyR = baseR * (1 + orbGlow * 0.07);
      const grad = ctx.createRadialGradient(cx - bodyR * 0.25, cy - bodyR * 0.25, bodyR * 0.1, cx, cy, bodyR);
      grad.addColorStop(0, 'rgba(255,255,255,.96)');
      grad.addColorStop(0.22, `rgba(${r1},${g1},${b1},.92)`);
      grad.addColorStop(0.55, `rgba(${r1},${g1},${b1},.45)`);
      grad.addColorStop(0.82, `rgba(${r1},${g1},${b1},.12)`);
      grad.addColorStop(1, `rgba(${r1},${g1},${b1},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, bodyR * 1.6, 0, TWO_PI); ctx.fill();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const innerStep = Math.max(0.02, 0.034 / dpr);
      ctx.lineWidth = Math.max(0.85, 0.95 * dpr);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        const rr = baseR * 0.7;
        const off = T * S.speed * (0.5 + i * 0.3) + i * Math.PI * 0.66;
        let first = true;
        for (let a = 0; a <= TWO_PI + innerStep * 0.5; a += innerStep) {
          const rad = rr + Math.sin(a * 3 + off) * rr * 0.2 * S.chaos + Math.cos(a * 5 - off * 1.3) * rr * 0.15;
          const x = cx + Math.cos(a + off * 0.2) * rad;
          const y = cy + Math.sin(a + off * 0.2) * rad * 0.85;
          if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(255,255,255,${0.22 + orbGlow * 0.28})`;
        ctx.stroke();
      }
      ctx.restore();

      const coreR = baseR * 0.35 * (1 + orbGlow * 0.22);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      cg.addColorStop(0, 'rgba(255,255,255,1)');
      cg.addColorStop(0.18, 'rgba(255,255,255,0.92)');
      cg.addColorStop(0.45, `rgba(255,255,255,${0.68 + orbGlow * 0.28})`);
      cg.addColorStop(1, `rgba(${r1},${g1},${b1},0)`);
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(cx, cy, coreR * 2.5, 0, TWO_PI); ctx.fill();

      const pR = dpr;
      for (const p of particles) {
        p.a += dt * (0.28 * S.speed * p.s);
        const breathe = 1 + Math.sin(T * 0.9 * p.s + p.a * 2) * 0.045;
        const rr = (p.r * scale) * breathe;
        const x = cx + Math.cos(p.a) * rr;
        const y = cy + Math.sin(p.a) * rr * 0.9;
        const tw = 0.52 + 0.48 * Math.sin(T * p.twinkleHz * TWO_PI * 0.25 + p.twinklePhase);
        const alpha = (0.14 + tw * 0.38) * S.energy;
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.beginPath(); ctx.arc(x, y, p.size * pR, 0, TWO_PI); ctx.fill();
      }

      // Only loop when motion is allowed; reduced-motion gets a single static frame.
      if (!reducedMotion) raf = requestAnimationFrame(draw);
    };
    draw(performance.now());
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [state, intensity, reducedMotion]);

  const meta = useMemo(() => STATES[state], [state]);

  const neuralLabel = neuralStatus(state);
  const lambdaText = `Λ${lambdaFor(voice.state).toFixed(2)}`;
  const ctxK = Math.min(CTX_LIMIT_K, Math.floor(tokenEstimate / 1000));
  const tokenRateText = formatTokenRate(tokenRatePerSec);
  void latencyMs;

  const advance = () => {
    const seq: OrbState[] = ['listening', 'thinking', 'speaking', 'alert', 'idle'];
    setState(s => seq[(seq.indexOf(s) + 1) % seq.length]);
  };

  // Ring styling — amber breathing while the agent runs, timed flashes on
  // done/error. Sits under all other orb visuals (zIndex 0), never blocks
  // pointer events, so voice state remains the dominant visual.
  const agentRingStyle = useMemo<CSSProperties | null>(() => {
    if (agentFlash === 'green') {
      return {
        boxShadow: '0 0 60px 20px rgba(72, 255, 128, 0.55), inset 0 0 40px rgba(72, 255, 128, 0.35)',
        borderColor: 'rgba(72, 255, 128, 0.75)',
        opacity: 1,
        transition: 'opacity 300ms ease-out, box-shadow 300ms ease-out, border-color 300ms ease-out',
      };
    }
    if (agentFlash === 'red') {
      return {
        boxShadow: '0 0 70px 24px rgba(255, 72, 72, 0.6), inset 0 0 44px rgba(255, 72, 72, 0.4)',
        borderColor: 'rgba(255, 96, 96, 0.8)',
        opacity: 1,
        transition: 'opacity 400ms ease-out, box-shadow 400ms ease-out, border-color 400ms ease-out',
      };
    }
    if (agentStatus === 'running') {
      return {
        borderColor: 'rgba(255, 176, 64, 0.55)',
        ...(reducedMotion ? {} : { animation: 'sunnyAgentBreathe 1.6s ease-in-out infinite' }),
        opacity: 1,
      };
    }
    if (constAmberPulse) {
      // One-second amber audit pulse — distinct from the agent-running
      // amber breathe (different keyframe, slightly warmer tint) so when
      // both want to fire the constitution pulse lands cleanly on top.
      return {
        boxShadow: '0 0 44px 12px rgba(255, 184, 77, 0.42), inset 0 0 28px rgba(255, 184, 77, 0.22)',
        borderColor: 'rgba(255, 184, 77, 0.7)',
        ...(reducedMotion ? {} : { animation: 'sunnyConstAmberPulse 1s ease-out forwards' }),
        opacity: 1,
      };
    }
    return null;
  }, [agentFlash, agentStatus, constAmberPulse, reducedMotion]);

  return (
    <Panel id="p-orb" title="SUNNY CORE" right={meta.label} bodyStyle={{ padding: 0 }}>
      <div className="orb-wrap" onClick={advance} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!e.repeat) advance(); } }} role="button" tabIndex={0} aria-label={'SUNNY core — state: ' + meta.label + '. Press Enter or Space to cycle display state'}>
        {/* Offscreen live region so screen readers track SUNNY state changes */}
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{ position: 'absolute', left: -9999, top: -9999, width: 1, height: 1, overflow: 'hidden' }}
        >
          {'SUNNY ' + meta.label.toLowerCase()}
        </div>
        {/* fix #5: announce agent completion/error via color flash — screen readers
            only hear color changes if we pair them with a text announcement */}
        <div
          aria-live="assertive"
          aria-atomic="true"
          style={{ position: 'absolute', left: -9999, top: -9999, width: 1, height: 1, overflow: 'hidden' }}
        >
          {agentFlash === 'green' ? 'Agent completed' : agentFlash === 'red' ? 'Agent error' : ''}
        </div>
        {/* Fix 5: inline <style> removed — keyframes live in src/styles/sunny.css */}
        {agentRingStyle && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: '72%',
              height: '72%',
              transform: 'translate(-50%, -50%)',
              borderRadius: '50%',
              border: '2px solid transparent',
              pointerEvents: 'none',
              zIndex: 0,
              ...agentRingStyle,
            }}
          />
        )}
        <canvas ref={canvasRef} role="img" aria-label={"SUNNY orb — state: " + meta.label} />
        <div className="orb-hud">
          <svg viewBox="0 0 640 500" preserveAspectRatio="xMidYMid meet">
            <defs>
              <radialGradient id="hudGrad" cx="50%" cy="50%" r="50%">
                <stop offset="80%" stopColor="rgba(57,229,255,0)" />
                <stop offset="100%" stopColor="rgba(57,229,255,0.1)" />
              </radialGradient>
            </defs>
            <circle cx="320" cy="240" r="220" fill="url(#hudGrad)" />
            <g fill="none" stroke="currentColor" opacity={0.35} strokeDasharray="2 5">
              <circle cx="320" cy="240" r="215" />
            </g>
            <g fill="none" stroke="currentColor" opacity={0.28}>
              <circle cx="320" cy="240" r="186" />
            </g>
            <g ref={ringARef} style={{ transformOrigin: '320px 240px' }} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.8}>
              <path d="M320 30 A210 210 0 0 1 510 130" />
              <path d="M130 350 A210 210 0 0 0 210 430" />
              <path d="M430 430 A210 210 0 0 0 510 350" />
            </g>
            <g ref={ringBRef} style={{ transformOrigin: '320px 240px' }} fill="none" stroke="currentColor" strokeWidth={1} opacity={0.45}>
              <path d="M110 240 A210 210 0 0 1 160 110" strokeDasharray="4 3" />
              <path d="M530 240 A210 210 0 0 0 480 110" strokeDasharray="4 3" />
            </g>
            <g stroke="currentColor" opacity={0.55}>
              <line x1="320" y1="20" x2="320" y2="36" />
              <line x1="320" y1="444" x2="320" y2="460" />
              <line x1="96" y1="240" x2="112" y2="240" />
              <line x1="528" y1="240" x2="544" y2="240" />
            </g>
            <g fontFamily="JetBrains Mono" fontSize="10" fill="currentColor" opacity={0.8} fontWeight="600">
              <text x="24" y="60">{`NEURAL · ${neuralLabel}`}</text>
              <text x="24" y="74" opacity="0.55">{`0x${sessionHex} · ${lambdaText}`}</text>
              <text x="616" y="60" textAnchor="end">{`CTX · ${ctxK}/${CTX_LIMIT_K}`}</text>
              <text x="616" y="74" textAnchor="end" opacity="0.55">{`TOK/S ${tokenRateText}`}</text>
            </g>
            <g stroke="currentColor" opacity={0.22} strokeDasharray="2 4">
              <line x1="320" y1="240" x2="120" y2="60" />
              <line x1="320" y1="240" x2="520" y2="60" />
              <line x1="320" y1="240" x2="120" y2="420" />
              <line x1="320" y1="240" x2="520" y2="420" />
            </g>
          </svg>
        </div>
        <div className="orb-label">SUNNY</div>
        <div className="orb-sub">{meta.sub}</div>

        <div className="orb-foot">
          <div className="orb-state">
            <span className="pulse" />
            <span>{meta.label}</span>
            <div className="orb-voice-kbd">
              <VoiceButton api={voice} variant="footer" />
              <span className="kbd">HOLD <b>SPACE</b> TO TALK</span>
            </div>
          </div>
          <div className="orb-tx" aria-live="off">
            {voice.state === 'recording' ? (
              <em>listening…</em>
            ) : voice.state === 'transcribing' ? (
              <em>transcribing…</em>
            ) : voice.state === 'thinking' ? (
              (() => {
                const status = agentStatus === 'running' ? stepToStatus(lastStep) : null;
                if (status) {
                  const color = STEP_COLORS[status.kind];
                  return (
                    <em
                      key={status.text}
                      className="orb-tx-step"
                      style={{ color, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <span
                        aria-hidden
                        style={{
                          display: 'inline-block',
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: color,
                          boxShadow: `0 0 6px ${color}`,
                          ...(reducedMotion ? {} : { animation: 'sunnyStepDotPulse 1.1s ease-in-out infinite' }),
                          flex: '0 0 auto',
                        }}
                      />
                      <span>{status.text}</span>
                    </em>
                  );
                }
                return <em key="thinking-fallback" className="orb-tx-step">SUNNY is thinking…</em>;
              })()
            ) : sunnyLine ? (
              <span><b style={{ color: 'var(--cyan)' }}>SUNNY: </b>{sunnyLine}</span>
            ) : userLine ? (
              <span><b style={{ color: 'var(--amber)' }}>YOU: </b>{userLine}</span>
            ) : (
              <em>ready — hold space to talk</em>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
