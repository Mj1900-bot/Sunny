/**
 * TierDistribution — 4-row horizontal bar chart showing today's turn and
 * cost breakdown across routing tiers (QuickThink / Cloud / DeepLocal / Premium).
 *
 * Each row: tier name | turn count | cost USD | % bar
 * Bar width = percentage of today's total turns served by that tier.
 *
 * Color coding:
 *   QuickThink  →  mint green  (var(--green))   free + fast local
 *   Cloud       →  cyan        (var(--cyan))    default, cheap cloud
 *   DeepLocal   →  violet      (var(--violet))  private local inference
 *   Premium     →  amber       (var(--amber))   premium paid models
 *
 * Empty state (0 turns today): "No turns today yet."
 *
 * ≤250 lines.
 */

import type { TierSlice } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCost(usd: number): string {
  if (usd === 0)    return '$0.00';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01)  return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type BarRowProps = {
  readonly slice: TierSlice;
};

function BarRow({ slice }: BarRowProps) {
  const { label, turns, costUsd, pct, color, colorClass } = slice;
  const clamped = Math.max(0, Math.min(100, pct));

  return (
    <div
      data-testid={`tier-row-${colorClass}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '90px 48px 64px 1fr',
        alignItems: 'center',
        gap: 8,
        padding: '5px 6px',
      }}
    >
      {/* Tier name */}
      <div style={{
        fontFamily: 'var(--display)',
        fontSize: 9,
        letterSpacing: '0.22em',
        fontWeight: 700,
        color,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {label}
      </div>

      {/* Turn count */}
      <div style={{
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink)',
        textAlign: 'right',
        fontWeight: 600,
      }}>
        {turns}
      </div>

      {/* Cost USD */}
      <div style={{
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: 'var(--ink-dim)',
        textAlign: 'right',
      }}>
        {fmtCost(costUsd)}
      </div>

      {/* % bar */}
      <div
        data-testid={`tier-bar-${colorClass}`}
        aria-label={`${label}: ${pct}%`}
        style={{
          position: 'relative',
          height: 6,
          background: 'rgba(57, 229, 255, 0.06)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${clamped}%`,
            background: `linear-gradient(90deg, ${color}, transparent)`,
            boxShadow: `0 0 6px ${color}`,
            transition: 'width 320ms ease',
          }}
        />
        <span style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          fontFamily: 'var(--mono)',
          fontSize: 9,
          color: 'var(--ink-dim)',
          lineHeight: 1,
          pointerEvents: 'none',
        }}>
          {pct}%
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TierDistribution (exported)
// ---------------------------------------------------------------------------

type Props = {
  readonly slices: ReadonlyArray<TierSlice>;
};

export function TierDistribution({ slices }: Props) {
  if (slices.length === 0) {
    return (
      <div
        data-testid="tier-empty-state"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '18px 12px',
          border: '1px dashed var(--line-soft)',
          background: 'rgba(57, 229, 255, 0.02)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--ink-dim)',
          letterSpacing: '0.06em',
        }}
      >
        No turns today yet.
      </div>
    );
  }

  return (
    <div
      data-testid="tier-distribution"
      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '90px 48px 64px 1fr',
        gap: 8,
        padding: '0 6px 4px',
        borderBottom: '1px solid var(--line-soft)',
      }}>
        {(['TIER', 'TURNS', 'COST', '%'].map(h => (
          <div key={h} style={{
            fontFamily: 'var(--display)',
            fontSize: 8,
            letterSpacing: '0.26em',
            color: 'var(--ink-dim)',
            fontWeight: 700,
            textAlign: h !== 'TIER' && h !== '%' ? 'right' : 'left',
          }}>{h}</div>
        )))}
      </div>

      {slices.map(sl => (
        <BarRow key={sl.name} slice={sl} />
      ))}
    </div>
  );
}
