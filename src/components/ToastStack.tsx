import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useToastStore, type Toast, type ToastKind } from '../store/toasts';

const COLORS: Record<ToastKind, string> = {
  success: 'var(--cyan)',
  error: 'var(--red, rgb(255, 82, 82))',
  info: 'var(--amber)',
};

const LABELS: Record<ToastKind, string> = {
  success: 'OK',
  error: 'ERR',
  info: 'INFO',
};

const STACK_STYLE: CSSProperties = {
  position: 'fixed',
  right: 18,
  bottom: 18,
  width: 280,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  zIndex: 9999,
  pointerEvents: 'none',
};

function ToastCard({ toast }: { readonly toast: Toast }) {
  const dismiss = useToastStore(s => s.dismiss);
  const [entered, setEntered] = useState(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    raf.current = requestAnimationFrame(() => setEntered(true));
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, []);

  const color = COLORS[toast.kind];

  const cardStyle: CSSProperties = {
    border: `1px solid ${color}`,
    background: 'rgba(5, 15, 22, 0.95)',
    padding: 10,
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color,
    boxShadow: `0 0 12px ${color}22, 0 6px 18px rgba(0,0,0,0.55)`,
    transform: entered ? 'translateX(0)' : 'translateX(100%)',
    opacity: entered ? 1 : 0,
    transition: 'transform 220ms ease-out, opacity 220ms ease-out',
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    lineHeight: 1.4,
  };

  const labelStyle: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.18em',
    color,
    flexShrink: 0,
  };

  const textStyle: CSSProperties = {
    flex: 1,
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color,
    wordBreak: 'break-word',
  };

  const dismissStyle: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color,
    fontFamily: 'var(--mono)',
    fontSize: 12,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
    opacity: 0.7,
  };

  return (
    <div style={cardStyle}>
      <span style={labelStyle}>{LABELS[toast.kind]}</span>
      <span style={textStyle}>{toast.text}</span>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismiss(toast.id)}
        style={dismissStyle}
      >
        ×
      </button>
    </div>
  );
}

export function ToastStack() {
  const toasts = useToastStore(s => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div style={STACK_STYLE} aria-live="polite" aria-atomic="false">
      {toasts.map(t => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
