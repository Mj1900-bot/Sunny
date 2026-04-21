/**
 * Static style constants for ChatPanel.
 *
 * Extracted so ChatPanel.tsx stays under 400 lines.
 * Dynamic styles (sendBtnStyle, rememberHintStyle) are computed
 * inline in the component since they depend on runtime state.
 */
import type { CSSProperties } from 'react';
import type { Role } from './session';

export const ROLE_LABEL: Record<Role, string> = {
  user: 'USER',
  sunny: 'SUNNY',
  system: 'SYSTEM',
};

export const ROLE_BORDER: Record<Role, string> = {
  user: 'var(--amber)',
  sunny: 'var(--cyan)',
  system: 'var(--red)',
};

export const ROLE_WHO_COLOR: Record<Role, string> = {
  user: 'var(--amber)',
  sunny: 'var(--cyan)',
  system: 'var(--red)',
};

export const ROLE_BG: Record<Role, string> = {
  user: 'rgba(255, 179, 71, 0.05)',
  sunny: 'rgba(57, 229, 255, 0.04)',
  system: 'rgba(255, 77, 94, 0.06)',
};

export const bodyStyle: CSSProperties = {
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  overflow: 'hidden',
};

export const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingRight: 2,
};

export const formStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'stretch',
  borderTop: '1px solid var(--line-soft)',
  paddingTop: 8,
};

export const inputStyle: CSSProperties = {
  flex: 1,
  background: 'rgba(57, 229, 255, 0.04)',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink)',
  fontFamily: 'var(--label)',
  fontSize: 12,
  padding: '6px 8px',
  outline: 'none',
};

export const emptyStyle: CSSProperties = {
  color: 'var(--ink-dim)',
  fontFamily: 'var(--label)',
  fontSize: 12,
  padding: '8px 4px',
};

export const sessionRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-start',
  alignItems: 'center',
  gap: 6,
  paddingTop: 4,
};

export const msgTextStyle: CSSProperties = {
  fontFamily: 'var(--label)',
  fontSize: 12,
  lineHeight: 1.4,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

export const msgRoleStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.22em',
  fontWeight: 600,
};
