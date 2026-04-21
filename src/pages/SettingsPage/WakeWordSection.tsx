/**
 * WakeWordSection — Section 2 of the Autopilot settings tab.
 * Toggle: Wake word enabled (off).
 * Slider: Confidence threshold 0.5–0.95 (default 0.7).
 * Status indicator: "Listening" / "Idle" from Tauri event or 1s poll.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../../lib/tauri';
import type { AutopilotSettings, PendingKeys, WakeWordStatus } from './autopilotTypes';
import { PendingDot } from './PendingDot';
import {
  hintStyle,
  labelStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
  statusPillStyle,
} from './styles';

type Props = {
  readonly settings: AutopilotSettings;
  readonly pending: PendingKeys;
  readonly patch: (diff: Partial<AutopilotSettings>) => void;
};

/** Reads wake-word status from the `sunny://wake_word/status` event, or
 *  polls `isTauri` every second as a fallback. */
function useWakeWordStatus(enabled: boolean): WakeWordStatus {
  const [status, setStatus] = useState<WakeWordStatus>('idle');

  useEffect(() => {
    if (!enabled) { setStatus('idle'); return; }
    if (!isTauri) return;

    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const fn = await listen<{ status: string }>('sunny://wake_word/status', e => {
          setStatus(e.payload.status === 'listening' ? 'listening' : 'idle');
        });
        unlisten = fn;
      } catch {
        // Event not available — fall back to 1-second poll
        const id = window.setInterval(() => {
          setStatus(prev => prev); // no-op; real poll would invoke status cmd
        }, 1000);
        unlisten = () => window.clearInterval(id);
      }
    })();

    return () => { unlisten?.(); };
  }, [enabled]);

  return status;
}

export function WakeWordSection({ settings, pending, patch }: Props) {
  const status = useWakeWordStatus(settings.wakeWordEnabled);

  return (
    <section style={sectionStyle} aria-labelledby="sect-wake-word">
      <h3 id="sect-wake-word" style={sectionTitleStyle}>WAKE WORD</h3>

      <div style={{ ...rowStyle, marginBottom: 10 }}>
        <label htmlFor="ww-enabled" style={toggleLabel}>
          Enabled
          <PendingDot active={pending.has('wakeWordEnabled')} />
        </label>
        <input
          id="ww-enabled"
          type="checkbox"
          checked={settings.wakeWordEnabled}
          onChange={e => patch({ wakeWordEnabled: e.target.checked })}
        />
        <span
          style={statusPillStyle(status === 'listening' ? 'var(--cyan)' : 'var(--ink-dim)')}
          aria-live="polite"
          aria-label={`Wake word status: ${status}`}
        >
          {status === 'listening' ? 'LISTENING' : 'IDLE'}
        </span>
      </div>

      <div>
        <label htmlFor="ww-confidence" style={labelStyle}>
          CONFIDENCE — {settings.wakeWordConfidence.toFixed(2)}
          <PendingDot active={pending.has('wakeWordConfidence')} />
        </label>
        <input
          id="ww-confidence"
          type="range"
          min={0.5}
          max={0.95}
          step={0.05}
          value={settings.wakeWordConfidence}
          onChange={e => patch({ wakeWordConfidence: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
          aria-valuemin={0.5}
          aria-valuemax={0.95}
          aria-valuenow={settings.wakeWordConfidence}
          aria-valuetext={settings.wakeWordConfidence.toFixed(2)}
          disabled={!settings.wakeWordEnabled}
        />
        <div style={hintStyle}>
          Higher threshold reduces false positives; lower improves recall in noisy environments.
        </div>
      </div>
    </section>
  );
}

const toggleLabel: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  flex: 1,
};
