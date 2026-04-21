// ─────────────────────────────────────────────────────────────────
// Empty state (shown when no jobs exist)
// ─────────────────────────────────────────────────────────────────

export function EmptyState() {
  return (
    <div
      style={{
        padding: 30,
        textAlign: 'center',
        border: '1px dashed rgba(57, 229, 255, 0.18)',
        background: 'rgba(6, 14, 22, 0.45)',
        color: 'var(--ink-dim)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        letterSpacing: '0.12em',
      }}
    >
      NO JOBS — CREATE YOUR FIRST AUTOMATION ABOVE
    </div>
  );
}
