import type { CSSProperties } from 'react';

export const DISPLAY_FONT = "'Orbitron', var(--mono)";

export const sectionStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.4)',
  padding: '16px 18px',
  marginBottom: 14,
};

export const sectionTitleStyle: CSSProperties = {
  fontFamily: DISPLAY_FONT,
  fontSize: 10.5,
  letterSpacing: '0.26em',
  color: 'var(--cyan)',
  textTransform: 'uppercase',
  fontWeight: 700,
  marginBottom: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

export const labelStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
  marginBottom: 6,
  textTransform: 'uppercase',
};

export const hintStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--ink-dim)',
  lineHeight: 1.5,
};

export const inputStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  padding: '8px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(2, 6, 10, 0.6)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  width: '100%',
};

export const chipBaseStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  cursor: 'pointer',
  padding: '6px 12px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.55)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.12em',
};

export const chipActiveStyle: CSSProperties = {
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.12)',
  fontWeight: 700,
};

export const primaryBtnStyle: CSSProperties = {
  ...chipBaseStyle,
  padding: '8px 16px',
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.10)',
  letterSpacing: '0.22em',
  fontWeight: 700,
};

export const dangerBtnStyle: CSSProperties = {
  ...chipBaseStyle,
  borderColor: 'rgba(255, 106, 106, 0.55)',
  color: '#ff6a6a',
  background: 'rgba(255, 106, 106, 0.06)',
};

export const mutedBtnStyle: CSSProperties = {
  ...chipBaseStyle,
  padding: '4px 10px',
  fontSize: 10,
  letterSpacing: '0.14em',
};

export const tabBarStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  marginBottom: 16,
  paddingBottom: 10,
  borderBottom: '1px solid var(--line-soft)',
  flexWrap: 'wrap',
};

export function tabStyle(active: boolean): CSSProperties {
  return {
    all: 'unset',
    cursor: 'pointer',
    padding: '6px 14px',
    border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-soft)'}`,
    background: active ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.55)',
    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
    fontFamily: DISPLAY_FONT,
    fontSize: 11,
    letterSpacing: '0.24em',
    fontWeight: active ? 700 : 500,
  };
}

export const statsRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: 10,
  marginBottom: 16,
};

export const statCardStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(4, 10, 16, 0.5)',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const statLabelStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
  textTransform: 'uppercase',
};

export const statValueStyle: CSSProperties = {
  fontFamily: DISPLAY_FONT,
  fontSize: 22,
  letterSpacing: '0.08em',
  color: 'var(--ink)',
  fontWeight: 700,
};

export const emptyStateStyle: CSSProperties = {
  border: '1px dashed var(--line-soft)',
  padding: '48px 16px',
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.18em',
  color: 'var(--ink-dim)',
  lineHeight: 1.7,
};

export const findingRowStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.4)',
  marginBottom: 10,
};

export const findingHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '96px 1fr auto auto',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
};
