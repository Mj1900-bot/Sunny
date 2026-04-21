/**
 * VaultHelpOverlay — Keyboard shortcuts and vault info.
 */

import type { CSSProperties } from 'react';

export function VaultHelpOverlay({ onClose }: { readonly onClose: () => void }) {
  const row: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '90px 1fr',
    gap: 14,
    fontFamily: 'var(--mono)',
    fontSize: 11,
    letterSpacing: '0.08em',
    color: 'var(--ink-2)',
    padding: '4px 0',
  };
  const keyStyle: CSSProperties = {
    fontFamily: 'var(--mono)',
    color: 'var(--cyan)',
    letterSpacing: '0.14em',
  };
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(2, 6, 10, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          border: '1px solid var(--cyan)',
          background: 'rgba(6, 14, 22, 0.95)',
          padding: '22px 28px',
          minWidth: 420,
          maxWidth: '90%',
          boxShadow: '0 0 30px rgba(57, 229, 255, 0.15)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--display)',
            fontSize: 12,
            letterSpacing: '0.3em',
            color: 'var(--cyan)',
            marginBottom: 14,
          }}
        >
          VAULT SHORTCUTS
        </div>
        <div style={row}><span style={keyStyle}>/</span><span>focus search</span></div>
        <div style={row}><span style={keyStyle}>Enter</span><span>in search — copy if exactly one match</span></div>
        <div style={row}><span style={keyStyle}>n</span><span>toggle new-item form</span></div>
        <div style={row}><span style={keyStyle}>?</span><span>open / close this help</span></div>
        <div style={row}><span style={keyStyle}>Esc</span><span>close help → form → clear search → seal</span></div>
        <div style={row}><span style={keyStyle}>⌘/Ctrl + L</span><span>panic seal — immediate</span></div>
        <div style={row}><span style={keyStyle}>⌘/Ctrl + Enter</span><span>in delete-confirm — commit delete</span></div>
        <div style={row}><span style={keyStyle}>2× click</span><span>title to rename in place</span></div>
        <div style={row}><span style={keyStyle}>COPY →</span><span>flash-reveal, copy, hide in 600ms</span></div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9.5,
            color: 'var(--ink-dim)',
            letterSpacing: '0.1em',
            marginTop: 12,
          }}
        >
          Press ? or click anywhere to close.
        </div>
      </div>
    </div>
  );
}
