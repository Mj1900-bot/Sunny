import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { RegionInput, ScreenSize } from '../types';
import { actionBtn, ghostBtn, labelSmall } from '../styles';

export type RegionFormProps = {
  value: RegionInput;
  onChange: (v: RegionInput) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  screenSize: ScreenSize | null;
};

export function RegionForm({ value, onChange, onSubmit, onCancel, busy, screenSize }: RegionFormProps) {
  const input: CSSProperties = {
    all: 'unset',
    width: 72,
    padding: '5px 8px',
    border: '1px solid var(--line-soft)',
    background: 'rgba(6,14,22,0.6)',
    color: 'var(--ink)',
    fontFamily: 'var(--mono)',
    fontSize: 11,
    textAlign: 'center',
  };

  // Integer-parse each field once so we can validate + show a diagnostic
  // without repeating the parse-and-check in three places.
  const parsed = {
    x: Number.parseInt(value.x, 10),
    y: Number.parseInt(value.y, 10),
    w: Number.parseInt(value.w, 10),
    h: Number.parseInt(value.h, 10),
  };
  const allFinite =
    Number.isFinite(parsed.x) && Number.isFinite(parsed.y) &&
    Number.isFinite(parsed.w) && Number.isFinite(parsed.h);
  const valid = allFinite && parsed.w >= 1 && parsed.h >= 1;
  const outOfBounds =
    valid && screenSize
      ? parsed.x < 0 || parsed.y < 0 ||
        parsed.x + parsed.w > screenSize.w ||
        parsed.y + parsed.h > screenSize.h
      : false;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && valid && !busy) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: 10,
        border: '1px solid var(--line-soft)',
        background: 'rgba(57,229,255,0.04)',
        flexWrap: 'wrap',
      }}
    >
      <span style={labelSmall}>REGION · POINTS</span>
      <input
        style={input}
        placeholder="X"
        inputMode="numeric"
        value={value.x}
        onKeyDown={onKeyDown}
        onChange={e => onChange({ ...value, x: e.target.value })}
      />
      <input
        style={input}
        placeholder="Y"
        inputMode="numeric"
        value={value.y}
        onKeyDown={onKeyDown}
        onChange={e => onChange({ ...value, y: e.target.value })}
      />
      <input
        style={input}
        placeholder="W"
        inputMode="numeric"
        value={value.w}
        onKeyDown={onKeyDown}
        onChange={e => onChange({ ...value, w: e.target.value })}
      />
      <input
        style={input}
        placeholder="H"
        inputMode="numeric"
        value={value.h}
        onKeyDown={onKeyDown}
        onChange={e => onChange({ ...value, h: e.target.value })}
      />
      <button
        onClick={onSubmit}
        disabled={busy || !valid}
        style={{ ...actionBtn, padding: '5px 12px', opacity: !valid ? 0.4 : 1 }}
        title={valid ? 'Capture this region' : 'Enter integers with W,H ≥ 1'}
      >
        CAPTURE
      </button>
      <button onClick={onCancel} style={{ ...ghostBtn, padding: '5px 12px' }}>
        CANCEL
      </button>
      {outOfBounds && (
        <span style={{ ...labelSmall, color: 'var(--amber)' }}>
          OUT OF BOUNDS · SCREEN IS {screenSize!.w}×{screenSize!.h}pt
        </span>
      )}
      {screenSize && !outOfBounds && (
        <span style={{ ...labelSmall, marginLeft: 'auto' }}>
          SCREEN · {screenSize.w}×{screenSize.h} pt
        </span>
      )}
    </div>
  );
}
