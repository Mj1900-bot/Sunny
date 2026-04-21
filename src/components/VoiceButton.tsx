import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { VoiceState, VoiceChatApi } from '../hooks/useVoiceChat';
import { AudioMeter } from './AudioMeter';
import { listen } from '../lib/tauri';

type Props = {
  onStateChange?: (state: VoiceState) => void;
  /** REQUIRED. Parent must own the useVoiceChat hook and pass it down.
   *  Previous code optionally called useVoiceChat() here when `api` was
   *  absent, but the only caller (OrbCore) always passes it, and the
   *  fallback hook call caused a double-mount race: both OrbCore and
   *  VoiceButton would subscribe to `sunny-ptt-start` and fire
   *  startRecording() twice per keypress (log had paired turn IDs like
   *  m19dgg / mr8egg firing within a millisecond). Making this required
   *  statically prevents the duplicate. */
  api: VoiceChatApi;
  /** Sits in the orb footer above the key hint; default floats over the orb */
  variant?: 'float' | 'footer';
};

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
         aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={2} strokeLinecap="round"
         aria-hidden="true"
         style={{ animation: 'voiceBtnSpin 0.9s linear infinite' }}>
      <path d="M21 12a9 9 0 1 1-6.2-8.55" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
         aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function WaveformIcon() {
  return (
    <svg width="22" height="18" viewBox="0 0 24 18" fill="none"
         stroke="currentColor" strokeWidth={2} strokeLinecap="round"
         aria-hidden="true">
      <line x1="3" y1="9" x2="3" y2="9">
        <animate attributeName="y1" values="6;2;6" dur="0.9s" repeatCount="indefinite" />
        <animate attributeName="y2" values="12;16;12" dur="0.9s" repeatCount="indefinite" />
      </line>
      <line x1="8" y1="4" x2="8" y2="14">
        <animate attributeName="y1" values="4;8;4" dur="0.7s" repeatCount="indefinite" />
        <animate attributeName="y2" values="14;10;14" dur="0.7s" repeatCount="indefinite" />
      </line>
      <line x1="13" y1="2" x2="13" y2="16">
        <animate attributeName="y1" values="2;7;2" dur="0.8s" repeatCount="indefinite" />
        <animate attributeName="y2" values="16;11;16" dur="0.8s" repeatCount="indefinite" />
      </line>
      <line x1="18" y1="5" x2="18" y2="13">
        <animate attributeName="y1" values="5;1;5" dur="0.65s" repeatCount="indefinite" />
        <animate attributeName="y2" values="13;17;13" dur="0.65s" repeatCount="indefinite" />
      </line>
      <line x1="23" y1="8" x2="23" y2="10">
        <animate attributeName="y1" values="8;3;8" dur="0.85s" repeatCount="indefinite" />
        <animate attributeName="y2" values="10;15;10" dur="0.85s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

function InfinityIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 12" fill="none"
         stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
         aria-hidden="true">
      <path d="M6 6c0-2 1.5-4 4-4s4 2 6 4 3.5 4 6 4 4-2 4-4-1.5-4-4-4-4 2-6 4-3.5 4-6 4-4-2-4-4Z" />
    </svg>
  );
}

function formatSeconds(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

export function VoiceButton({ onStateChange, api, variant = 'float' }: Props) {
  // `api` is required — see the Props comment above. Single hook owner
  // lives in the parent (OrbCore → useVoiceChat()), passed down here.
  const { state, continuous, toggleContinuous, pressTalk, stop, error } = api;

  const [elapsed, setElapsed] = useState<number>(0);
  const startedAtRef = useRef<number | null>(null);

  // Mic heartbeat. Listens for `sunny://voice.level` events emitted by the
  // cpal capture thread; if we've seen one in the last 2 s the mic is
  // actively producing audio. Silent mic (wrong device, muted, TCC drop)
  // = gray dot and a hint that the problem isn't in the software.
  const [micAlive, setMicAlive] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let lastAt = 0;
    void listen<number>('sunny://voice.level', () => {
      if (cancelled) return;
      lastAt = Date.now();
      if (!micAlive) setMicAlive(true);
    }).then(stop => {
      if (cancelled) { stop(); return; }
      unlisten = stop;
    });
    const poll = window.setInterval(() => {
      if (lastAt > 0 && Date.now() - lastAt > 2000) {
        setMicAlive(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      window.clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (onStateChange) onStateChange(state);
  }, [state, onStateChange]);

  useEffect(() => {
    if (state !== 'recording') {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      if (startedAtRef.current === null) return;
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [state]);

  const handleTalkClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    void pressTalk();
  };

  const handleContinuousClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    toggleContinuous();
  };

  const handleStopClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    stop();
  };

  // Esc as a voice-only stop: kills TTS / aborts a thinking turn. Scoped
  // to speaking+thinking+transcribing so it doesn't fight with the
  // page-level Esc that returns to Overview from module pages.
  useEffect(() => {
    if (state !== 'speaking' && state !== 'thinking' && state !== 'transcribing') {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stop();
      }
    };
    // capture phase so we beat the page-level Esc handlers.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, stop]);

  const handleMouseDown = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
  };

  const isRecording = state === 'recording';
  const isThinking = state === 'thinking' || state === 'transcribing';
  const isSpeaking = state === 'speaking';
  const canStop = isSpeaking || isThinking;

  // We deliberately avoid the word "recording" — it implies capture-for-
  // later. SUNNY is a live conversation: you're talking, she listens until
  // you stop, then she replies. "Listening / Tap to send" frames the state
  // correctly for a voice assistant rather than a dictaphone.
  const label = isRecording ? 'Listening — tap to send'
    : isThinking ? 'Thinking'
    : isSpeaking ? 'Speaking — tap to stop'
    : 'Tap to talk';

  const baseButtonStyle: React.CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    background: 'rgba(2, 6, 10, 0.88)',
    color: 'var(--cyan)',
    border: '1px solid var(--line)',
    boxShadow: isRecording
      ? '0 0 16px rgba(255, 82, 82, 0.8), inset 0 0 8px rgba(255, 82, 82, 0.35)'
      : isSpeaking
      ? '0 0 14px rgba(255, 176, 0, 0.55)'
      : '0 0 10px rgba(57, 229, 255, 0.28)',
    transition: 'box-shadow 120ms linear, border-color 120ms linear',
    padding: 0,
    fontFamily: 'var(--display)',
    animation: isRecording ? 'voiceBtnPulse 1.2s ease-in-out infinite' : undefined,
    borderColor: isRecording ? 'rgba(255, 82, 82, 0.85)' : isSpeaking ? 'var(--amber, #ffb000)' : 'var(--line)',
  };

  const continuousButtonStyle: React.CSSProperties = {
    width: 30,
    height: 30,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    background: continuous ? 'rgba(57, 229, 255, 0.18)' : 'rgba(2, 6, 10, 0.7)',
    color: continuous ? 'var(--cyan)' : 'var(--ink-2)',
    border: `1px solid ${continuous ? 'var(--cyan)' : 'var(--line)'}`,
    padding: 0,
    boxShadow: continuous ? '0 0 8px rgba(57, 229, 255, 0.45)' : 'none',
    transition: 'box-shadow 120ms linear, background 120ms linear, color 120ms linear',
  };

  // Stop button: red/amber styling so it reads as an escape hatch, not a
  // variant of the mic. Only rendered when there's something to stop.
  const stopButtonStyle: React.CSSProperties = {
    width: 30,
    height: 30,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    background: 'rgba(255, 82, 82, 0.15)',
    color: '#ff6b6b',
    border: '1px solid rgba(255, 82, 82, 0.7)',
    padding: 0,
    boxShadow: '0 0 10px rgba(255, 82, 82, 0.45)',
    transition: 'box-shadow 120ms linear, background 120ms linear',
  };

  const wrapStyle: React.CSSProperties = variant === 'footer'
    ? {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        zIndex: 5,
        pointerEvents: 'auto',
      }
    : {
        position: 'absolute',
        right: 18,
        bottom: 190,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        zIndex: 5,
        pointerEvents: 'auto',
      };

  const counterStyle: React.CSSProperties = {
    position: 'absolute',
    top: -14,
    left: '50%',
    transform: 'translateX(-50%)',
    fontFamily: 'var(--mono)',
    fontSize: 10,
    color: '#ff5252',
    letterSpacing: '0.15em',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    textShadow: '0 0 6px rgba(255, 82, 82, 0.6)',
  };

  const errorStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 50,
    right: 0,
    maxWidth: 200,
    fontFamily: 'var(--mono)',
    fontSize: 9.5,
    color: 'var(--amber)',
    background: 'rgba(2, 6, 10, 0.88)',
    border: '1px solid rgba(255, 179, 71, 0.35)',
    padding: '4px 7px',
    letterSpacing: '0.04em',
    lineHeight: 1.3,
    opacity: 0.85,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  // Abbreviate the error — no one wants a paragraph hovering over the orb.
  // Mapping reflects the cpal-based capture path (sox is gone) and
  // disambiguates mic / transcriber / chat / tts failures so the user
  // knows which subsystem to poke at.
  const shortError = (() => {
    if (!error) return '';
    const e = error.toLowerCase();
    if (e.includes('already recording')) return '';
    if (e.includes('default input device') || e.includes('tcc') || e.includes('permission')) {
      return 'mic blocked — System Settings › Privacy › Microphone';
    }
    if (e.includes('no transcriber') || e.includes('whisper-cli') || e.includes('transcrib')) {
      return 'no transcriber — brew install whisper-cpp';
    }
    if (e.includes('record')) return 'mic error — check input device';
    if (e.includes('chat'))   return 'chat failed — check openclaw / Ollama';
    if (e.includes('speech') || e.includes('koko')) return 'tts error — check koko daemon';
    return error.slice(0, 60);
  })();

  return (
    <div style={wrapStyle} onMouseDown={handleMouseDown} onClick={(e) => e.stopPropagation()}>
      <style>{`
        @keyframes voiceBtnPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }
        @keyframes voiceBtnSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      {shortError && <div style={errorStyle} title={error ?? ''}>{shortError}</div>}

      <div
        aria-hidden
        title={micAlive ? 'mic live' : 'mic silent — check input device'}
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: micAlive ? 'rgba(80, 220, 100, 0.95)' : 'rgba(120, 120, 120, 0.45)',
          boxShadow: micAlive ? '0 0 6px rgba(80, 220, 100, 0.7)' : 'none',
          transition: 'background 200ms linear, box-shadow 200ms linear',
        }}
      />

      {canStop && (
        <button
          type="button"
          style={stopButtonStyle}
          onClick={handleStopClick}
          onMouseDown={handleMouseDown}
          aria-label="Stop speaking"
          title={isSpeaking ? 'Stop speaking (Esc)' : 'Cancel (Esc)'}
        >
          <StopIcon />
        </button>
      )}

      <button
        type="button"
        style={continuousButtonStyle}
        onClick={handleContinuousClick}
        onMouseDown={handleMouseDown}
        aria-pressed={continuous}
        aria-label={continuous ? 'Disable continuous mode' : 'Enable continuous mode'}
        title={continuous ? 'Continuous mode ON' : 'Continuous mode OFF'}
      >
        <InfinityIcon />
      </button>

      <div style={{ position: 'relative' }}>
        {isRecording && <div style={counterStyle}>LIVE · {formatSeconds(elapsed)}</div>}
        {isRecording && (
          <div
            style={{
              position: 'absolute',
              bottom: -22,
              left: '50%',
              transform: 'translateX(-50%)',
              pointerEvents: 'none',
            }}
          >
            <AudioMeter active={isRecording} />
          </div>
        )}
        <button
          type="button"
          style={baseButtonStyle}
          onClick={handleTalkClick}
          onMouseDown={handleMouseDown}
          aria-label={label}
          title={label}
          data-voice-state={state}
        >
          {isThinking ? <SpinnerIcon />
            : isSpeaking ? <WaveformIcon />
            : <MicIcon />}
        </button>
      </div>
      {variant === 'footer' && (
        <div
          style={{
            position: 'absolute',
            bottom: -18,
            left: '50%',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--mono)',
            fontSize: 9,
            color: 'var(--ink-dim)',
            letterSpacing: '0.1em',
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        >
          <kbd style={{ fontFamily: 'inherit', fontSize: 9 }}>⌘K</kbd> to type
        </div>
      )}
    </div>
  );
}
