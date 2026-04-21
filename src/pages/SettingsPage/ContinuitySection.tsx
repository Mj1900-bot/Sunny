/**
 * ContinuitySection — Section 4 of the Autopilot settings tab.
 * Toggle: Warm-context (on).
 * Number input: Sessions to preload 1–10 (default 3).
 */

import type { CSSProperties } from 'react';
import type { AutopilotSettings, PendingKeys } from './autopilotTypes';
import { PendingDot } from './PendingDot';
import {
  hintStyle,
  inputStyle,
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

export function ContinuitySection({ settings, pending, patch }: Props) {
  return (
    <section style={sectionStyle} aria-labelledby="sect-continuity">
      <h3 id="sect-continuity" style={sectionTitleStyle}>CONTINUITY</h3>

      <div style={{ ...rowStyle, marginBottom: 12 }}>
        <label htmlFor="cont-warm-context" style={toggleLabel}>
          Warm context
          <PendingDot active={pending.has('continuityWarmContext')} />
        </label>
        <input
          id="cont-warm-context"
          type="checkbox"
          checked={settings.continuityWarmContext}
          onChange={e => patch({ continuityWarmContext: e.target.checked })}
        />
      </div>

      <div>
        <label htmlFor="cont-sessions" style={labelStyle}>
          SESSIONS TO PRELOAD
          <PendingDot active={pending.has('continuitySessionsToPreload')} />
        </label>
        <input
          id="cont-sessions"
          type="number"
          min={1}
          max={10}
          value={settings.continuitySessionsToPreload}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v) && v >= 1 && v <= 10) {
              patch({ continuitySessionsToPreload: v });
            }
          }}
          style={{ ...inputStyle, width: 80 }}
          aria-valuemin={1}
          aria-valuemax={10}
        />
        <div style={hintStyle}>
          Number of previous sessions loaded into context at startup. Higher values improve recall; lower values save tokens.
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
