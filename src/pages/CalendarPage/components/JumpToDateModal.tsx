import { useEffect, useRef, useState } from 'react';
import { navBtnStyle } from '../styles';

type Props = {
  onJump: (iso: string) => void;
  onClose: () => void;
};

export function JumpToDateModal({ onJump, onClose }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleSubmit() {
    const trimmed = value.trim();
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    if (!valid) {
      setError('FORMAT: YYYY-MM-DD');
      return;
    }
    const d = new Date(trimmed + 'T00:00:00');
    if (Number.isNaN(d.getTime())) {
      setError('INVALID DATE');
      return;
    }
    onJump(trimmed);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="jump-date-title"
        style={{
          border: '1px solid var(--cyan)',
          background: 'rgba(4, 10, 16, 0.97)',
          padding: '20px 24px',
          minWidth: 280,
          display: 'flex', flexDirection: 'column', gap: 12,
          boxShadow: '0 0 40px rgba(57, 229, 255, 0.18)',
        }}>
        <div id="jump-date-title" style={{
          fontFamily: 'var(--display)', fontSize: 11,
          letterSpacing: '0.24em', color: 'var(--cyan)', fontWeight: 700,
        }}>
          JUMP TO DATE
        </div>
        <input
          ref={inputRef}
          id="jump-date-input"
          type="text"
          aria-label="Jump to date"
          aria-describedby={error ? 'jump-date-error' : undefined}
          value={value}
          onChange={e => { setValue(e.target.value); setError(''); }}
          onKeyDown={handleKeyDown}
          placeholder="2026-05-03"
          style={{ fontFamily: 'var(--mono)', fontSize: 13 }}
        />
        {error && (
          <div id="jump-date-error" role="alert" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)', letterSpacing: '0.12em' }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="primary" onClick={handleSubmit} style={{ flex: 1 }}>GO</button>
          <button type="button" aria-label="Close dialog" onClick={onClose} style={{ ...navBtnStyle, flex: 1, padding: '6px 8px' }}>ESC</button>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.1em' }}>
          PRESS G TO OPEN · ENTER TO JUMP · ESC TO CLOSE
        </div>
      </div>
    </div>
  );
}
