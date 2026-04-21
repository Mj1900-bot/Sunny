import { type CSSProperties } from 'react';

export const sectionTitle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 11,
  letterSpacing: '0.2em',
  color: 'var(--cyan)',
  fontWeight: 700,
  marginBottom: 10,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

export const actionBtn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '7px 12px',
  border: '1px solid var(--line)',
  color: 'var(--cyan)',
  fontFamily: 'var(--display)',
  fontSize: 10.5,
  letterSpacing: '0.18em',
  fontWeight: 700,
  background: 'linear-gradient(90deg, rgba(57, 229, 255, 0.15), rgba(57, 229, 255, 0.02))',
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

export const ghostBtn: CSSProperties = {
  ...actionBtn,
  background: 'transparent',
  color: 'var(--ink-2)',
  borderColor: 'var(--line-soft)',
};

export const toggleOnBtn: CSSProperties = {
  ...actionBtn,
  background: 'rgba(57,229,255,0.22)',
  boxShadow: 'inset 0 0 0 1px var(--cyan), 0 0 10px rgba(57,229,255,0.25)',
};

export const labelSmall: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.15em',
  color: 'var(--ink-dim)',
};

export const valueMono: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
};

export const tinyBtn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '3px 7px',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.12em',
  color: 'var(--cyan)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57,229,255,0.06)',
  fontWeight: 600,
};

/** Small uppercase caption used as the header of a toolbar group. */
export const toolbarCaption: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.24em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
  marginBottom: 4,
  display: 'block',
};

/** Vertical divider separating logical toolbar groups. */
export const toolbarDivider: CSSProperties = {
  alignSelf: 'stretch',
  width: 1,
  background:
    'linear-gradient(180deg, transparent 0%, rgba(57,229,255,0.18) 35%, rgba(57,229,255,0.18) 65%, transparent 100%)',
  margin: '0 4px',
};
