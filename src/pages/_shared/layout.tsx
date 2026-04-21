/**
 * Page layout primitives — the big containers every module page composes.
 *
 * `PageGrid` is a 12-column grid tuned to the 1350×~830 module canvas.
 * Pages express their macro layout by giving each direct child a `span`
 * and `rows` value. This keeps every page inside the same spatial rhythm
 * (12px gutters, identical vertical cadence) without each page rolling
 * its own CSS.
 */

import type { CSSProperties, ReactNode } from 'react';

export function PageGrid({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
        gap: 12,
        alignContent: 'start',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function PageCell({
  span = 12,
  rows,
  children,
  style,
}: {
  span?: number;
  rows?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        gridColumn: `span ${span}`,
        gridRow: rows ? `span ${rows}` : undefined,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Tab bar shared by pages that need tabs. */
export function TabBar<T extends string>({
  tabs, value, onChange,
}: {
  tabs: ReadonlyArray<{ id: T; label: string; count?: number | null }>;
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex', gap: 2,
        borderBottom: '1px solid var(--line-soft)',
        marginBottom: 4,
      }}
    >
      {tabs.map(t => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={t.count != null ? `${t.label} · ${t.count} runs this session` : undefined}
            onClick={() => onChange(t.id)}
            style={{
              all: 'unset', cursor: 'pointer',
              padding: '7px 14px',
              fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.22em',
              fontWeight: 700,
              color: active ? '#fff' : 'var(--ink-2)',
              background: active
                ? 'linear-gradient(180deg, rgba(57, 229, 255, 0.18), transparent)'
                : 'transparent',
              borderBottom: active ? '2px solid var(--cyan)' : '2px solid transparent',
              marginBottom: -1,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <span>{t.label}</span>
            {t.count != null && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                padding: '0 4px',
                border: '1px solid var(--line-soft)',
                lineHeight: 1.4,
              }}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Big number pill used across Today / Focus / Brain / Audit / ... */
export function StatBlock({
  label, value, sub, tone = 'cyan', onClick, ariaLabel,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'cyan' | 'amber' | 'green' | 'violet' | 'red' | 'pink' | 'gold' | 'teal' | 'lime';
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const color = `var(--${tone})`;
  const interactive = typeof onClick === 'function';
  const baseBg = 'rgba(6, 14, 22, 0.55)';
  const hoverBg = `${interactive ? 'rgba(57, 229, 255, 0.05)' : baseBg}`;
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={e => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); }
      }}
      onMouseEnter={e => { if (interactive) e.currentTarget.style.background = hoverBg; }}
      onMouseLeave={e => { if (interactive) e.currentTarget.style.background = baseBg; }}
      style={{
        border: '1px solid var(--line-soft)',
        borderLeft: `2px solid ${color}`,
        padding: '10px 14px',
        background: baseBg,
        display: 'flex', flexDirection: 'column', gap: 2,
        minWidth: 0,
        cursor: interactive ? 'pointer' : 'default',
        outline: 'none',
        transition: 'background 140ms ease, border-color 140ms ease',
      }}
    >
      <div style={{
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
        color: 'var(--ink-2)', fontWeight: 700,
      }}>{label}</div>
      <div style={{
        fontFamily: 'var(--display)', fontSize: 22, fontWeight: 800,
        color, letterSpacing: '0.04em', lineHeight: 1.1,
      }}>{value}</div>
      {sub && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>{sub}</div>
      )}
    </div>
  );
}

/** Scrollable list container that hides WebKit scrollbars (we style our own). */
export function ScrollList({
  children, maxHeight = 480, style,
}: {
  children: ReactNode;
  maxHeight?: number | string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="sunny-scroll"
      style={{
        maxHeight,
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingRight: 4,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
