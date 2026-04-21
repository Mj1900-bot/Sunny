import { useEffect, useRef, useState } from 'react';
import { Chip, ProgressRing, Toolbar, ToolbarButton } from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { focusedSecs, isPaused, type SessionRecord } from './api';

type Props = {
  active: SessionRecord | null;
  onStart: (goal: string, targetSecs?: number) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
};

type Preset = { id: string; label: string; mins: number; tone: 'green' | 'cyan' | 'violet' | 'amber'; desc: string };

const PRESETS: ReadonlyArray<Preset> = [
  { id: 'sprint', label: 'SPRINT', mins: 25, tone: 'amber',  desc: '25m · pomodoro' },
  { id: 'flow',   label: 'FLOW',   mins: 50, tone: 'cyan',   desc: '50m · one task' },
  { id: 'deep',   label: 'DEEP',   mins: 90, tone: 'violet', desc: '90m · hardest' },
  { id: 'open',   label: 'OPEN',   mins: 0,  tone: 'green',  desc: 'no countdown' },
];

/** Format seconds as M:SS or H:MM:SS once over an hour. */
function fmt(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function SessionTimer({ active, onStart, onPause, onResume, onStop }: Props) {
  const [goal, setGoal] = useState('');
  const [presetId, setPresetId] = useState<string>('flow');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Tick once per second while the page is visible; halt when hidden to save work.
  // The timer value itself is derived from wall-clock so nothing drifts.
  useEffect(() => {
    let handle: number | null = null;
    const start = () => {
      if (handle != null) return;
      handle = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    };
    const stop = () => {
      if (handle == null) return;
      clearInterval(handle);
      handle = null;
    };
    const onVis = () => {
      if (document.hidden) stop();
      else { setNow(Math.floor(Date.now() / 1000)); start(); }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const paused = active != null && isPaused(active);
  const elapsed = active ? focusedSecs(active, now) : 0;
  const target = active?.targetSecs && active.targetSecs > 0 ? active.targetSecs : null;
  const progress = target ? Math.min(1, elapsed / target) : null;
  const remaining = target ? Math.max(0, target - elapsed) : null;
  const overshot = target != null && elapsed > target;

  // Keyboard shortcuts: space = pause/resume, esc = stop. Only fire when a
  // session is active AND focus is not trapped in the input field.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const inForm = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);
      if (inForm) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (paused) onResume(); else onPause();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onStop();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, paused, onPause, onResume, onStop]);

  const tone: 'green' | 'amber' | 'cyan' = paused ? 'amber' : active ? 'green' : 'cyan';
  const borderColor = tone === 'green' ? 'var(--green)' : tone === 'amber' ? 'var(--amber)' : 'var(--cyan)';
  const gradient = paused
    ? 'linear-gradient(90deg, rgba(255, 193, 94, 0.10), transparent)'
    : active
      ? 'linear-gradient(90deg, rgba(125, 255, 154, 0.10), transparent)'
      : 'rgba(6, 14, 22, 0.55)';
  const label = paused ? '❙❙ PAUSED' : active ? '● FOCUSING' : 'READY';
  const mainColor = paused ? 'var(--amber)' : active ? 'var(--green)' : 'var(--cyan)';

  const selectedPreset = PRESETS.find(p => p.id === presetId) ?? PRESETS[1];

  return (
    <div
      role="region"
      aria-label="Focus session timer"
      style={{
        border: '1px solid var(--line-soft)',
        borderLeft: `3px solid ${borderColor}`,
        background: gradient,
        padding: '18px 22px',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip tone={tone}>{label}</Chip>
        {active && <Chip tone="dim">goal · {active.goal || 'unset'}</Chip>}
        {active && target != null && (
          <Chip tone={overshot ? 'amber' : 'cyan'}>
            {overshot ? `+${fmt(elapsed - target)} overshot` : `${fmt(remaining ?? 0)} left`}
          </Chip>
        )}
        {active && <Chip tone="dim">space·pause · esc·end</Chip>}
      </div>

      {/* Timer display — radial ring when a target is set, otherwise plain number */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        {active && progress != null ? (
          <ProgressRing
            progress={progress}
            size={140}
            stroke={4}
            tone={overshot ? 'amber' : paused ? 'amber' : 'green'}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <div
                aria-live="polite"
                style={{
                  fontFamily: 'var(--display)', fontSize: 26, fontWeight: 800,
                  letterSpacing: '0.04em', color: mainColor,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {fmt(elapsed)}
              </div>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
                letterSpacing: '0.18em',
              }}>
                {Math.round((progress) * 100)}%
              </div>
            </div>
          </ProgressRing>
        ) : (
          <div
            aria-live="polite"
            style={{
              fontFamily: 'var(--display)', fontSize: 44, fontWeight: 800,
              letterSpacing: '0.06em', color: mainColor,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {fmt(elapsed)}
          </div>
        )}

        {active && active.goal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
            <div style={{
              fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
              color: 'var(--ink-dim)', fontWeight: 700,
            }}>GOAL</div>
            <div style={{
              fontFamily: 'var(--label)', fontSize: 16, color: 'var(--ink)',
              lineHeight: 1.3, fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{active.goal}</div>
            {target != null && (
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                letterSpacing: '0.1em',
              }}>
                target · {Math.round(target / 60)}m
              </div>
            )}
          </div>
        )}
      </div>

      {active ? (
        <Toolbar>
          {paused ? (
            <ToolbarButton tone="green" onClick={onResume}>▶ RESUME</ToolbarButton>
          ) : (
            <ToolbarButton tone="amber" onClick={onPause}>❙❙ PAUSE</ToolbarButton>
          )}
          <ToolbarButton tone="red" onClick={onStop}>■ END SESSION</ToolbarButton>
          <ToolbarButton
            tone="violet"
            onClick={() => askSunny(`I'm ${elapsed > 600 ? 'deep' : 'getting'} into a focus session on "${active.goal}". Check in with me — ask one clarifying question to sharpen the next 15 minutes.`, 'focus')}
          >⬡ CHECK IN</ToolbarButton>
        </Toolbar>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Preset row */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map(p => {
              const activePreset = p.id === presetId;
              const color = `var(--${p.tone})`;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPresetId(p.id)}
                  aria-pressed={activePreset}
                  title={p.desc}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    padding: '6px 10px',
                    display: 'inline-flex', flexDirection: 'column', gap: 1,
                    fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.2em',
                    fontWeight: 700,
                    color: activePreset ? '#fff' : color,
                    border: `1px solid ${color}`,
                    background: activePreset ? `${color}33` : 'rgba(0, 0, 0, 0.3)',
                    transition: 'background 140ms ease',
                  }}
                >
                  <span>{p.label}</span>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 8.5, color: activePreset ? '#fff' : color,
                    opacity: 0.8, letterSpacing: '0.08em', fontWeight: 500,
                  }}>{p.mins > 0 ? `${p.mins}m` : '∞'}</span>
                </button>
              );
            })}
          </div>

          <form
            style={{ display: 'flex', gap: 6 }}
            onSubmit={e => {
              e.preventDefault();
              const g = goal.trim();
              if (g) {
                onStart(g, selectedPreset.mins > 0 ? selectedPreset.mins * 60 : undefined);
                setGoal('');
              }
            }}
          >
            <input
              ref={inputRef}
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder="what are you focusing on?"
              aria-label="Focus session goal"
              autoFocus
              style={{
                all: 'unset', flex: 1,
                padding: '8px 12px',
                fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink)',
                border: '1px solid var(--line-soft)',
                background: 'rgba(0, 0, 0, 0.3)',
              }}
            />
            <ToolbarButton
              tone="green"
              onClick={() => {
                const g = goal.trim();
                if (g) {
                  onStart(g, selectedPreset.mins > 0 ? selectedPreset.mins * 60 : undefined);
                  setGoal('');
                }
              }}
              disabled={!goal.trim()}
            >
              ▶ START {selectedPreset.label}
            </ToolbarButton>
          </form>
        </div>
      )}
    </div>
  );
}
