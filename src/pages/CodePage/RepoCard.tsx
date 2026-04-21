/**
 * Visual rendering of a `git status --porcelain` line.
 *
 * Porcelain format is two status chars + space + path (with optional
 * `->` rename arrow). We colour the two-char code by kind so the eye
 * can scan dirtiness at a glance.
 *
 * Premium features:
 *  · Click-to-select for file preview integration
 *  · Fade-in animation per line
 *  · Hover highlight
 *  · Grouped stage indicator
 */

import { Chip } from '../_shared';

type Kind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'other';

const KIND_TONE: Record<Kind, 'green' | 'amber' | 'red' | 'violet' | 'cyan' | 'dim'> = {
  added: 'green',
  modified: 'amber',
  deleted: 'red',
  renamed: 'violet',
  untracked: 'cyan',
  conflict: 'red',
  other: 'dim',
};

const KIND_LABEL: Record<Kind, string> = {
  added: 'ADDED',
  modified: 'MOD',
  deleted: 'DEL',
  renamed: 'RENAME',
  untracked: 'NEW',
  conflict: 'CONFLICT',
  other: '??',
};

function classify(code: string): Kind {
  if (code === '??') return 'untracked';
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflict';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  if (code.includes('D')) return 'deleted';
  if (code.includes('M')) return 'modified';
  return 'other';
}

/** Determine if a file is staged based on the first character. */
function isStaged(rawCode: string): boolean {
  const idx = rawCode[0];
  return idx !== '?' && idx !== ' ';
}

export function StatusLine({
  raw, onSelect, index,
}: {
  raw: string;
  onSelect?: (path: string) => void;
  index?: number;
}) {
  const code = raw.slice(0, 2).trim() || '??';
  const path = raw.slice(3).trim();
  const kind = classify(raw.slice(0, 2));
  const tone = KIND_TONE[kind];
  const staged = isStaged(raw.slice(0, 2));
  const interactive = typeof onSelect === 'function';

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={() => onSelect?.(path)}
      onKeyDown={e => {
        if (interactive && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect?.(path); }
      }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 8px',
        borderLeft: `2px solid var(--${tone === 'dim' ? 'line-soft' : tone})`,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background 100ms ease',
        animation: index !== undefined ? `fadeSlideIn ${150 + (index * 30)}ms ease-out` : undefined,
      }}
      onMouseEnter={e => {
        if (interactive) e.currentTarget.style.background = 'rgba(57, 229, 255, 0.05)';
      }}
      onMouseLeave={e => {
        if (interactive) e.currentTarget.style.background = 'transparent';
      }}
    >
      <Chip tone={tone}>{KIND_LABEL[kind]}</Chip>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
        flexShrink: 0,
      }}>{code.padEnd(2, ' ')}</span>
      {/* Stage indicator */}
      {staged && (
        <span
          title="Staged"
          style={{
            width: 5, height: 5, borderRadius: '50%',
            background: 'var(--green)',
            boxShadow: '0 0 4px var(--green)',
            flexShrink: 0,
          }}
        />
      )}
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flex: 1, minWidth: 0,
      }} title={path}>{path}</span>
    </div>
  );
}

/** Summary chips showing kinds of dirty files. */
export function StatusSummary({
  statusLines,
}: {
  statusLines: ReadonlyArray<string>;
}) {
  if (statusLines.length === 0) return null;

  const counts: Partial<Record<Kind, number>> = {};
  for (const line of statusLines) {
    const kind = classify(line.slice(0, 2));
    counts[kind] = (counts[kind] ?? 0) + 1;
  }

  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {(Object.entries(counts) as [Kind, number][]).map(([k, v]) => (
        <Chip key={k} tone={KIND_TONE[k]}>
          {v} {KIND_LABEL[k]}
        </Chip>
      ))}
    </div>
  );
}
