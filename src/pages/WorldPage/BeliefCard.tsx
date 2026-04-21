/**
 * Top-of-page belief card — Sunny's one-sentence answer to "what do you
 * think I'm doing right now?" The card is the highest-trust surface on
 * the page: if this is wrong the whole downstream agent context is wrong.
 *
 * Upgraded with:
 *  - Pulsing glow border that syncs with data freshness (cyan → amber → red)
 *  - Per-activity confidence sparkline with filled area gradient
 *  - Smooth sentence transition via CSS fade
 *  - Enhanced visual hierarchy with larger activity sentence
 */

import { useEffect, useRef, useState } from 'react';
import { Chip, Sparkline } from '../_shared';
import { ACTIVITY_TONE, type Activity, type WorldState } from './types';

const SENTENCE_TITLE_MAX = 80;

function humanDuration(secs: number): string {
  if (secs < 0) return '0s';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function shortTitle(raw: string | undefined): string | null {
  const t = raw?.trim();
  if (!t) return null;
  return t.length > SENTENCE_TITLE_MAX ? `${t.slice(0, SENTENCE_TITLE_MAX - 1)}…` : t;
}

function sentenceFor(w: WorldState): string {
  const app = w.focus?.app_name ?? 'nothing';
  const title = shortTitle(w.focus?.window_title);
  switch (w.activity) {
    case 'coding':        return `You're coding in ${app}${title ? ` — "${title}"` : ''}.`;
    case 'writing':       return `You're writing${title ? ` — "${title}"` : ` in ${app}`}.`;
    case 'meeting':       return `You're in a meeting (${app})${title ? ` — "${title}"` : ''}.`;
    case 'browsing':      return `You're browsing ${app}${title ? ` — "${title}"` : ''}.`;
    case 'communicating': return `You're in ${app} handling messages.`;
    case 'media':         return `You're listening / watching with ${app}.`;
    case 'terminal':      return `You're in the terminal${title ? ` — "${title}"` : ''}.`;
    case 'designing':     return `You're designing in ${app}.`;
    case 'idle':          return 'No activity detected — you may be away.';
    default:              return "I don't have a read on your current activity.";
  }
}

function useStaleSeconds(timestampMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);
  return Math.max(0, Math.floor((now - timestampMs) / 1000));
}

function freshnessTone(ageSecs: number): 'green' | 'amber' | 'red' {
  if (ageSecs < 20) return 'green';
  if (ageSecs < 60) return 'amber';
  return 'red';
}

// ---------------------------------------------------------------------------
// Client-side confidence history ring
// ---------------------------------------------------------------------------

type HistoryPoint = { activity: Activity; confidence: number; ts: number };

const MAX_HISTORY = 24;

function deriveConfidence(w: WorldState): number {
  if (w.activity === 'idle' || w.activity === 'unknown') return 0.3;
  if (!w.focus) return 0.45;
  const dur = w.focused_duration_secs;
  if (dur < 5) return 0.55;
  if (dur < 30) return 0.75;
  return 0.92;
}

let _history: HistoryPoint[] = [];

function pushHistory(w: WorldState): HistoryPoint[] {
  const point: HistoryPoint = {
    activity: w.activity,
    confidence: deriveConfidence(w),
    ts: w.timestamp_ms,
  };
  if (_history.length > 0 && _history[_history.length - 1].ts === point.ts) {
    return _history;
  }
  const next = [..._history, point];
  if (next.length > MAX_HISTORY) {
    _history = next.slice(next.length - MAX_HISTORY);
  } else {
    _history = next;
  }
  return _history;
}

// ---------------------------------------------------------------------------
// FreshnessBar
// ---------------------------------------------------------------------------

function FreshnessBar({ ageSecs }: { ageSecs: number }) {
  const pct = Math.max(0, 100 - (ageSecs / 90) * 100);
  const tone = freshnessTone(ageSecs);
  return (
    <div
      title={`World snapshot is ${ageSecs}s old. Updater cadence: 15s.`}
      style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: 3,
        background: 'rgba(57, 229, 255, 0.06)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct}%`,
          background: `var(--${tone})`,
          boxShadow: `0 0 6px var(--${tone})`,
          transition: 'width 900ms linear, background 400ms ease',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export function BeliefCard({ world, revision }: { world: WorldState; revision: number }) {
  const tone = ACTIVITY_TONE[world.activity];
  const sentence = sentenceFor(world);
  const ageSecs = useStaleSeconds(world.timestamp_ms);
  const freshTone = freshnessTone(ageSecs);
  const freshLabel =
    ageSecs < 5 ? 'live' :
    ageSecs < 60 ? `${ageSecs}s ago` :
    `${Math.floor(ageSecs / 60)}m ago`;

  // Push to local history ring.
  const prevRevRef = useRef<number | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>(() => _history);

  if (prevRevRef.current !== revision) {
    prevRevRef.current = revision;
    const next = pushHistory(world);
    if (next !== _history || history.length !== next.length) {
      setHistory(next);
    }
  }

  // Confidence values for sparkline
  const confidenceValues = history.map(p => p.confidence * 100);
  const latestConfidence = history.length > 0
    ? Math.round(history[history.length - 1].confidence * 100)
    : 0;

  // Glow intensity from freshness
  const glowOpacity = ageSecs < 10 ? 0.4 : ageSecs < 30 ? 0.2 : ageSecs < 60 ? 0.1 : 0.04;

  return (
    <div
      aria-label="Current belief"
      aria-live="polite"
      style={{
        position: 'relative',
        border: `1px solid var(--${freshTone})44`,
        borderLeft: `3px solid var(--${tone})`,
        background: `linear-gradient(135deg, var(--${tone})11 0%, transparent 60%)`,
        padding: '18px 22px 24px',
        display: 'flex', flexDirection: 'column', gap: 10,
        overflow: 'hidden',
        boxShadow: `
          inset 0 0 30px var(--${tone})08,
          0 0 ${Math.round(20 * glowOpacity)}px var(--${freshTone})${Math.round(glowOpacity * 255).toString(16).padStart(2, '0')}
        `,
        transition: 'box-shadow 800ms ease, border-color 400ms ease',
      }}>
      {/* Top row: chips + freshness */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Chip tone={tone}>{world.activity}</Chip>
        {world.focus?.app_name && (
          <Chip tone="dim">{world.focus.app_name}</Chip>
        )}
        {world.focused_duration_secs > 0 && (
          <Chip tone="dim">{humanDuration(world.focused_duration_secs)} focused</Chip>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Confidence sparkline — filled area variant */}
          {confidenceValues.length >= 2 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkline values={confidenceValues} width={100} height={26} tone={tone as 'cyan' | 'amber' | 'green' | 'violet' | 'red' | 'gold'} filled />
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
              }}>
                {latestConfidence}%
              </span>
            </div>
          )}
          <Chip tone={freshTone}>
            <span
              aria-hidden
              style={{
                width: 6, height: 6, borderRadius: '50%',
                background: `var(--${freshTone})`,
                boxShadow: `0 0 6px var(--${freshTone})`,
                marginRight: 4,
                animation: ageSecs < 10 ? 'pulseDot 2s ease-in-out infinite' : undefined,
              }}
            />
            {freshLabel}
          </Chip>
          <span
            title="world state revision"
            style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
            }}
          >rev #{revision}</span>
        </div>
      </div>

      {/* Main sentence — larger and more prominent */}
      <div style={{
        fontFamily: 'var(--label)', fontSize: 18, fontWeight: 600,
        color: 'var(--ink)', lineHeight: 1.4,
        transition: 'opacity 300ms ease',
      }}>
        {sentence}
      </div>

      {/* Window title subtitle */}
      {world.focus?.window_title && (
        <div
          title={world.focus.window_title}
          style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            paddingTop: 2,
            borderTop: '1px solid var(--line-soft)',
          }}>
          {world.focus.window_title}
        </div>
      )}
      <FreshnessBar ageSecs={ageSecs} />
    </div>
  );
}
