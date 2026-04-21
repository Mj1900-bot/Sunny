/**
 * PendingDot — a small amber dot shown next to a control while an optimistic
 * update is awaiting server confirmation.
 */

import type { CSSProperties } from 'react';

type Props = { readonly active: boolean };

export function PendingDot({ active }: Props) {
  if (!active) return null;
  return (
    <span
      role="status"
      aria-label="saving"
      style={dotStyle}
      title="Saving…"
    />
  );
}

const dotStyle: CSSProperties = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--amber)',
  marginLeft: 4,
  verticalAlign: 'middle',
  opacity: 0.85,
};
