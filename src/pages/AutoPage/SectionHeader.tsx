import type { ReactNode } from 'react';

// ─────────────────────────────────────────────────────────────────
// Section header (shared across AUTO panels)
//
// Enhanced with optional count badge, accent tone, and animated
// bottom-border glow for premium visual feel.
// ─────────────────────────────────────────────────────────────────

type Tone = 'cyan' | 'amber' | 'green' | 'red' | 'violet' | 'gold';

const TONE_VAR: Record<Tone, string> = {
  cyan: 'var(--cyan)',
  amber: 'var(--amber)',
  green: 'var(--green)',
  red: 'var(--red)',
  violet: 'var(--violet)',
  gold: 'var(--gold)',
};

export function SectionHeader({
  label,
  right,
  count,
  tone = 'cyan',
}: {
  label: string;
  right?: ReactNode;
  count?: number | string;
  tone?: Tone;
}) {
  const color = TONE_VAR[tone];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: `1px solid ${color}`,
        paddingBottom: 6,
        marginBottom: 10,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Animated glow underline */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          bottom: -1,
          left: 0,
          right: 0,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
          opacity: 0.6,
          animation: 'sectionGlow 3s ease-in-out infinite',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            fontFamily: 'var(--display)',
            fontSize: 11,
            letterSpacing: '0.28em',
            color,
            fontWeight: 700,
          }}
        >
          {label}
        </div>
        {count !== undefined && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.12em',
              color: '#fff',
              background: color,
              padding: '1px 7px',
              borderRadius: 2,
              fontWeight: 700,
              lineHeight: 1.4,
              minWidth: 18,
              textAlign: 'center',
              boxShadow: `0 0 8px ${color}55`,
            }}
          >
            {count}
          </span>
        )}
      </div>
      {right}
    </div>
  );
}
