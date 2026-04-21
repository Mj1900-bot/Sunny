export function FallbackNotice() {
  return (
    <div
      className="section"
      style={{
        padding: 24,
        textAlign: 'center',
        fontFamily: 'var(--mono)',
        color: 'var(--ink-dim)',
        fontSize: 11,
        letterSpacing: '0.1em',
        border: '1px solid var(--amber)',
        background: 'rgba(255, 179, 71, 0.05)',
      }}
    >
      VAULT requires the Tauri runtime. This is the browser preview — Keychain access is
      unavailable.
    </div>
  );
}
