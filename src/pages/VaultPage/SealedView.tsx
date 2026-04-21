import { useEffect, type CSSProperties } from 'react';

/**
 * Honest locked view. The real security boundary is the macOS Keychain prompt
 * on first reveal — this screen just clears all in-memory revealed values
 * and forces an explicit "OPEN VAULT" click before any Keychain I/O.
 *
 * Previous versions accepted any passphrase and showed a fake strength meter;
 * that was theater. This one is plain about what it protects.
 */
export function SealedView({
  onUnseal,
  itemCount,
  autoSealedReason,
}: {
  readonly onUnseal: () => void;
  readonly itemCount: number;
  readonly autoSealedReason: 'manual' | 'idle' | 'initial' | 'blur' | 'panic';
}) {
  // Enter/Space/O opens the vault from the locked screen.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key.toLowerCase() === 'o') {
        e.preventDefault();
        onUnseal();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onUnseal]);

  const wrap: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 420,
  };

  const box: CSSProperties = {
    border: '1px solid var(--cyan)',
    background:
      'radial-gradient(circle at 50% 15%, rgba(57, 229, 255, 0.1), rgba(6, 14, 22, 0.9) 70%)',
    padding: '32px 40px',
    width: 540,
    maxWidth: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    alignItems: 'center',
    textAlign: 'center',
    boxShadow: '0 0 30px rgba(57, 229, 255, 0.15)',
    position: 'relative',
  };

  const padlock: CSSProperties = {
    fontFamily: 'var(--mono)',
    color: 'var(--cyan)',
    fontSize: 16,
    lineHeight: 1.15,
    letterSpacing: '0.1em',
    textShadow: '0 0 14px rgba(57, 229, 255, 0.55)',
    whiteSpace: 'pre',
  };

  const title: CSSProperties = {
    fontFamily: 'var(--display)',
    fontSize: 18,
    letterSpacing: '0.42em',
    color: 'var(--cyan)',
    fontWeight: 700,
    marginTop: 4,
  };

  const sub: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--ink-2)',
    maxWidth: 440,
    letterSpacing: '0.06em',
    lineHeight: 1.55,
  };

  const bullets: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: 6,
    width: '100%',
    textAlign: 'left',
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    color: 'var(--ink-dim)',
    letterSpacing: '0.06em',
    padding: '10px 14px',
    border: '1px dashed var(--line-soft)',
    background: 'rgba(4, 10, 16, 0.35)',
  };

  const unsealBtn: CSSProperties = {
    all: 'unset',
    cursor: 'pointer',
    padding: '12px 36px',
    border: '1px solid var(--cyan)',
    color: 'var(--cyan)',
    fontFamily: 'var(--display)',
    fontSize: 14,
    letterSpacing: '0.32em',
    fontWeight: 700,
    background: 'linear-gradient(90deg, rgba(57, 229, 255, 0.22), rgba(57, 229, 255, 0.04))',
    clipPath:
      'polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%, 14px 50%)',
    textAlign: 'center',
    minWidth: 220,
  };

  const reasonToneColor =
    autoSealedReason === 'panic'
      ? 'var(--red)'
      : autoSealedReason === 'idle' || autoSealedReason === 'blur'
      ? 'var(--amber)'
      : 'var(--ink-dim)';

  const reasonChip: CSSProperties = {
    position: 'absolute',
    top: 12,
    right: 14,
    fontFamily: 'var(--mono)',
    fontSize: 9,
    letterSpacing: '0.22em',
    color: reasonToneColor,
    border: `1px solid ${reasonToneColor}`,
    padding: '2px 8px',
  };

  const reasonText =
    autoSealedReason === 'idle'
      ? 'AUTO-SEALED · IDLE'
      : autoSealedReason === 'blur'
      ? 'AUTO-SEALED · FOCUS LOST'
      : autoSealedReason === 'panic'
      ? 'PANIC SEAL'
      : autoSealedReason === 'manual'
      ? 'SEALED'
      : 'SESSION LOCKED';

  return (
    <div style={wrap}>
      <div style={box}>
        <div style={reasonChip}>{reasonText}</div>
        <div style={padlock}>
          {'  ▁▂▃▃▂▁  \n ▕  ___  ▏ \n ▕ ▕   ▏ ▏ \n ▕▀▀▀▀▀▀▀▏ \n ▕   ◆   ▏ \n ▕▁▁▁▁▁▁▁▏ '}
        </div>
        <div style={title}>VAULT</div>
        <div style={sub}>
          {itemCount === 0
            ? 'No secrets stored yet. Open the vault to add your first Keychain-backed item.'
            : `${itemCount} Keychain item${itemCount === 1 ? '' : 's'} ready. Opening the vault doesn't reveal anything — macOS Keychain still prompts per-item on first access.`}
        </div>
        <div style={bullets}>
          <div>· values live in the macOS login Keychain, never plaintext on disk</div>
          <div>· each reveal auto-hides after 10s; clipboard clears after 10s</div>
          <div>· max 5 reveals per 60s, enforced on the backend</div>
          <div>· vault auto-seals after 5m of inactivity</div>
        </div>
        <button type="button" style={unsealBtn} onClick={onUnseal} autoFocus>
          OPEN VAULT
        </button>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9.5,
            color: 'var(--ink-dim)',
            letterSpacing: '0.22em',
          }}
        >
          ENTER · SPACE · O
        </div>
      </div>
    </div>
  );
}
