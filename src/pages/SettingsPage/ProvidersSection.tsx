/**
 * ProvidersSection — Section 5 of the Autopilot settings tab.
 * Toggle: Prefer local (off).
 * Slider: GLM daily cap $0.10–$5.00 (default $1.00).
 * Radio: Quality mode (AlwaysBest | Balanced | CostAware).
 */

import { useRef, type CSSProperties } from 'react';
import type { AutopilotSettings, PendingKeys, QualityMode } from './autopilotTypes';
import { PendingDot } from './PendingDot';
import {
  chipStyle,
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
  /** Optional live tier label emitted by cost events (e.g. "GLM-5.1", "Opus"). */
  readonly liveTier?: string | undefined;
};

// ---------------------------------------------------------------------------
// Quality mode option definitions
// ---------------------------------------------------------------------------

export type QualityOption = {
  readonly value: QualityMode;
  readonly label: string;
  readonly badge: string;
  readonly subtitle: string;
};

export const QUALITY_OPTIONS: readonly QualityOption[] = [
  {
    value: 'always_best',
    label: 'Always best',
    badge: '⚡ premium',
    subtitle: 'Delegates complex tasks to Claude Code (Opus). Higher cost, best quality.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    badge: '✓',
    subtitle: 'Uses GLM-5.1 for most work, local models for simple. Good tradeoff.',
  },
  {
    value: 'cost_aware',
    label: 'Cost-aware',
    badge: '$',
    subtitle: 'Never uses premium (Claude Code). Cheaper, slightly lower ceiling.',
  },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProvidersSection({ settings, pending, patch, liveTier }: Props) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleQualityChange(value: QualityMode) {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      patch({ qualityMode: value });
      debounceRef.current = null;
    }, 300);
  }

  return (
    <section style={sectionStyle} aria-labelledby="sect-providers">
      <h3 id="sect-providers" style={sectionTitleStyle}>PROVIDERS</h3>

      {/* Prefer local toggle */}
      <div style={{ ...rowStyle, marginBottom: 12 }}>
        <label htmlFor="prov-prefer-local" style={toggleLabel}>
          Prefer local
          <PendingDot active={pending.has('providersPreferLocal')} />
        </label>
        <input
          id="prov-prefer-local"
          type="checkbox"
          checked={settings.providersPreferLocal}
          onChange={e => patch({ providersPreferLocal: e.target.checked })}
        />
      </div>
      <div style={{ marginBottom: 12, ...hintStyle }}>
        Route requests to local Ollama models before falling back to cloud.
      </div>

      {/* GLM daily cap slider */}
      <div style={{ marginBottom: 16 }}>
        <label htmlFor="prov-glm-cap" style={labelStyle}>
          GLM DAILY CAP — ${settings.glmDailyCostCap.toFixed(2)}
          <PendingDot active={pending.has('glmDailyCostCap')} />
        </label>
        <input
          id="prov-glm-cap"
          type="range"
          min={0.1}
          max={5}
          step={0.1}
          value={settings.glmDailyCostCap}
          onChange={e => patch({ glmDailyCostCap: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
          aria-valuemin={0.1}
          aria-valuemax={5}
          aria-valuenow={settings.glmDailyCostCap}
          aria-valuetext={`$${settings.glmDailyCostCap.toFixed(2)}`}
        />
        <div style={hintStyle}>Spending ceiling for GLM / Zhipu models per day.</div>
      </div>

      {/* Quality mode radio group */}
      <div>
        <div style={{ ...labelStyle, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          QUALITY MODE
          <PendingDot active={pending.has('qualityMode')} />
          {liveTier !== undefined && liveTier.length > 0 && (
            <span style={liveTierStyle} aria-label={`Current tier: ${liveTier}`}>
              {liveTier}
            </span>
          )}
        </div>
        <div
          role="radiogroup"
          aria-label="Quality mode"
          style={radioGroupStyle}
        >
          {QUALITY_OPTIONS.map(opt => {
            const isSelected = settings.qualityMode === opt.value;
            return (
              <button
                key={opt.value}
                role="radio"
                aria-checked={isSelected}
                id={`prov-quality-${opt.value}`}
                style={{ ...chipStyle(isSelected), ...radioCardStyle }}
                onClick={() => handleQualityChange(opt.value)}
                type="button"
              >
                <span style={radioCardHeader}>
                  <span style={radioCardLabel}>{opt.label}</span>
                  <span style={badgeStyle(isSelected)}>{opt.badge}</span>
                </span>
                <span style={{ ...hintStyle, marginTop: 4 }}>{opt.subtitle}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Local styles
// ---------------------------------------------------------------------------

const toggleLabel: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  flex: 1,
};

const radioGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const radioCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  textAlign: 'left',
  padding: '8px 12px',
  width: '100%',
};

const radioCardHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
};

const radioCardLabel: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  flex: 1,
};

function badgeStyle(active: boolean): CSSProperties {
  return {
    fontFamily: 'var(--mono)',
    fontSize: 10,
    letterSpacing: '0.1em',
    padding: '1px 6px',
    border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-soft)'}`,
    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
    background: 'rgba(0,0,0,0.2)',
  };
}

const liveTierStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.15em',
  padding: '1px 7px',
  border: '1px solid var(--cyan)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.08)',
  textTransform: 'uppercase',
};
