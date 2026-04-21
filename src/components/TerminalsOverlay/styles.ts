// TerminalsOverlay/styles.ts
//
// Shared CSSProperties, color map, layout types, and small utilities
// consumed by Sidebar, TileGrid, and the overlay shell.

import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LayoutMode = 'grid' | 'rows' | 'cols' | 'single';

// ---------------------------------------------------------------------------
// Color palette for terminal color-tags.
// ---------------------------------------------------------------------------

export const TERMINAL_COLORS: Record<string, string> = {
  cyan: '#39e5ff',
  amber: '#ffb347',
  green: '#7dff9a',
  violet: '#b48cff',
  magenta: '#ff6fcf',
  red: '#ff4d5e',
};

export const COLOR_NAMES = Object.keys(TERMINAL_COLORS) as ReadonlyArray<string>;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function shortenPath(path: string): string {
  const home = '/Users/';
  if (path.startsWith(home)) {
    const rest = path.slice(home.length);
    const slash = rest.indexOf('/');
    return slash >= 0 ? `~${rest.slice(slash)}` : '~';
  }
  if (path.length > 32) return `…${path.slice(path.length - 31)}`;
  return path;
}

// ---------------------------------------------------------------------------
// Style constants — colours reference CSS custom-properties so the HUD
// theme switcher re-tints the overlay live.
// ---------------------------------------------------------------------------

export const WINDOW_HEADER: CSSProperties = {
  flex: '0 0 auto',
  height: 38,
  padding: '0 12px 0 18px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: '1px solid rgba(57,229,255,0.10)',
  background: 'linear-gradient(180deg, rgba(57,229,255,0.05) 0%, rgba(57,229,255,0.015) 100%)',
  cursor: 'grab',
  userSelect: 'none',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: 'var(--cyan)',
};

export const SHELL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  background: 'rgba(2, 6, 10, 0.82)',
  backdropFilter: 'blur(28px) saturate(140%)',
  WebkitBackdropFilter: 'blur(28px) saturate(140%)',
  border: '1px solid rgba(57,229,255,0.18)',
  borderRadius: 'inherit',
  boxShadow:
    '0 0 0 1px rgba(0,0,0,0.6), 0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(57,229,255,0.08)',
  fontFamily: 'var(--mono)',
  overflow: 'hidden',
};

export const SIDEBAR: CSSProperties = {
  flex: '0 0 280px',
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid rgba(57,229,255,0.08)',
  minHeight: 0,
  background: 'rgba(4,10,14,0.45)',
};

export const SIDEBAR_HEADER: CSSProperties = {
  padding: '18px 20px 14px',
  borderBottom: '1px solid rgba(57,229,255,0.08)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

export const SIDEBAR_TITLE: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.28em',
  textTransform: 'uppercase',
  color: 'var(--cyan)',
  fontWeight: 600,
};

export const RIGHT_PANE: CSSProperties = {
  flex: '1 1 auto',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
};

export const HEADER_BAR: CSSProperties = {
  flex: '0 0 auto',
  height: 44,
  padding: '0 20px',
  borderBottom: '1px solid rgba(57,229,255,0.08)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: 'var(--cyan)',
  background: 'rgba(57,229,255,0.02)',
};

export const PILL_BTN: CSSProperties = {
  padding: '3px 10px',
  border: '1px solid rgba(57,229,255,0.18)',
  background: 'rgba(57,229,255,0.05)',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  borderRadius: 4,
  transition: 'background 120ms ease, border-color 120ms ease',
};

export const ADD_BTN: CSSProperties = {
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '14px 20px',
  margin: 0,
  width: '100%',
  border: 0,
  borderTop: '1px solid rgba(57,229,255,0.08)',
  background: 'rgba(57,229,255,0.03)',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background 120ms ease',
};

export const RENAME_INPUT: CSSProperties = {
  width: '100%',
  padding: '2px 6px',
  border: '1px solid var(--cyan)',
  background: 'rgba(57,229,255,0.08)',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  outline: 'none',
  borderRadius: 2,
};

export const FILTER_INPUT: CSSProperties = {
  width: '100%',
  padding: '7px 12px 7px 28px',
  border: '1px solid rgba(57,229,255,0.10)',
  background: 'rgba(57,229,255,0.03)',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  outline: 'none',
  borderRadius: 4,
  boxSizing: 'border-box',
};

export const EMPTY_STATE: CSSProperties = {
  gridColumn: '1 / -1',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'column',
  gap: 18,
  padding: 48,
  color: 'rgba(230,248,255,0.55)',
  fontFamily: 'var(--mono)',
};

export const TAB_STRIP: CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'stretch',
  gap: 0,
  padding: '0 14px',
  borderBottom: '1px solid rgba(57,229,255,0.08)',
  background: 'rgba(57,229,255,0.01)',
  overflowX: 'auto',
  overflowY: 'hidden',
  scrollbarWidth: 'none',
  fontFamily: 'var(--mono)',
};

export const STATUS_BAR: CSSProperties = {
  flex: '0 0 auto',
  height: 34,
  padding: '0 20px',
  borderTop: '1px solid rgba(57,229,255,0.08)',
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  color: 'rgba(230,248,255,0.45)',
  background: 'rgba(57,229,255,0.015)',
};

export const RESIZE_HANDLE: CSSProperties = {
  flex: '0 0 auto',
  width: 6,
  cursor: 'col-resize',
  background: 'transparent',
  position: 'relative',
  zIndex: 2,
  transition: 'background 120ms ease',
};

// ---------------------------------------------------------------------------
// Date utility
// ---------------------------------------------------------------------------

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
