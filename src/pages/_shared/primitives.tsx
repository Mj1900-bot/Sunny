/**
 * Shared page primitives — low-level building blocks every module page
 * can compose into richer layouts. All styles are inline-CSS to avoid
 * polluting the global stylesheet; they echo the HUD chrome (cyan ink,
 * hairline borders, Orbitron caps for sectioning, JetBrains for data).
 *
 * Keep each primitive single-purpose and ≤50 lines so pages can mix
 * them freely without fighting the compositor.
 */

import { forwardRef, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';

// ---------- PageLead (module intro) ---------------------------------------

/** One-line context under the module title — sets expectations without repeating the H3. */
export function PageLead({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
        lineHeight: 1.55, maxWidth: 52 * 16,
        padding: '2px 2px 6px 14px',
        borderLeft: '2px solid rgba(57, 229, 255, 0.35)',
        marginBottom: 2,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------- FilterInput (consistent search / filter) ----------------------

/** Mono search field with focus ring — use for in-page filters (not form submissions). */
/** Mono search field with focus ring — use for in-page filters (not form submissions). */
export const FilterInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function FilterInput({ style, onFocus, onBlur, ...rest }, ref) {
    return (
      <input
        ref={ref}
      {...rest}
      style={{
        all: 'unset', boxSizing: 'border-box',
        flex: 1, minWidth: 0,
        padding: '7px 12px',
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
        border: '1px solid var(--line-soft)',
        background: 'rgba(0, 0, 0, 0.35)',
        transition: 'border-color 140ms ease, box-shadow 140ms ease',
        ...style,
      }}
      onFocus={e => {
        e.currentTarget.style.borderColor = 'var(--cyan)';
        e.currentTarget.style.boxShadow = '0 0 0 1px rgba(57, 229, 255, 0.12)';
        onFocus?.(e);
      }}
      onBlur={e => {
        e.currentTarget.style.borderColor = 'var(--line-soft)';
        e.currentTarget.style.boxShadow = 'none';
        onBlur?.(e);
      }}
    />
  );
});

// ---------- Section ---------------------------------------------------------

type SectionProps = {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
};

export function Section({ title, right, children, style }: SectionProps) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
      <header
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
          color: 'var(--cyan)', fontWeight: 700,
          borderBottom: '1px solid var(--line-soft)', paddingBottom: 6,
        }}
      >
        <span>{title}</span>
        {right && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            gap: 8, flexWrap: 'wrap',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
            color: 'var(--ink-2)',
          }}>
            {right}
          </div>
        )}
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </section>
  );
}

// ---------- Card (bordered sub-panel) --------------------------------------

export function Card({
  children,
  accent,
  onClick,
  style,
  interactive,
}: {
  children: ReactNode;
  accent?: 'cyan' | 'amber' | 'violet' | 'green' | 'red' | 'pink' | 'gold' | 'teal' | 'blue' | 'lime';
  onClick?: () => void;
  style?: CSSProperties;
  interactive?: boolean;
}) {
  const color = accent ? `var(--${accent})` : 'var(--line-soft)';
  const border = accent ? `1px solid rgba(57, 229, 255, 0.22)` : '1px solid var(--line-soft)';
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={e => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); }
      }}
      style={{
        position: 'relative',
        border,
        borderLeft: accent ? `2px solid ${color}` : border,
        background: 'rgba(6, 14, 22, 0.55)',
        padding: '10px 12px',
        cursor: (interactive || onClick) ? 'pointer' : 'default',
        transition: 'background 140ms ease, border-color 140ms ease',
        ...style,
      }}
      onMouseEnter={e => {
        if (interactive || onClick) (e.currentTarget.style.background = 'rgba(57, 229, 255, 0.06)');
      }}
      onMouseLeave={e => {
        if (interactive || onClick) (e.currentTarget.style.background = 'rgba(6, 14, 22, 0.55)');
      }}
    >
      {children}
    </div>
  );
}

// ---------- Chip (label tag) ------------------------------------------------

export function Chip({
  children,
  tone = 'cyan',
  style,
  title,
}: {
  children: ReactNode;
  tone?: 'cyan' | 'amber' | 'violet' | 'green' | 'red' | 'pink' | 'gold' | 'teal' | 'blue' | 'lime' | 'dim';
  style?: CSSProperties;
  title?: string;
}) {
  const color = tone === 'dim' ? 'var(--ink-dim)' : `var(--${tone})`;
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 7px',
        border: `1px solid ${color}`, color,
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.18em',
        fontWeight: 700, textTransform: 'uppercase',
        background: 'rgba(0, 0, 0, 0.25)',
        lineHeight: 1.3,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ---------- Row (key/value line) -------------------------------------------

export function Row({
  label, value, right, tone, onClick, title,
}: {
  label: ReactNode;
  value?: ReactNode;
  right?: ReactNode;
  tone?: 'amber' | 'green' | 'violet' | 'red';
  /** When set, row is keyboard-focusable and shows hover affordance. */
  onClick?: () => void;
  title?: string;
}) {
  const interactive = typeof onClick === 'function';
  const baseBg = tone ? 'rgba(57, 229, 255, 0.03)' : 'transparent';
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={title}
      onClick={onClick}
      onKeyDown={e => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
      onMouseEnter={e => {
        if (!interactive) return;
        e.currentTarget.style.background = 'rgba(57, 229, 255, 0.07)';
      }}
      onMouseLeave={e => {
        if (!interactive) return;
        e.currentTarget.style.background = baseBg;
      }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 8px',
        borderLeft: tone ? `2px solid var(--${tone})` : '2px solid transparent',
        background: baseBg,
        cursor: interactive ? 'pointer' : 'default',
        outline: 'none',
        transition: 'background 120ms ease',
      }}
    >
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10.5,
        color: 'var(--ink-2)', letterSpacing: '0.06em',
        flex: '0 0 auto', minWidth: 92,
      }}>{label}</span>
      <span style={{
        flex: '1 1 auto',
        fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
      {right && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', flexShrink: 0 }}>{right}</span>
      )}
    </div>
  );
}

// ---------- EmptyState ------------------------------------------------------

export function EmptyState({
  title, hint, icon,
}: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '28px 18px', textAlign: 'center',
      border: '1px dashed var(--line-soft)',
      background: 'rgba(57, 229, 255, 0.02)',
    }}>
      {icon && <div style={{ color: 'var(--cyan)', opacity: 0.5, marginBottom: 8 }}>{icon}</div>}
      <div style={{
        fontFamily: 'var(--display)', fontSize: 11, letterSpacing: '0.24em',
        color: 'var(--cyan)', fontWeight: 700, marginBottom: 4,
      }}>{title}</div>
      {hint && <div style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', maxWidth: 360, lineHeight: 1.5,
      }}>{hint}</div>}
    </div>
  );
}

// ---------- MetricBar -------------------------------------------------------

export function MetricBar({
  label, value, pct, tone = 'cyan',
}: {
  label: string;
  value?: ReactNode;
  pct: number;
  tone?: 'cyan' | 'amber' | 'green' | 'violet' | 'red';
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)', letterSpacing: '0.1em' }}>
          {label}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)', fontWeight: 600 }}>
          {value}
        </span>
      </div>
      <div style={{ height: 4, background: 'rgba(57, 229, 255, 0.08)', position: 'relative', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute', inset: 0,
          width: `${clamped}%`,
          background: `linear-gradient(90deg, var(--${tone}), transparent)`,
          boxShadow: `0 0 8px var(--${tone})`,
          transition: 'width 280ms ease',
        }} />
      </div>
    </div>
  );
}

// ---------- Toolbar (inline row of actions) --------------------------------

export function Toolbar({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...style,
    }}>
      {children}
    </div>
  );
}

export function ToolbarButton({
  children, onClick, active, disabled, tone = 'cyan', title,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  tone?: 'cyan' | 'amber' | 'violet' | 'green' | 'red' | 'pink' | 'gold' | 'teal' | 'blue' | 'lime';
  title?: string;
}) {
  const color = `var(--${tone})`;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      style={{
        all: 'unset', cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.2em', fontWeight: 700,
        color: disabled ? 'var(--ink-dim)' : (active ? '#fff' : color),
        padding: '4px 10px',
        border: `1px solid ${disabled ? 'var(--line-soft)' : color}`,
        background: active ? `${color}33` : 'rgba(0, 0, 0, 0.3)',
        transition: 'background 140ms ease, color 140ms ease',
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={e => { if (!disabled) (e.currentTarget.style.background = `${color}22`); }}
      onMouseLeave={e => {
        if (!disabled) (e.currentTarget.style.background = active ? `${color}33` : 'rgba(0, 0, 0, 0.3)');
      }}
    >
      {children}
    </button>
  );
}

// ---------- NavLink (styled "open X" affordance) ----------------------------

/** Subtle jump-to link with arrow — replaces ad-hoc underlined spans. */
export function NavLink({
  children,
  onClick,
  tone = 'cyan',
  style,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'cyan' | 'amber' | 'violet' | 'green' | 'gold' | 'pink' | 'dim';
  style?: CSSProperties;
}) {
  const color = tone === 'dim' ? 'var(--ink-dim)' : `var(--${tone})`;
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
        color, opacity: 0.8,
        padding: '1px 4px',
        borderBottom: '1px solid transparent',
        transition: 'opacity 140ms ease, border-color 140ms ease',
        ...style,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.opacity = '1';
        e.currentTarget.style.borderBottomColor = color;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.opacity = '0.8';
        e.currentTarget.style.borderBottomColor = 'transparent';
      }}
    >
      <span>{children}</span>
      <span style={{ fontSize: 9, opacity: 0.85 }}>›</span>
    </button>
  );
}

// ---------- DayProgress (horizontal progress through the day) ---------------

/** Thin bar under a header showing elapsed portion of the current day. */
export function DayProgress({
  nowMs,
  tone = 'cyan',
  height = 2,
}: {
  nowMs: number;
  tone?: 'cyan' | 'amber' | 'gold' | 'violet' | 'green';
  height?: number;
}) {
  const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const elapsed = Math.max(0, Math.min(86_400_000, nowMs - dayStart));
  const pct = (elapsed / 86_400_000) * 100;
  const color = `var(--${tone})`;
  return (
    <div
      aria-label="Day progress"
      style={{ position: 'relative', height, background: 'rgba(57, 229, 255, 0.05)', overflow: 'hidden' }}
    >
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: `${pct}%`,
        background: `linear-gradient(90deg, transparent, ${color})`,
        boxShadow: `0 0 6px ${color}`,
        transition: 'width 600ms ease',
      }} />
    </div>
  );
}

// ---------- ProgressRing (radial progress indicator) ------------------------

/** Radial progress — used by focus timer when a target duration is set. */
export function ProgressRing({
  progress,
  size = 180,
  stroke = 4,
  tone = 'cyan',
  children,
}: {
  /** 0..1 */
  progress: number;
  size?: number;
  stroke?: number;
  tone?: 'cyan' | 'amber' | 'green' | 'violet' | 'red' | 'gold';
  children?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(1, progress));
  const radius = (size - stroke) / 2;
  const c = 2 * Math.PI * radius;
  const color = `var(--${tone})`;
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'inline-block' }}>
      <svg width={size} height={size} style={{ display: 'block', transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none"
          stroke="rgba(57, 229, 255, 0.08)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped)}
          style={{
            transition: 'stroke-dashoffset 400ms ease',
            filter: `drop-shadow(0 0 4px ${color})`,
          }}
        />
      </svg>
      {children && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ---------- Avatar (initial bubble with warmth ring) ----------------------

/** Produces a deterministic tone from a string so each contact gets a
 *  stable colour without needing a palette lookup. */
const AVATAR_TONES = ['cyan', 'violet', 'green', 'amber', 'pink', 'gold', 'teal', 'blue', 'lime'] as const;
function avatarTone(seed: string): typeof AVATAR_TONES[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  name,
  size = 32,
  ring,
  active,
  style,
}: {
  name: string;
  size?: number;
  /** Optional outer ring colour tone (e.g. warmth). */
  ring?: 'green' | 'amber' | 'red' | 'cyan' | 'dim';
  /** When true, pulses softly to draw attention. */
  active?: boolean;
  style?: CSSProperties;
}) {
  const tone = avatarTone(name || 'unknown');
  const color = `var(--${tone})`;
  const ringColor = ring && ring !== 'dim' ? `var(--${ring})` : ring === 'dim' ? 'var(--line-soft)' : undefined;
  return (
    <div
      aria-hidden
      style={{
        width: size, height: size,
        flexShrink: 0,
        borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--display)',
        fontSize: Math.max(10, Math.round(size * 0.38)),
        fontWeight: 700, letterSpacing: '0.04em',
        color: '#050a10',
        background: `linear-gradient(135deg, ${color} 10%, rgba(6, 14, 22, 0.8) 140%)`,
        boxShadow: ringColor
          ? `0 0 0 1.5px ${ringColor}, 0 0 8px ${ringColor}55`
          : `0 0 0 1px ${color}55`,
        animation: active ? 'pulseDot 2s ease-in-out infinite' : undefined,
        ...style,
      }}
    >
      {initials(name)}
    </div>
  );
}

// ---------- KeyHint (kbd-style shortcut pill) -----------------------------

export function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd style={{
      fontFamily: 'var(--mono)', fontSize: 9.5,
      color: 'var(--cyan)',
      border: '1px solid var(--line-soft)',
      padding: '1px 5px',
      background: 'rgba(6, 14, 22, 0.65)',
      letterSpacing: '0.04em',
      fontWeight: 600,
      lineHeight: 1.4,
    }}>{children}</kbd>
  );
}

// ---------- Sparkline (mini SVG trend chart) --------------------------------

export function Sparkline({
  values,
  width = 80,
  height = 24,
  tone = 'cyan',
  filled = false,
}: {
  values: ReadonlyArray<number>;
  width?: number;
  height?: number;
  tone?: 'cyan' | 'amber' | 'green' | 'violet' | 'red' | 'gold';
  filled?: boolean;
}) {
  if (values.length < 2) {
    return <svg width={width} height={height} style={{ display: 'block' }} />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    return `${x},${y}`;
  });
  const polyline = pts.join(' ');
  const color = `var(--${tone})`;
  const fillPts = `0,${height} ${polyline} ${width},${height}`;
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {filled && (
        <polygon
          points={fillPts}
          fill={color}
          opacity={0.08}
        />
      )}
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.85}
      />
      {values.length > 0 && (() => {
        const last = pts[pts.length - 1].split(',');
        return (
          <circle
            cx={parseFloat(last[0])}
            cy={parseFloat(last[1])}
            r={2.5}
            fill={color}
            opacity={0.9}
          />
        );
      })()}
    </svg>
  );
}
