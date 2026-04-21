import type { CSSProperties } from 'react';
import { analyzeSecretEntropy, strengthTier } from './utils';

/**
 * Renders a compact 4-bar strength bar for a pasted / typed secret. Purely
 * read-only; entropy is estimated from the character-class surface area of
 * the value (not its contents — we never send it anywhere).
 */
export function StrengthMeter({ value }: { readonly value: string }) {
  const bits = analyzeSecretEntropy(value);
  const tier = strengthTier(bits);
  const fillCount = bits === 0 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 90 ? 3 : 4;

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: 'var(--mono)',
    fontSize: 10,
    letterSpacing: '0.14em',
  };
  const barStyle = (active: boolean): CSSProperties => ({
    width: 22,
    height: 3,
    background: active ? tier.color : 'rgba(57, 229, 255, 0.12)',
    boxShadow: active ? `0 0 6px ${tier.color}` : 'none',
    transition: 'background 0.15s ease',
  });

  return (
    <div style={rowStyle} aria-label={`strength ${tier.label}`}>
      <span style={{ display: 'flex', gap: 3 }}>
        <span style={barStyle(fillCount >= 1)} />
        <span style={barStyle(fillCount >= 2)} />
        <span style={barStyle(fillCount >= 3)} />
        <span style={barStyle(fillCount >= 4)} />
      </span>
      <span style={{ color: tier.color }}>{tier.label}</span>
      {value.length > 0 && (
        <span style={{ color: 'var(--ink-dim)' }}>~{bits}b · {value.length}ch</span>
      )}
    </div>
  );
}
