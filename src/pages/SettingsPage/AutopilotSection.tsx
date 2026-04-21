/**
 * AutopilotSection — Section 1 of the Autopilot settings tab.
 * Toggles: Enabled (on), Voice speak (off, experimental), Calm mode (off).
 * Slider: Daily cost cap $0.50–$20.00 (default $1.00).
 */

import type { CSSProperties } from 'react';
import type { AutopilotSettings, PendingKeys } from './autopilotTypes';
import { PendingDot } from './PendingDot';
import {
  hintStyle,
  labelStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';

type Props = {
  readonly settings: AutopilotSettings;
  readonly pending: PendingKeys;
  readonly patch: (diff: Partial<AutopilotSettings>) => void;
};

export function AutopilotSection({ settings, pending, patch }: Props) {
  return (
    <section style={sectionStyle} aria-labelledby="sect-autopilot">
      <h3 id="sect-autopilot" style={sectionTitleStyle}>AUTOPILOT</h3>

      <div style={rowStyle}>
        <label htmlFor="ap-enabled" style={toggleLabel}>
          Enabled
          <PendingDot active={pending.has('autopilotEnabled')} />
        </label>
        <input
          id="ap-enabled"
          type="checkbox"
          checked={settings.autopilotEnabled}
          onChange={e => patch({ autopilotEnabled: e.target.checked })}
        />
      </div>

      <div style={{ ...rowStyle, marginTop: 8 }}>
        <label htmlFor="ap-voice-speak" style={toggleLabel}>
          Voice speak
          <span style={experimentalBadge}> experimental</span>
          <PendingDot active={pending.has('autopilotVoiceSpeak')} />
        </label>
        <input
          id="ap-voice-speak"
          type="checkbox"
          checked={settings.autopilotVoiceSpeak}
          onChange={e => patch({ autopilotVoiceSpeak: e.target.checked })}
        />
      </div>

      <div style={{ ...rowStyle, marginTop: 8 }}>
        <label htmlFor="ap-calm-mode" style={toggleLabel}>
          Calm mode
          <PendingDot active={pending.has('autopilotCalmMode')} />
        </label>
        <input
          id="ap-calm-mode"
          type="checkbox"
          checked={settings.autopilotCalmMode}
          onChange={e => patch({ autopilotCalmMode: e.target.checked })}
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <label htmlFor="ap-daily-cost-cap" style={labelStyle}>
          DAILY COST CAP — ${settings.autopilotDailyCostCap.toFixed(2)}
          <PendingDot active={pending.has('autopilotDailyCostCap')} />
        </label>
        <input
          id="ap-daily-cost-cap"
          type="range"
          min={0.5}
          max={20}
          step={0.5}
          value={settings.autopilotDailyCostCap}
          onChange={e => patch({ autopilotDailyCostCap: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
          aria-valuemin={0.5}
          aria-valuemax={20}
          aria-valuenow={settings.autopilotDailyCostCap}
          aria-valuetext={`$${settings.autopilotDailyCostCap.toFixed(2)}`}
        />
        <div style={hintStyle}>Hard ceiling on AI spend per calendar day. Autopilot pauses when hit.</div>
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

const experimentalBadge: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.14em',
  color: 'var(--amber)',
  border: '1px solid var(--amber)',
  borderRadius: 3,
  padding: '1px 5px',
  marginLeft: 4,
};
