import type { CSSProperties } from 'react';
import type { Severity, BucketStatus, PermState } from './types';

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

export const hintStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--ink-dim)',
  lineHeight: 1.5,
};

export const inputStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  padding: '6px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(2, 6, 10, 0.6)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
};

export const chipBaseStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  cursor: 'pointer',
  padding: '4px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.55)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
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
  padding: '8px 16px',
  borderColor: 'rgba(255, 77, 94, 0.6)',
  color: 'var(--red)',
  background: 'rgba(255, 77, 94, 0.10)',
  letterSpacing: '0.22em',
  fontWeight: 700,
};

export const mutedBtnStyle: CSSProperties = {
  ...chipBaseStyle,
  padding: '4px 10px',
  fontSize: 10,
  letterSpacing: '0.14em',
  color: 'var(--ink-dim)',
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
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
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
  fontWeight: 700,
};

export const emptyStateStyle: CSSProperties = {
  border: '1px dashed var(--line-soft)',
  padding: '40px 16px',
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.16em',
  color: 'var(--ink-dim)',
  lineHeight: 1.7,
};

export const listRowStyle: CSSProperties = {
  display: 'grid',
  alignItems: 'center',
  gap: 10,
  padding: '6px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(4, 10, 16, 0.45)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  marginBottom: 4,
};

export function severityColor(sev: Severity | BucketStatus): string {
  switch (sev) {
    case 'crit': return 'var(--red)';
    case 'warn': return 'var(--amber)';
    case 'ok':
    case 'info': return 'var(--green)';
    case 'unknown':
    default:     return 'var(--ink-dim)';
  }
}

export function permStateColor(state: PermState): string {
  switch (state) {
    case 'granted': return 'var(--green)';
    case 'denied':  return 'var(--red)';
    case 'error':   return 'var(--amber)';
    case 'unknown':
    default:        return 'var(--ink-dim)';
  }
}

export function severityBadgeStyle(sev: Severity | BucketStatus): CSSProperties {
  const c = severityColor(sev);
  return {
    display: 'inline-block',
    padding: '1px 7px',
    border: `1px solid ${c}88`,
    background: `${c}14`,
    color: c,
    fontFamily: 'var(--mono)',
    fontSize: 9,
    letterSpacing: '0.22em',
    fontWeight: 700,
    textTransform: 'uppercase',
  };
}
