/**
 * RowMenu — 3-dot context menu for memory rows.
 * Actions: EDIT / DELETE / COPY / PIN.
 * Closes on Escape or click-outside.
 */

import { useEffect, useRef, useState, type JSX } from 'react';

export type RowAction = 'edit' | 'delete' | 'copy' | 'pin';

type Props = {
  onAction: (action: RowAction) => void;
  canEdit?: boolean;
  isPinned?: boolean;
};

const ACTIONS: ReadonlyArray<{ id: RowAction; label: (pinned: boolean) => string; color: string }> = [
  { id: 'edit', label: () => 'EDIT', color: 'var(--cyan)' },
  { id: 'copy', label: () => 'COPY', color: 'var(--ink-2)' },
  { id: 'pin', label: (p) => p ? 'UNPIN' : 'PIN', color: 'var(--gold)' },
  { id: 'delete', label: () => 'DELETE', color: 'var(--amber)' },
];

export function RowMenu({ onAction, canEdit = true, isPinned = false }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onOutside);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onOutside);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          all: 'unset',
          cursor: 'pointer',
          fontFamily: 'var(--mono)',
          fontSize: 13,
          color: 'var(--ink-dim)',
          padding: '2px 6px',
          lineHeight: 1,
          border: open ? '1px solid var(--line-soft)' : '1px solid transparent',
          borderRadius: 2,
          letterSpacing: 0,
          transition: 'color 120ms, border-color 120ms',
        }}
        onMouseEnter={e => { (e.currentTarget.style.color = 'var(--ink)'); }}
        onMouseLeave={e => { if (!open) (e.currentTarget.style.color = 'var(--ink-dim)'); }}
      >
        ···
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 2,
            zIndex: 50,
            background: 'rgba(4, 10, 18, 0.97)',
            border: '1px solid var(--line-soft)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            minWidth: 110,
          }}
        >
          {ACTIONS.filter(a => a.id !== 'edit' || canEdit).map(a => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              onClick={e => {
                e.stopPropagation();
                setOpen(false);
                onAction(a.id);
              }}
              style={{
                all: 'unset',
                cursor: 'pointer',
                display: 'block',
                padding: '7px 14px',
                fontFamily: 'var(--display)',
                fontSize: 9,
                letterSpacing: '0.18em',
                color: a.color,
                borderBottom: '1px solid var(--line-soft)',
                transition: 'background 100ms',
              }}
              onMouseEnter={e => { (e.currentTarget.style.background = 'rgba(57,229,255,0.06)'); }}
              onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); }}
            >
              {a.id === 'pin' ? (isPinned ? 'UNPIN' : 'PIN') : a.label(isPinned)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
