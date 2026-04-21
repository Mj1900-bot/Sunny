import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { KIND_COLORS, KIND_GLYPHS, KIND_LABELS, ROTATION_HINT_DAYS } from './constants';
import { StrengthMeter } from './StrengthMeter';
import type { VaultItem } from './types';
import { useCapsLock } from './useCapsLock';
import { formatRelative, kindOf, maskLabelLength } from './utils';

type EditMode = 'none' | 'label' | 'rotate' | 'confirmDelete';

export function SecretCard({
  item,
  reveal,
  now,
  busy,
  pinned,
  onReveal,
  onHide,
  onCopy,
  onQuickCopy,
  onDelete,
  onRename,
  onRotate,
  onTogglePin,
}: {
  readonly item: VaultItem;
  readonly reveal: { readonly value: string; readonly until: number } | undefined;
  readonly now: number;
  readonly busy: boolean;
  readonly pinned: boolean;
  readonly onReveal: (id: string) => void;
  readonly onHide: (id: string) => void;
  readonly onCopy: (item: VaultItem) => void;
  readonly onQuickCopy: (item: VaultItem) => void;
  readonly onDelete: (id: string) => void;
  readonly onRename: (id: string, label: string) => Promise<void> | void;
  readonly onRotate: (id: string, value: string) => Promise<void> | void;
  readonly onTogglePin: (id: string) => void;
}) {
  const isRevealed = reveal !== undefined && reveal.until > now;
  const secondsLeft = isRevealed ? Math.max(0, Math.ceil((reveal.until - now) / 1000)) : 0;
  const kind = kindOf(item);
  const accent = KIND_COLORS[kind];

  const [mode, setMode] = useState<EditMode>('none');
  const [draftLabel, setDraftLabel] = useState<string>(item.label);
  const [draftValue, setDraftValue] = useState<string>('');
  const [showRotateValue, setShowRotateValue] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const capsOn = useCapsLock(mode === 'rotate');

  useEffect(() => {
    if (mode === 'label') {
      setDraftLabel(item.label);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    if (mode === 'rotate') {
      setDraftValue('');
      setShowRotateValue(false);
    }
    // Safer default for destructive confirm — CANCEL takes focus so a stray
    // Enter press does not destroy the secret.
    if (mode === 'confirmDelete') {
      cancelDeleteRef.current?.focus();
    }
  }, [mode, item.label]);

  // Keyboard shortcuts inside the destructive confirmation banner:
  //   Esc  → cancel
  //   ⌘/Ctrl + Enter → confirm delete (deliberate two-key combo)
  useEffect(() => {
    if (mode !== 'confirmDelete') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMode('none');
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onDelete(item.id);
        setMode('none');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, item.id, onDelete]);

  const lastTouched = item.updated_at ?? item.created_at;
  const ageDays = (Date.now() / 1000 - lastTouched) / 86400;
  const needsRotation =
    (kind === 'api_key' || kind === 'password' || kind === 'token') &&
    ageDays > ROTATION_HINT_DAYS;
  const revealCount = item.reveal_count ?? 0;

  const cardStyle: CSSProperties = {
    border: '1px solid var(--line-soft)',
    borderLeft: `2px solid ${accent}`,
    background: 'rgba(6, 14, 22, 0.55)',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minWidth: 0,
    position: 'relative',
    outline: pinned ? '1px solid rgba(255, 179, 71, 0.45)' : 'none',
  };

  const chipStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    border: `1px solid ${accent}`,
    color: accent,
    background: 'rgba(4, 10, 16, 0.6)',
    fontFamily: 'var(--mono)',
    fontSize: 9.5,
    letterSpacing: '0.15em',
  };

  const titleStyle: CSSProperties = {
    fontFamily: 'var(--display)',
    fontSize: 12,
    letterSpacing: '0.14em',
    color: 'var(--ink)',
    fontWeight: 600,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    paddingRight: 104,
    cursor: 'text',
  };

  const valueBox: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 11.5,
    color: isRevealed ? 'var(--cyan-2)' : 'var(--ink-dim)',
    background: 'rgba(4, 10, 16, 0.7)',
    border: '1px solid rgba(57, 229, 255, 0.12)',
    padding: '8px 10px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 72,
    overflow: 'auto',
    // Block drag-to-copy of the revealed secret. The Copy button is still
    // the only sanctioned clipboard path.
    userSelect: isRevealed ? 'none' : 'auto',
    WebkitUserSelect: isRevealed ? 'none' : 'auto',
  };

  const actionBtn = (
    tone: 'cyan' | 'red' | 'amber' | 'dim',
    disabled: boolean
  ): CSSProperties => {
    const col =
      tone === 'red'
        ? 'var(--red)'
        : tone === 'amber'
        ? 'var(--amber)'
        : tone === 'dim'
        ? 'var(--ink-dim)'
        : 'var(--cyan)';
    return {
      all: 'unset',
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontFamily: 'var(--mono)',
      fontSize: 9.5,
      letterSpacing: '0.18em',
      color: col,
      padding: '3px 8px',
      border: `1px solid ${col}`,
      textAlign: 'center',
      flex: 1,
      minWidth: 0,
      opacity: disabled ? 0.4 : 1,
    };
  };

  const createdLabel = formatRelative(item.created_at);
  const usedLabel =
    item.last_used_at !== null && item.last_used_at !== undefined
      ? `used ${formatRelative(item.last_used_at)}`
      : 'unused';
  const rotatedLabel =
    item.updated_at !== null && item.updated_at !== undefined
      ? `rotated ${formatRelative(item.updated_at)}`
      : null;

  async function submitRename() {
    const next = draftLabel.trim();
    if (next.length === 0 || next === item.label) {
      setMode('none');
      return;
    }
    await onRename(item.id, next);
    setMode('none');
  }

  async function submitRotate() {
    if (draftValue.length === 0) return;
    await onRotate(item.id, draftValue);
    setDraftValue('');
    setMode('none');
  }

  function confirmDelete() {
    onDelete(item.id);
    setMode('none');
  }

  return (
    <div style={cardStyle} onContextMenu={e => isRevealed && e.preventDefault()}>
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          display: 'flex',
          gap: 4,
          alignItems: 'center',
        }}
      >
        {needsRotation && (
          <span
            title={`Last touched ${Math.round(ageDays)}d ago — consider rotating`}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.15em',
              color: 'var(--amber)',
              border: '1px solid var(--amber)',
              padding: '1px 6px',
              background: 'rgba(255, 179, 71, 0.08)',
            }}
          >
            ROTATE
          </span>
        )}
        <button
          type="button"
          onClick={() => onTogglePin(item.id)}
          title={pinned ? 'unpin' : 'pin to top'}
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: pinned ? 'var(--amber)' : 'var(--ink-dim)',
            textShadow: pinned ? '0 0 6px rgba(255, 179, 71, 0.6)' : 'none',
          }}
        >
          {pinned ? '★' : '☆'}
        </button>
        <span style={chipStyle}>
          <span aria-hidden>{KIND_GLYPHS[kind]}</span>
          <span>{KIND_LABELS[kind]}</span>
        </span>
      </div>

      {mode === 'label' ? (
        <input
          ref={inputRef}
          type="text"
          value={draftLabel}
          onChange={e => setDraftLabel(e.target.value)}
          onBlur={submitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') void submitRename();
            if (e.key === 'Escape') setMode('none');
          }}
          style={{ fontFamily: 'var(--display)', fontSize: 12, letterSpacing: '0.14em' }}
          maxLength={200}
        />
      ) : (
        <div
          style={titleStyle}
          title={`${item.label} — double-click to rename`}
          onDoubleClick={() => setMode('label')}
        >
          {item.label}
        </div>
      )}

      <div style={valueBox} title={isRevealed ? reveal.value : undefined}>
        {isRevealed ? reveal.value : maskLabelLength(item.label)}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          color: 'var(--ink-dim)',
          letterSpacing: '0.08em',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span>added {createdLabel}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          {revealCount > 0 && (
            <span
              title="total reveals (lifetime)"
              style={{ color: revealCount > 20 ? 'var(--amber)' : 'var(--ink-dim)' }}
            >
              ⎔ {revealCount}
            </span>
          )}
          <span>{rotatedLabel ?? usedLabel}</span>
        </span>
      </div>

      {mode === 'rotate' && (
        <div
          style={{
            border: '1px solid var(--amber)',
            background: 'rgba(255, 179, 71, 0.05)',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                color: 'var(--amber)',
              }}
            >
              ROTATE — overwrites Keychain entry
            </div>
            {capsOn && (
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  color: 'var(--amber)',
                  letterSpacing: '0.14em',
                  border: '1px solid var(--amber)',
                  padding: '1px 5px',
                }}
              >
                ⇪ CAPS
              </span>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <textarea
              value={draftValue}
              onChange={e => setDraftValue(e.target.value)}
              rows={2}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder="new secret value"
              style={
                {
                  width: '100%',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  letterSpacing: showRotateValue ? '0.02em' : '0.3em',
                  WebkitTextSecurity: showRotateValue ? 'none' : 'disc',
                  resize: 'vertical',
                } as CSSProperties
              }
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowRotateValue(v => !v)}
              style={{
                all: 'unset',
                position: 'absolute',
                top: 4,
                right: 6,
                cursor: 'pointer',
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                letterSpacing: '0.18em',
                color: 'var(--ink-dim)',
                padding: '2px 6px',
                border: '1px solid var(--line-soft)',
                background: 'rgba(4, 10, 16, 0.7)',
              }}
            >
              {showRotateValue ? 'HIDE' : 'SHOW'}
            </button>
          </div>
          <StrengthMeter value={draftValue} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" style={actionBtn('dim', false)} onClick={() => setMode('none')}>
              CANCEL
            </button>
            <button
              type="button"
              style={actionBtn('amber', draftValue.length === 0)}
              onClick={submitRotate}
              disabled={draftValue.length === 0}
            >
              OVERWRITE
            </button>
          </div>
        </div>
      )}

      {mode === 'confirmDelete' && (
        <div
          style={{
            border: '1px solid var(--red)',
            background: 'rgba(255, 77, 94, 0.08)',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10.5,
              letterSpacing: '0.1em',
              color: 'var(--red)',
            }}
          >
            DELETE “{item.label}” from the Keychain?
          </div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              color: 'var(--ink-dim)',
            }}
          >
            This cannot be undone. The Keychain entry and index row will be removed.
            <span style={{ color: 'var(--ink-dim)', opacity: 0.7 }}>
              {' '}
              · Esc cancels · ⌘Enter confirms
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              ref={cancelDeleteRef}
              type="button"
              style={actionBtn('dim', false)}
              onClick={() => setMode('none')}
            >
              CANCEL
            </button>
            <button type="button" style={actionBtn('red', false)} onClick={confirmDelete}>
              DELETE
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={busy}
          style={actionBtn(isRevealed ? 'red' : 'cyan', busy)}
          onClick={() => (isRevealed ? onHide(item.id) : onReveal(item.id))}
          title={isRevealed ? 'hide now' : 'reveal for 10s'}
        >
          {isRevealed ? `HIDE · ${secondsLeft}s` : busy ? 'KEYCHAIN…' : 'REVEAL'}
        </button>
        <button
          type="button"
          disabled={busy}
          style={actionBtn(isRevealed ? 'cyan' : 'dim', busy)}
          onClick={() => (isRevealed ? onCopy(item) : onQuickCopy(item))}
          title={isRevealed ? 'copy revealed value' : 'reveal, copy, and hide in one step'}
        >
          {isRevealed ? 'COPY' : 'COPY →'}
        </button>
        <button
          type="button"
          style={actionBtn('amber', mode === 'rotate')}
          onClick={() => setMode(mode === 'rotate' ? 'none' : 'rotate')}
        >
          ROTATE
        </button>
        <button
          type="button"
          style={actionBtn('red', mode === 'confirmDelete')}
          onClick={() =>
            setMode(mode === 'confirmDelete' ? 'none' : 'confirmDelete')
          }
        >
          DELETE
        </button>
      </div>
    </div>
  );
}
