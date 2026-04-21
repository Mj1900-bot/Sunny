import { useEffect, useRef, useState } from 'react';

type Props = {
  active: boolean;
};

const BAR_COUNT = 12;
const METER_WIDTH = 60;
const METER_HEIGHT = 18;
const BAR_WIDTH = 3;
const BAR_GAP = 1;

// Minimum bar height so bars don't disappear (keeps HUD feel alive)
const MIN_BAR_HEIGHT = 1;

type MeterStatus = 'idle' | 'pending' | 'live' | 'denied';

// Get a color along a cyan -> amber gradient for a normalized level [0,1].
function levelColor(level: number): string {
  // Cyan (var) approx rgb(57,229,255), amber approx rgb(255,176,0).
  const clamped = Math.max(0, Math.min(1, level));
  const r = Math.round(57 + (255 - 57) * clamped);
  const g = Math.round(229 + (176 - 229) * clamped);
  const b = Math.round(255 + (0 - 255) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

// Turn an AnalyserNode's frequency bins into 12 band magnitudes in [0,1].
// Splits the low third, middle third, and high third of the spectrum each
// into 4 bands, giving 12 total (low/mid/high x 4).
function computeBands(freqData: Uint8Array): number[] {
  const bins = freqData.length;
  if (bins === 0) return new Array(BAR_COUNT).fill(0);

  const lowEnd = Math.floor(bins * 0.15);
  const midEnd = Math.floor(bins * 0.5);

  const ranges: Array<[number, number]> = [
    [0, lowEnd],
    [lowEnd, midEnd],
    [midEnd, bins],
  ];

  const bands: number[] = [];
  for (const [start, end] of ranges) {
    const span = Math.max(1, end - start);
    const step = Math.max(1, Math.floor(span / 4));
    for (let i = 0; i < 4; i += 1) {
      const from = start + i * step;
      const to = i === 3 ? end : Math.min(end, from + step);
      let sum = 0;
      let count = 0;
      for (let j = from; j < to; j += 1) {
        sum += freqData[j];
        count += 1;
      }
      const avg = count > 0 ? sum / count : 0;
      // Normalize 0..255 -> 0..1 with a gentle curve so quiet speech shows up.
      bands.push(Math.min(1, Math.pow(avg / 255, 0.75)));
    }
  }
  return bands;
}

export function AudioMeter({ active }: Props) {
  const [status, setStatus] = useState<MeterStatus>('idle');
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(BAR_COUNT).fill(0)
  );

  // Refs hold all mutable audio plumbing so effect cleanup can tear down
  // everything deterministically even if `active` flips rapidly.
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const cancelledRef = useRef<boolean>(false);

  useEffect(() => {
    if (!active) {
      setStatus('idle');
      setLevels(new Array(BAR_COUNT).fill(0));
      return;
    }

    cancelledRef.current = false;
    setStatus('pending');

    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      setStatus('denied');
      return;
    }

    const setup = async () => {
      try {
        const stream = await md.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelledRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // Safari / WKWebView: AudioContext lives on window.AudioContext only
        // in modern WebKit; older builds still ship webkitAudioContext.
        const Ctor: typeof AudioContext | undefined =
          typeof window !== 'undefined'
            ? window.AudioContext ??
              (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext
            : undefined;

        if (!Ctor) {
          stream.getTracks().forEach((t) => t.stop());
          setStatus('denied');
          return;
        }

        const ctx = new Ctor();
        // WKWebView often starts the context suspended until a user gesture.
        // The VoiceButton press is our gesture, so resume() is safe here.
        if (ctx.state === 'suspended') {
          try {
            await ctx.resume();
          } catch {
            // Non-fatal: the analyser still yields data in most builds.
          }
        }

        if (cancelledRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close().catch(() => undefined);
          return;
        }

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);

        streamRef.current = stream;
        contextRef.current = ctx;
        analyserRef.current = analyser;

        const buffer = new Uint8Array(analyser.frequencyBinCount);
        setStatus('live');

        const tick = () => {
          const currentAnalyser = analyserRef.current;
          if (!currentAnalyser || cancelledRef.current) return;
          currentAnalyser.getByteFrequencyData(buffer);
          const bands = computeBands(buffer);
          setLevels(bands);
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        // Permission denied, no mic, or other MediaStream error.
        console.warn('AudioMeter: microphone unavailable', err);
        setStatus('denied');
      }
    };

    void setup();

    return () => {
      cancelledRef.current = true;

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      analyserRef.current = null;

      const ctx = contextRef.current;
      if (ctx) {
        void ctx.close().catch(() => undefined);
        contextRef.current = null;
      }
    };
  }, [active]);

  if (!active) return null;

  const wrapStyle: React.CSSProperties = {
    width: METER_WIDTH,
    height: METER_HEIGHT,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: BAR_GAP,
    fontFamily: 'var(--mono)',
    color: 'var(--cyan)',
    pointerEvents: 'none',
    userSelect: 'none',
  };

  if (status === 'denied') {
    const deniedStyle: React.CSSProperties = {
      ...wrapStyle,
      alignItems: 'center',
      fontSize: 8,
      letterSpacing: '0.14em',
      color: 'var(--amber, #ffb000)',
      textShadow: '0 0 6px rgba(255, 176, 0, 0.55)',
    };
    return (
      <div style={deniedStyle} aria-label="Microphone denied" title="Microphone denied">
        MIC DENIED
      </div>
    );
  }

  return (
    <div style={wrapStyle} aria-hidden="true">
      {levels.map((level, i) => {
        const h = Math.max(MIN_BAR_HEIGHT, Math.round(level * METER_HEIGHT));
        const barStyle: React.CSSProperties = {
          width: BAR_WIDTH,
          height: h,
          background: levelColor(level),
          boxShadow: level > 0.15 ? `0 0 4px ${levelColor(level)}` : 'none',
          transition: 'height 60ms linear',
          borderRadius: 1,
        };
        return <div key={i} style={barStyle} />;
      })}
    </div>
  );
}
