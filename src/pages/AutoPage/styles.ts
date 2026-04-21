// ─────────────────────────────────────────────────────────────────
// Shared style tokens for the AUTO module
// ─────────────────────────────────────────────────────────────────

import type { CSSProperties } from 'react';
import type { ActionType, JobKind } from './types';

export const LETTER = '0.12em';

export const chipBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: LETTER,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

export const chipOutline = (color: string, active: boolean): CSSProperties => ({
  ...chipBase,
  cursor: 'pointer',
  border: `1px solid ${active ? color : 'var(--line-soft)'}`,
  background: active ? 'rgba(57, 229, 255, 0.18)' : 'rgba(6, 14, 22, 0.5)',
  color: active ? '#fff' : color,
  userSelect: 'none',
});

export const staticChip = (color: string): CSSProperties => ({
  ...chipBase,
  border: `1px solid ${color}`,
  background: 'rgba(6, 14, 22, 0.6)',
  color,
});

export const inputStyle: CSSProperties = {
  width: '100%',
  background: 'rgba(4, 10, 16, 0.85)',
  color: 'var(--ink)',
  border: '1px solid var(--line-soft)',
  padding: '7px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  boxSizing: 'border-box',
};

export const labelStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.22em',
  color: 'var(--cyan)',
  fontWeight: 700,
  marginBottom: 4,
};

export const primaryBtn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '7px 14px',
  border: '1px solid var(--cyan)',
  color: '#fff',
  background: 'rgba(57, 229, 255, 0.22)',
  fontFamily: 'var(--display)',
  fontSize: 11,
  letterSpacing: '0.2em',
  fontWeight: 700,
  textAlign: 'center',
};

export const ghostBtn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '5px 10px',
  border: '1px solid var(--line-soft)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.05)',
  fontFamily: 'var(--display)',
  fontSize: 10,
  letterSpacing: '0.18em',
  fontWeight: 700,
};

// ─────────────────────────────────────────────────────────────────
// Color map for action types and job kinds
// ─────────────────────────────────────────────────────────────────

export const ACTION_COLOR: Record<ActionType, string> = {
  Shell: 'var(--green)',
  Notify: 'var(--amber)',
  Speak: 'var(--violet)',
  AgentGoal: 'var(--cyan)',
};

export const KIND_COLOR: Record<JobKind, string> = {
  Once: 'var(--cyan)',
  Interval: 'var(--amber)',
};

// ─────────────────────────────────────────────────────────────────
// Meta-cell styles (used by job row next/last columns)
// ─────────────────────────────────────────────────────────────────

export const metaLabel: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 8,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
};

export function metaCell(_label: string, valueColor: string): CSSProperties {
  return {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: valueColor,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    letterSpacing: '0.05em',
    overflow: 'hidden',
  };
}
