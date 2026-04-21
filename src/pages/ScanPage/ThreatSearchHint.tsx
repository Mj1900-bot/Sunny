/**
 * ThreatSearchHint — dropdown that surfaces the power-search syntax
 * for the threat-DB search field.
 *
 * Rendered as a small [?] button that toggles an anchored hint panel below
 * the search input. Contains syntax tokens with examples.
 */
import { useState, type CSSProperties } from 'react';

type Props = {
  readonly onInsert?: (token: string) => void;
};

const TOKENS: ReadonlyArray<{ prefix: string; example: string; desc: string }> = [
  { prefix: 'year:', example: 'year:2024', desc: 'Filter by year first seen' },
  { prefix: 'cat:', example: 'cat:prompt_injection', desc: 'Filter by category (malware_family | malicious_script | prompt_injection | agent_exfil)' },
  { prefix: 'platform:', example: 'platform:macos', desc: 'Filter by target platform' },
  { prefix: 'cve:', example: 'cve:CVE-2024', desc: 'Filter by CVE reference' },
];

const hintPanelStyle: CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  zIndex: 100,
  marginTop: 4,
  border: '1px solid var(--line-soft)',
  background: 'rgba(4, 10, 16, 0.96)',
  padding: '10px 12px',
  minWidth: 340,
  boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '130px 1fr',
  gap: 6,
  alignItems: 'start',
  marginBottom: 6,
};

const tokenStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--cyan)',
  letterSpacing: '0.06em',
  cursor: 'pointer',
  padding: '2px 6px',
  border: '1px solid rgba(57, 229, 255, 0.3)',
  background: 'rgba(57, 229, 255, 0.06)',
  userSelect: 'none',
};

const descStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  color: 'var(--ink-dim)',
  letterSpacing: '0.04em',
  lineHeight: 1.4,
};

const btnStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '0 6px',
  height: 26,
  lineHeight: '26px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.06)',
  color: 'var(--ink-dim)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.12em',
};

export function ThreatSearchHint({ onInsert }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        style={{ ...btnStyle, color: open ? 'var(--cyan)' : 'var(--ink-dim)' }}
        onClick={() => setOpen(o => !o)}
        title="Power-search syntax help"
        aria-expanded={open}
      >
        SYNTAX
      </button>

      {open && (
        <div style={hintPanelStyle} role="tooltip">
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.22em',
              color: 'var(--cyan)',
              marginBottom: 8,
            }}
          >
            POWER SEARCH TOKENS
          </div>
          {TOKENS.map(({ prefix, example, desc }) => (
            <div key={prefix} style={rowStyle}>
              <span
                role="button"
                tabIndex={0}
                style={tokenStyle}
                title="Click to insert"
                onClick={() => { onInsert?.(example); setOpen(false); }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onInsert?.(example);
                    setOpen(false);
                  }
                }}
              >
                {example}
              </span>
              <span style={descStyle}>{desc}</span>
            </div>
          ))}
          <div
            style={{
              ...descStyle,
              marginTop: 8,
              borderTop: '1px solid var(--line-soft)',
              paddingTop: 6,
            }}
          >
            Combine with free text: <span style={{ color: 'var(--cyan)' }}>stealer year:2024 cat:malware_family</span>
          </div>
        </div>
      )}
    </div>
  );
}
