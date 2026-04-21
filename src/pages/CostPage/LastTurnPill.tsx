/**
 * LastTurnPill — small badge showing the tier + model of the most recent turn.
 * Lives in the top-right of CostPage header area.
 *
 * Updates live via the `sunny://cost/update` event subscription (same as
 * the parent page's loadAll).  Receives the latest TelemetryEvent as a prop.
 *
 * Visual: `[Premium] claude-opus-4-7`  in tier-colour + mono model slug.
 * Hidden when no events have been recorded (null lastEvent).
 */

import type { TelemetryEvent } from './types';

const TIER_COLORS: Record<string, string> = {
  quickthink: 'var(--green)',
  cloud:      'var(--cyan)',
  deeplocal:  'var(--violet)',
  premium:    'var(--amber)',
};

const TIER_LABELS: Record<string, string> = {
  quickthink: 'QuickThink',
  cloud:      'Cloud',
  deeplocal:  'DeepLocal',
  premium:    'Premium',
};

type Props = {
  readonly lastEvent: TelemetryEvent | null;
};

export function LastTurnPill({ lastEvent }: Props) {
  if (!lastEvent) return null;

  const tier      = lastEvent.tier ?? null;
  const color     = tier ? (TIER_COLORS[tier] ?? 'var(--ink-2)') : 'var(--ink-2)';
  const tierLabel = tier ? (TIER_LABELS[tier] ?? tier) : null;

  return (
    <div
      data-testid="last-turn-pill"
      title={`Last turn: ${lastEvent.model}${tier ? ` via ${tierLabel}` : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        border: `1px solid ${color}`,
        background: 'rgba(6, 14, 22, 0.7)',
        flexShrink: 0,
      }}
    >
      {tierLabel && (
        <span style={{
          fontFamily: 'var(--display)',
          fontSize: 8,
          letterSpacing: '0.24em',
          fontWeight: 700,
          color,
          textTransform: 'uppercase',
        }}>
          {tierLabel}
        </span>
      )}
      <span style={{
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: 'var(--ink)',
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {lastEvent.model}
      </span>
    </div>
  );
}
