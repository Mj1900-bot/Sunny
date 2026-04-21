import type React from 'react';
import type { SortKey, SortDir } from './types';

// ---------------------------------------------------------------------------
// Sidebar / chrome sub-components
// ---------------------------------------------------------------------------

export function SectionHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        fontFamily: 'var(--display)',
        fontSize: 9,
        letterSpacing: '0.3em',
        color: 'var(--cyan)',
        fontWeight: 700,
        padding: '2px 4px',
      }}
    >
      {label}
    </div>
  );
}

export function SidebarButton({
  label, sub, active, onClick, onRemove,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: onRemove ? '1fr auto' : '1fr',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <button
        onClick={onClick}
        title={sub}
        style={{
          all: 'unset',
          boxSizing: 'border-box',
          cursor: 'pointer',
          padding: '6px 10px',
          border: '1px solid var(--line-soft)',
          background: active ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.4)',
          color: active ? 'var(--cyan)' : 'var(--ink-2)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          fontWeight: active ? 700 : 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </button>
      {onRemove && (
        <button
          onClick={onRemove}
          title="unpin"
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '6px 8px',
            border: '1px solid var(--line-soft)',
            color: 'var(--ink-dim)',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function NavButton({
  onClick, disabled, active, children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        all: 'unset',
        boxSizing: 'border-box',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '6px 8px',
        border: '1px solid var(--line-soft)',
        background: active ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.4)',
        color: disabled ? 'var(--ink-dim)' : 'var(--cyan)',
        fontFamily: 'var(--mono)',
        fontSize: 10,
        letterSpacing: '0.18em',
        fontWeight: 700,
        display: 'block',
        width: '100%',
        textAlign: 'center',
      }}
    >
      {children}
    </button>
  );
}

export function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '4px 9px',
        border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-soft)'}`,
        background: active ? 'rgba(57, 229, 255, 0.14)' : 'rgba(6, 14, 22, 0.4)',
        color: active ? 'var(--cyan)' : 'var(--ink-2)',
        fontFamily: 'var(--mono)',
        fontSize: 10,
        letterSpacing: '0.14em',
        fontWeight: active ? 700 : 500,
      }}
    >
      {label}
    </button>
  );
}

export function ToolbarBtn({
  onClick, tone = 'cyan', children,
}: {
  onClick: () => void;
  tone?: 'cyan' | 'red';
  children: React.ReactNode;
}) {
  const color = tone === 'red' ? 'var(--red)' : 'var(--cyan)';
  const border = tone === 'red' ? 'rgba(255, 77, 94, 0.35)' : 'var(--line-soft)';
  const bg = tone === 'red' ? 'rgba(255, 77, 94, 0.08)' : 'rgba(6, 14, 22, 0.4)';
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '4px 9px',
        border: `1px solid ${border}`,
        background: bg,
        color,
        fontFamily: 'var(--mono)',
        fontSize: 10,
        letterSpacing: '0.14em',
        fontWeight: 700,
      }}
    >
      {children}
    </button>
  );
}

export function SortHeader({
  label, k, sortKey, sortDir, onSort, align,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey, d: SortDir) => void;
  align?: 'left' | 'right';
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === 'asc' ? '▲' : '▼') : '';
  return (
    <button
      onClick={() => {
        if (active) onSort(k, sortDir === 'asc' ? 'desc' : 'asc');
        else onSort(k, 'asc');
      }}
      style={{
        all: 'unset',
        cursor: 'pointer',
        fontFamily: 'var(--display)',
        fontSize: 10,
        letterSpacing: '0.22em',
        color: active ? 'var(--cyan)' : 'var(--ink-dim)',
        fontWeight: 700,
        textAlign: align ?? 'left',
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 4,
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 8, opacity: active ? 1 : 0.4 }}>{arrow || '·'}</span>
    </button>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: '80px 20px',
        textAlign: 'center',
        fontFamily: 'var(--display)',
        letterSpacing: '0.4em',
        color: 'var(--ink-dim)',
        fontSize: 14,
        fontWeight: 700,
      }}
    >
      {label}
    </div>
  );
}

export function RowBtn({
  onClick, tone = 'cyan', children,
}: {
  onClick: () => void;
  tone?: 'cyan' | 'red';
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '3px 6px',
        color: tone === 'red' ? 'var(--red)' : 'var(--cyan)',
        fontFamily: 'var(--mono)',
        fontSize: 10,
        letterSpacing: '0.14em',
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}
