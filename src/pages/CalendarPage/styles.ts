import type { CSSProperties } from 'react';

export const navBtnStyle: CSSProperties = {
  all: 'unset', cursor: 'pointer',
  fontFamily: 'var(--mono)', fontSize: 10,
  letterSpacing: '0.18em', color: 'var(--cyan)',
  padding: '4px 8px', border: '1px solid var(--line-soft)',
  textAlign: 'center',
  transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
};

export const sidebarLabel: CSSProperties = {
  fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.28em',
  color: 'var(--ink-dim)', marginBottom: 6, fontWeight: 700,
};
