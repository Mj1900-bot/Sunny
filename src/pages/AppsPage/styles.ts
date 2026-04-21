import type { CSSProperties } from 'react';

export const tileNameStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  color: 'var(--ink)',
  letterSpacing: '0.04em',
  lineHeight: 1.3,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  width: '100%',
  transition: 'padding-right 0.15s ease',
};

export const catTagStyle: CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.05)',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.18em',
};

export const iconRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  alignSelf: 'flex-start',
};

export const iconImgStyle: CSSProperties = {
  width: 20,
  height: 20,
  objectFit: 'contain',
  display: 'block',
  imageRendering: 'auto',
};

export const iconPlaceholderStyle: CSSProperties = {
  width: 20,
  height: 20,
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.04)',
  display: 'block',
};

export const runningDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: 'var(--green)',
  boxShadow: '0 0 6px rgba(125, 255, 154, 0.8)',
  display: 'inline-block',
};

export const launchCountStyle: CSSProperties = {
  position: 'absolute',
  bottom: 8,
  left: 10,
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.14em',
  color: 'var(--ink-dim)',
  opacity: 0.7,
};

export const starBtnStyle: CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  all: 'unset',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: '2px 4px',
  color: 'var(--ink-dim)',
  transition: 'color 0.15s ease',
};

export const rowActionStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '3px 7px',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  fontWeight: 600,
};

export const rowActionRedStyle: CSSProperties = {
  ...rowActionStyle,
  color: 'var(--red)'
};

export const chipRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginBottom: 4,
  alignItems: 'center',
};

export const chipBtnBase: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.55)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  letterSpacing: '0.12em',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

export const chipBtnActive: CSSProperties = {
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.1)',
};

export const chipCountStyle: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.1em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
};

export const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
  gap: 10,
};

export const emptyStyle: CSSProperties = {
  padding: '40px 8px',
  textAlign: 'center',
  fontFamily: 'var(--display)',
  fontSize: 13,
  letterSpacing: '0.28em',
  color: 'var(--ink-dim)',
};

export const toolbarBtnStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.4)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  fontWeight: 600,
};

export const toolbarBtnActive: CSSProperties = {
  ...toolbarBtnStyle,
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.12)',
};

export const focusedPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  border: '1px solid rgba(125, 255, 154, 0.35)',
  background: 'rgba(125, 255, 154, 0.06)',
  color: 'var(--green)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.16em',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const retryBtnStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 12px',
  marginLeft: 10,
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.08)',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.16em',
  fontWeight: 700,
};

export const shortcutBarStyle: CSSProperties = {
  padding: '6px 2px',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.14em',
  color: 'var(--ink-dim)',
  display: 'flex',
  gap: 14,
  flexWrap: 'wrap',
};
