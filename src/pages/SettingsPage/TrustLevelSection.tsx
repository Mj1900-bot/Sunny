/**
 * TrustLevelSection — Section 3 of the Autopilot settings tab.
 * 3-position segmented control: Confirm All | Smart | Autonomous.
 * Each option has a 1-line description below.
 */

import type { AutopilotSettings, PendingKeys, TrustLevel } from './autopilotTypes';
import { PendingDot } from './PendingDot';
import {
  chipStyle,
  hintStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';

const TRUST_OPTIONS: ReadonlyArray<{
  readonly value: TrustLevel;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: 'confirm_all',
    label: 'Confirm All',
    description: 'Every tool call requires manual approval before execution.',
  },
  {
    value: 'smart',
    label: 'Smart',
    description: 'Low-risk actions run automatically; high-risk waits for confirmation.',
  },
  {
    value: 'autonomous',
    label: 'Autonomous',
    description: 'Sunny acts without interrupting you. Best for trusted, scripted workflows.',
  },
];

type Props = {
  readonly settings: AutopilotSettings;
  readonly pending: PendingKeys;
  readonly patch: (diff: Partial<AutopilotSettings>) => void;
};

export function TrustLevelSection({ settings, pending, patch }: Props) {
  const selected = settings.trustLevel;
  const selectedOption = TRUST_OPTIONS.find(o => o.value === selected);

  return (
    <section style={sectionStyle} aria-labelledby="sect-trust-level">
      <h3 id="sect-trust-level" style={sectionTitleStyle}>
        TRUST LEVEL
        <PendingDot active={pending.has('trustLevel')} />
      </h3>

      <div
        role="radiogroup"
        aria-label="Trust level"
        style={{ ...rowStyle, marginBottom: 10 }}
      >
        {TRUST_OPTIONS.map(opt => (
          <button
            key={opt.value}
            role="radio"
            aria-checked={selected === opt.value}
            style={chipStyle(selected === opt.value)}
            onClick={() => patch({ trustLevel: opt.value })}
            title={opt.description}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {selectedOption && (
        <div style={hintStyle}>{selectedOption.description}</div>
      )}
    </section>
  );
}
