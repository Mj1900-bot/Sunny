/**
 * IdentityCard — visual persona card + editable fields.
 *
 * Upgraded with:
 *  - Visual persona "badge" with initial avatar and gradient
 *  - Character counter on voice field
 *  - Focus ring on inputs
 *  - Compact field layout
 */

import { Section } from '../_shared';
import { MarkdownPreview } from './MarkdownPreview';
import type { Identity } from './api';

const INPUT_STYLE: React.CSSProperties = {
  all: 'unset', boxSizing: 'border-box', width: '100%',
  padding: '8px 12px',
  fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(0, 0, 0, 0.3)',
  transition: 'border-color 150ms ease, box-shadow 150ms ease',
};

function handleFocus(e: React.FocusEvent<HTMLElement>) {
  e.currentTarget.style.borderColor = 'var(--cyan)';
  e.currentTarget.style.boxShadow = '0 0 8px rgba(57, 229, 255, 0.15)';
}
function handleBlurStyle(e: React.FocusEvent<HTMLElement>) {
  e.currentTarget.style.borderColor = 'var(--line-soft)';
  e.currentTarget.style.boxShadow = 'none';
}

export function IdentityCard({
  value, onChange, onBlur,
}: {
  value: Identity;
  onChange: (v: Identity) => void;
  onBlur?: (v: Identity) => void;
}) {
  const commit = (v: Identity) => onBlur?.(v);
  const initial = value.name.charAt(0).toUpperCase() || '?';

  return (
    <Section title="IDENTITY" right="who Sunny is">
      {/* Persona hero badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '14px 16px', marginBottom: 12,
        border: '1px solid var(--line-soft)',
        borderLeft: '3px solid var(--cyan)',
        background: 'linear-gradient(135deg, rgba(57, 229, 255, 0.06), transparent 60%)',
      }}>
        {/* Avatar circle */}
        <div style={{
          width: 52, height: 52, borderRadius: '50%', flexShrink: 0,
          background: 'linear-gradient(135deg, var(--cyan) 0%, var(--violet) 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 0 16px rgba(57, 229, 255, 0.25), inset 0 0 12px rgba(0,0,0,0.3)',
          animation: 'pulseDot 3s ease-in-out infinite',
        }}>
          <span style={{
            fontFamily: 'var(--display)', fontSize: 22, fontWeight: 800,
            color: 'var(--bg)', letterSpacing: '0.04em',
          }}>{initial}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 18, fontWeight: 800,
            color: 'var(--ink)', letterSpacing: '0.04em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {value.name || 'Unnamed'}
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-dim)',
            marginTop: 2,
          }}>
            operated by <span style={{ color: 'var(--violet)' }}>{value.operator || '—'}</span>
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
            marginTop: 3,
          }}>
            voice: {value.voice ? `${value.voice.length} chars` : 'not set'}
          </div>
        </div>
      </div>

      {/* Editable fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{
            fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
            color: 'var(--ink-2)', fontWeight: 700,
          }}>NAME</span>
          <input
            value={value.name}
            onChange={e => onChange({ ...value, name: e.target.value })}
            onBlur={e => { handleBlurStyle(e); commit({ ...value, name: e.target.value }); }}
            onFocus={handleFocus}
            aria-label="name"
            placeholder="What should this AI be called?"
            style={INPUT_STYLE}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{
            fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
            color: 'var(--ink-2)', fontWeight: 700,
          }}>OPERATOR</span>
          <input
            value={value.operator}
            onChange={e => onChange({ ...value, operator: e.target.value })}
            onBlur={e => { handleBlurStyle(e); commit({ ...value, operator: e.target.value }); }}
            onFocus={handleFocus}
            aria-label="operator"
            placeholder="Who owns / operates this AI?"
            style={INPUT_STYLE}
          />
        </label>

        {/* Voice — multiline with live markdown preview */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
                color: 'var(--ink-2)', fontWeight: 700,
              }}>VOICE</span>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                color: value.voice.length > 500 ? 'var(--amber)' : 'var(--ink-dim)',
              }}>
                {value.voice.length} chars
              </span>
            </div>
            <textarea
              value={value.voice}
              onChange={e => onChange({ ...value, voice: e.target.value })}
              onBlur={e => { handleBlurStyle(e); commit({ ...value, voice: e.target.value }); }}
              onFocus={handleFocus}
              rows={4}
              aria-label="voice"
              placeholder="Describe the AI's personality, tone, and communication style…"
              style={{
                ...INPUT_STYLE,
                minHeight: 80, resize: 'vertical',
              }}
            />
          </label>

          {/* Live preview */}
          {value.voice.trim() && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.2em',
                color: 'var(--violet)', fontWeight: 700,
              }}>LIVE PREVIEW</span>
              <MarkdownPreview text={value.voice} />
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
