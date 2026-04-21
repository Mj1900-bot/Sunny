/**
 * Live waveform bar strip fed from the native `sunny://voice.level` RMS
 * stream (same source that powers `useVoiceActivity`). Keeps a rolling
 * buffer of the most recent levels so the bars appear to flow right-to-
 * left while the user speaks. Pure visual — no IPC beyond the listener.
 */

import { useEffect, useRef, useState } from 'react';
import { listen } from '../../lib/tauri';

type Props = {
  readonly active: boolean;
  readonly bars?: number;
  readonly height?: number;
};

const DEFAULT_BARS = 48;
const DEFAULT_HEIGHT = 56;

export function Waveform({ active, bars = DEFAULT_BARS, height = DEFAULT_HEIGHT }: Props) {
  const [levels, setLevels] = useState<ReadonlyArray<number>>(() => Array.from({ length: bars }, () => 0));
  const bufRef = useRef<number[]>(Array.from({ length: bars }, () => 0));

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await listen<number>('sunny://voice.level', rms => {
          if (cancelled) return;
          const level = typeof rms === 'number' ? rms : 0;
          const next = [...bufRef.current.slice(1), Math.min(1, level * 6)];
          bufRef.current = next;
          setLevels(next);
        });
        if (cancelled) { stop(); return; }
        unlisten = stop;
      } catch {
        /* no-op outside Tauri */
      }
    })();
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, [bars]);

  // Decay towards zero while idle so the bars collapse visually.
  useEffect(() => {
    if (active) return;
    const id = window.setInterval(() => {
      const decayed = bufRef.current.map(v => v * 0.8);
      bufRef.current = decayed;
      setLevels(decayed);
    }, 60);
    return () => window.clearInterval(id);
  }, [active]);

  return (
    <div
      aria-hidden
      style={{
        display: 'flex', alignItems: 'flex-end', gap: 2,
        height, width: '100%',
        padding: '4px 0',
        borderTop: '1px solid var(--line-soft)',
        borderBottom: '1px solid var(--line-soft)',
        background: 'rgba(0, 0, 0, 0.25)',
      }}
    >
      {levels.map((v, i) => {
        const pct = Math.max(0.04, Math.min(1, v));
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${pct * 100}%`,
              background: active
                ? `linear-gradient(180deg, var(--red), rgba(255,77,94,0.3))`
                : `linear-gradient(180deg, var(--cyan), rgba(57,229,255,0.25))`,
              boxShadow: active
                ? `0 0 6px rgba(255,77,94,${0.3 + pct * 0.5})`
                : `0 0 4px rgba(57,229,255,${0.15 + pct * 0.35})`,
              transition: 'height 80ms linear',
              minHeight: 2,
            }}
          />
        );
      })}
    </div>
  );
}
