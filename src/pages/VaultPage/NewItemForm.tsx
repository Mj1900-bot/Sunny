import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { KIND_LABELS, KIND_ORDER } from './constants';
import { StrengthMeter } from './StrengthMeter';
import type { VaultKind } from './types';
import { useCapsLock } from './useCapsLock';
import { estimateEntropyBits, generateSecret } from './utils';

type Charsets = {
  readonly lower: boolean;
  readonly upper: boolean;
  readonly digits: boolean;
  readonly symbols: boolean;
};

const DEFAULT_CHARSETS: Charsets = {
  lower: true,
  upper: true,
  digits: true,
  symbols: false,
};

const KIND_HINTS: Readonly<Record<VaultKind, string>> = {
  api_key: 'e.g. Stripe live · OpenAI prod · Anthropic',
  password: 'e.g. GitHub · AWS console · database',
  token: 'e.g. GitHub PAT · Vercel · Supabase service role',
  ssh: 'e.g. laptop → production · CI deploy key',
  note: 'e.g. recovery phrase · license seed',
};

export function NewItemForm({
  onAdd,
  onCancel,
  busy,
  existingLabels,
}: {
  readonly onAdd: (kind: VaultKind, label: string, value: string) => void;
  readonly onCancel: () => void;
  readonly busy: boolean;
  readonly existingLabels: ReadonlyArray<string>;
}) {
  const [kind, setKind] = useState<VaultKind>('api_key');
  const [label, setLabel] = useState<string>('');
  const [value, setValue] = useState<string>('');
  const [showValue, setShowValue] = useState<boolean>(false);
  const [showGen, setShowGen] = useState<boolean>(false);
  const [genLen, setGenLen] = useState<number>(32);
  const [charsets, setCharsets] = useState<Charsets>(DEFAULT_CHARSETS);
  const [genPulse, setGenPulse] = useState<number>(0);

  const capsOn = useCapsLock(true);
  const canAdd = !busy && label.trim().length > 0 && value.length > 0;
  const entropy = useMemo(() => estimateEntropyBits(genLen, charsets), [genLen, charsets]);
  const entropyTone =
    entropy >= 128
      ? 'var(--green)'
      : entropy >= 80
      ? 'var(--cyan)'
      : entropy >= 50
      ? 'var(--amber)'
      : 'var(--red)';

  const duplicateLabel = useMemo(() => {
    const trimmed = label.trim().toLowerCase();
    if (trimmed.length === 0) return false;
    return existingLabels.some(l => l.toLowerCase() === trimmed);
  }, [label, existingLabels]);

  function submit() {
    if (!canAdd) return;
    onAdd(kind, label.trim(), value);
    setLabel('');
    setValue('');
    setShowValue(false);
  }

  function regenerate() {
    setValue(generateSecret(genLen, charsets));
    setShowValue(true);
    setGenPulse(p => p + 1);
  }

  function toggleCharset<K extends keyof Charsets>(k: K) {
    setCharsets(prev => ({ ...prev, [k]: !prev[k] }));
  }

  // Auto-generate the first time the generator opens if the value is empty.
  useEffect(() => {
    if (showGen && value.length === 0) {
      setValue(generateSecret(genLen, charsets));
      setShowValue(true);
      setGenPulse(p => p + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGen]);

  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '90px 1fr',
    gap: 10,
    alignItems: 'center',
    marginBottom: 8,
  };
  const labelStyle: CSSProperties = {
    fontFamily: 'var(--display)',
    fontSize: 10,
    letterSpacing: '0.22em',
    color: 'var(--cyan)',
  };
  const miniBtn = (active: boolean): CSSProperties => ({
    all: 'unset',
    cursor: 'pointer',
    padding: '3px 8px',
    fontFamily: 'var(--mono)',
    fontSize: 10,
    letterSpacing: '0.15em',
    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
    border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-soft)'}`,
    background: active ? 'rgba(57, 229, 255, 0.08)' : 'transparent',
  });

  return (
    <div
      className="section"
      style={{
        border: '1px solid var(--cyan)',
        background: 'rgba(57, 229, 255, 0.04)',
        padding: 12,
      }}
    >
      <div style={rowStyle}>
        <label htmlFor="vault-kind" style={labelStyle}>KIND</label>
        <select id="vault-kind" value={kind} onChange={e => setKind(e.target.value as VaultKind)}>
          {KIND_ORDER.map(k => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        <label htmlFor="vault-label" style={labelStyle}>LABEL</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <input
            id="vault-label"
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={KIND_HINTS[kind]}
            autoFocus
            maxLength={200}
            style={{
              borderColor: duplicateLabel ? 'var(--amber)' : undefined,
            }}
          />
          {duplicateLabel && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.1em',
                color: 'var(--amber)',
              }}
            >
              ⚠ a secret with this label already exists — you'll have duplicates
            </span>
          )}
        </div>
      </div>
      <div style={{ ...rowStyle, alignItems: 'start' }}>
        <label htmlFor="vault-value" style={labelStyle}>VALUE</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div
            style={{
              position: 'relative',
              boxShadow: genPulse > 0 ? 'inset 0 0 0 1px var(--cyan-2)' : 'none',
              transition: 'box-shadow 0.3s ease',
            }}
            key={`pulse-${genPulse}`}
          >
            <textarea
              id="vault-value"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="secret — stored in macOS Keychain, never plaintext on disk"
              rows={3}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              style={{
                resize: 'vertical',
                width: '100%',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                letterSpacing: showValue ? '0.02em' : '0.3em',
                WebkitTextSecurity: showValue ? 'none' : 'disc',
              } as CSSProperties}
            />
            <button
              type="button"
              onClick={() => setShowValue(v => !v)}
              title={showValue ? 'hide' : 'show'}
              style={{
                all: 'unset',
                position: 'absolute',
                top: 6,
                right: 8,
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.18em',
                color: 'var(--ink-dim)',
                padding: '2px 6px',
                border: '1px solid var(--line-soft)',
                background: 'rgba(4, 10, 16, 0.7)',
              }}
            >
              {showValue ? 'HIDE' : 'SHOW'}
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => setShowGen(v => !v)}
                style={miniBtn(showGen)}
              >
                {showGen ? '× GENERATOR' : 'GENERATE…'}
              </button>
              {capsOn && (
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: 'var(--amber)',
                    letterSpacing: '0.14em',
                    border: '1px solid var(--amber)',
                    padding: '2px 6px',
                  }}
                  title="Caps Lock is on"
                >
                  ⇪ CAPS
                </span>
              )}
            </div>
            <StrengthMeter value={value} />
          </div>

          {showGen && (
            <div
              style={{
                border: '1px solid var(--line-soft)',
                background: 'rgba(4, 10, 16, 0.55)',
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: 'var(--ink-dim)',
                    letterSpacing: '0.15em',
                    minWidth: 54,
                  }}
                >
                  LEN · {genLen}
                </span>
                <label htmlFor="vault-gen-length" className="sr-only">Generator length</label>
                <input
                  id="vault-gen-length"
                  type="range"
                  min={8}
                  max={96}
                  value={genLen}
                  onChange={e => setGenLen(parseInt(e.target.value, 10))}
                  style={{ flex: 1 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" style={miniBtn(charsets.lower)} onClick={() => toggleCharset('lower')}>
                  a–z
                </button>
                <button type="button" style={miniBtn(charsets.upper)} onClick={() => toggleCharset('upper')}>
                  A–Z
                </button>
                <button type="button" style={miniBtn(charsets.digits)} onClick={() => toggleCharset('digits')}>
                  0–9
                </button>
                <button type="button" style={miniBtn(charsets.symbols)} onClick={() => toggleCharset('symbols')}>
                  !@#$
                </button>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: '0.12em',
                    color: entropyTone,
                    alignSelf: 'center',
                  }}
                >
                  ~{entropy} bits at len {genLen}
                </span>
              </div>
              <button
                type="button"
                onClick={regenerate}
                className="primary"
                style={{ alignSelf: 'flex-start' }}
              >
                ⟳ REGENERATE
              </button>
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.18em',
            color: 'var(--ink-dim)',
            padding: '4px 10px',
            border: '1px solid var(--line-soft)',
          }}
        >
          CANCEL
        </button>
        <button
          type="button"
          className="primary"
          onClick={submit}
          style={canAdd ? undefined : { opacity: 0.4, pointerEvents: 'none' }}
        >
          {busy ? 'SAVING…' : 'ADD TO VAULT'}
        </button>
      </div>
    </div>
  );
}
