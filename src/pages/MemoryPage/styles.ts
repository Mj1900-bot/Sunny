// ---------------------------------------------------------------------------
// Shared styles — mono / cyan / amber HUD aesthetic matching the rest of
// the app. Inline-styled (not CSS-module) because the existing pages do
// the same and introducing a new chrome would clash.
// ---------------------------------------------------------------------------

import type { CSSProperties } from 'react';

export const DISPLAY_FONT = "'Orbitron', var(--mono)";

export const tabBarStyle: CSSProperties = {
  display: 'flex',
  borderBottom: '1px solid var(--line-soft)',
  marginBottom: 14,
  gap: 0,
};

export function tabStyle(active: boolean): CSSProperties {
  return {
    all: 'unset',
    padding: '10px 16px',
    cursor: 'pointer',
    fontFamily: DISPLAY_FONT,
    fontSize: 10,
    letterSpacing: '0.22em',
    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
    borderBottom: active ? '2px solid var(--cyan)' : '2px solid transparent',
    marginBottom: -1,
    transition: 'color 120ms, border-color 120ms',
  };
}

export const statsRowStyle: CSSProperties = {
  display: 'flex',
  gap: 18,
  alignItems: 'baseline',
  padding: '8px 0 14px',
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--ink-dim)',
  letterSpacing: '0.08em',
  flexWrap: 'wrap',
};

export const statPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 6,
  padding: '3px 8px',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink)',
};

export const searchRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  marginBottom: 12,
};

export const searchInputStyle: CSSProperties = {
  flex: 1,
  padding: '8px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  background: 'rgba(4, 18, 28, 0.6)',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink)',
  letterSpacing: '0.04em',
  outline: 'none',
};

export const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

export const rowStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.35)',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
  position: 'relative',
  transition: 'border-color 120ms, background-color 120ms',
};

/** Subtle left-edge color stripe (e.g. episodic kind accent). Matches row
 *  height via absolute positioning so the row layout is unchanged. */
export const stripeStyle = (color: string): CSSProperties => ({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 2,
  background: color,
  opacity: 0.85,
});

export const rowHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

export const badgeStyle = (color: string): CSSProperties => ({
  fontFamily: DISPLAY_FONT,
  fontSize: 9,
  letterSpacing: '0.18em',
  color,
  padding: '2px 6px',
  border: `1px solid ${color}`,
  whiteSpace: 'nowrap',
});

export const metaTextStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--ink-dim)',
  letterSpacing: '0.08em',
};

export const buttonStyle: CSSProperties = {
  all: 'unset',
  padding: '3px 8px',
  fontFamily: DISPLAY_FONT,
  fontSize: 9,
  letterSpacing: '0.18em',
  color: 'var(--cyan)',
  border: '1px solid var(--line-soft)',
  cursor: 'pointer',
};

/** Emphasized affordance for the primary action on a tab (e.g. "+ NEW"). */
export const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  padding: '6px 12px',
  color: 'var(--cyan)',
  borderColor: 'rgba(57, 229, 255, 0.55)',
  background: 'rgba(57, 229, 255, 0.06)',
};

export const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: 'var(--amber)',
  borderColor: 'rgba(255, 179, 71, 0.45)',
};

export const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.1em',
  color: 'var(--ink-dim)',
  marginBottom: 3,
  textTransform: 'uppercase',
};

export const emptyStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
  textAlign: 'center',
  padding: 24,
  border: '1px dashed var(--line-soft)',
  letterSpacing: '0.1em',
};

export const errorStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--amber)',
  padding: '8px 12px',
  border: '1px solid rgba(255, 179, 71, 0.4)',
  background: 'rgba(255, 179, 71, 0.06)',
  marginBottom: 12,
  letterSpacing: '0.1em',
};
