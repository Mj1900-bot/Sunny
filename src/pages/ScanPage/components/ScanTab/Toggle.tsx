import { DISPLAY_FONT, hintStyle } from '../../styles';

export function Toggle({
  label,
  desc,
  value,
  onChange,
  disabled,
}: {
  label: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
      style={{
        all: 'unset',
        cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${value ? 'var(--cyan)' : 'var(--line-soft)'}`,
        background: value ? 'rgba(57, 229, 255, 0.08)' : 'rgba(6, 14, 22, 0.4)',
        padding: '10px 12px',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 10,
        alignItems: 'start',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: 2,
          border: `1px solid ${value ? 'var(--cyan)' : 'var(--line-soft)'}`,
          background: value ? 'var(--cyan)' : 'transparent',
          marginTop: 3,
        }}
      />
      <span>
        <div
          style={{
            fontFamily: DISPLAY_FONT,
            fontSize: 10,
            letterSpacing: '0.22em',
            color: value ? 'var(--cyan)' : 'var(--ink)',
            fontWeight: 700,
          }}
        >
          {label}
        </div>
        <div style={{ ...hintStyle, marginTop: 2 }}>{desc}</div>
      </span>
    </button>
  );
}
