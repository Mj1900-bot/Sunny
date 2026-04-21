// Shared style primitives for the SettingsPage tabs.
//
// Every tab used to declare its own `chipBase` / `sectionStyle` / etc. in
// local `CSSProperties` consts. That was fine when there were three tabs;
// with seven tabs and a lot of repeated rows (labels, chips, hints),
// lifting the shared looks here keeps the UI consistent and the files
// readable.
//
// All exports are plain object literals — no CSS-in-JS runtime, no extra
// deps, just CSSProperties that play nicely with React's `style` prop.

import type { CSSProperties } from 'react';

export const DISPLAY_FONT = "'Orbitron', var(--mono)";

/** Outer card — one per logical settings section. */
export const sectionStyle: CSSProperties = {
  marginBottom: 14,
  padding: 16,
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.4)',
};

/** Section title ("CONNECTION", "AI PROVIDER", …). */
export const sectionTitleStyle: CSSProperties = {
  fontFamily: DISPLAY_FONT,
  fontSize: 11,
  letterSpacing: '0.28em',
  color: 'var(--cyan)',
  fontWeight: 700,
  marginTop: 0,
  marginBottom: 12,
  textTransform: 'uppercase',
};

/** Small uppercase label above form rows. */
export const labelStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.2em',
  color: 'var(--ink-dim)',
  marginBottom: 6,
  textTransform: 'uppercase',
};

/** Generic horizontal row — chips, buttons, readouts. */
export const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
};

/** Two-column responsive grid for the first-page layout. */
export const twoColGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  gap: 14,
};

/** Full-width text input / number input. */
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

/** Segmented-control chip (inactive). */
export const chipBase: CSSProperties = {
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

/** Chip when selected — spread on top of `chipBase`. */
export const chipActive: CSSProperties = {
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.12)',
  fontWeight: 700,
};

/** Helper: `chipBase` + `chipActive` if selected, otherwise just `chipBase`. */
export function chipStyle(active: boolean): CSSProperties {
  return active ? { ...chipBase, ...chipActive } : chipBase;
}

/** Muted explanatory text under a control. */
export const hintStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--ink-dim)',
  lineHeight: 1.5,
  marginTop: 6,
};

/** Inline status pill ("CONNECTED", "MISSING", …). */
export function statusPillStyle(color: string): CSSProperties {
  return {
    fontFamily: 'var(--mono)',
    fontSize: 10,
    letterSpacing: '0.22em',
    padding: '2px 8px',
    border: `1px solid ${color}`,
    color,
    background: 'rgba(0, 0, 0, 0.25)',
    textTransform: 'uppercase',
  };
}

/** Left-padded inline <code> / path blob. */
export const codeStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--cyan)',
  padding: '1px 6px',
  background: 'rgba(0, 0, 0, 0.3)',
  border: '1px solid rgba(120, 170, 200, 0.15)',
};

/** Primary call-to-action button (Save, Test, …). */
export const primaryBtnStyle: CSSProperties = {
  ...chipBase,
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.1)',
  padding: '6px 14px',
  fontWeight: 700,
};

/** Danger button (Reset, Delete, Reset TCC, …). */
export const dangerBtnStyle: CSSProperties = {
  ...chipBase,
  borderColor: 'rgba(255, 77, 94, 0.55)',
  color: 'var(--red)',
  background: 'rgba(255, 77, 94, 0.06)',
};

/** Empty-state placeholder row. */
export const emptyStateStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
  letterSpacing: '0.22em',
  textAlign: 'center',
  padding: '20px 12px',
  border: '1px dashed var(--line-soft)',
};
