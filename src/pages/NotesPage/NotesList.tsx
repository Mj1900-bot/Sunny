import type { KeyboardEvent } from 'react';
import { ScrollList, EmptyState, relTime } from '../_shared';
import type { Note } from './api';

export function NotesList({
  notes, selectedId, onSelect, onNavigate,
}: {
  notes: ReadonlyArray<Note>;
  selectedId: string | null;
  onSelect: (n: Note) => void;
  /** Arrow-key handler. +1 = next, -1 = prev. */
  onNavigate?: (dir: 1 | -1) => void;
}) {
  if (notes.length === 0) {
    return <EmptyState title="No notes" hint="Create one on the right, or grant Notes.app access." />;
  }

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onNavigate) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate(-1); }
  };

  return (
    <div tabIndex={0} onKeyDown={handleKey} style={{ outline: 'none' }} role="listbox" aria-label="Notes">
    <ScrollList maxHeight={620} style={{ gap: 0 }}>
      {notes.map(n => {
        const active = n.id === selectedId;
        const modTs = n.modified ? new Date(n.modified).getTime() / 1000 : null;
        return (
          <button
            key={n.id}
            role="option"
            aria-selected={active}
            onClick={() => onSelect(n)}
            style={{
              all: 'unset', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: 3,
              padding: '8px 12px',
              borderLeft: active ? '2px solid var(--violet)' : '2px solid transparent',
              background: active
                ? 'linear-gradient(90deg, rgba(180, 140, 255, 0.14), transparent)'
                : 'transparent',
              borderBottom: '1px solid var(--line-soft)',
            }}
          >
            <div style={{
              fontFamily: 'var(--label)', fontSize: 13,
              color: active ? '#fff' : 'var(--ink)', fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{n.name || '(untitled)'}</div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{(n.body || '').slice(0, 110)}</div>
            <div style={{
              fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
              color: 'var(--ink-dim)', display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{n.folder}</span>
              {modTs && <span>{relTime(modTs)}</span>}
            </div>
          </button>
        );
      })}
    </ScrollList>
    </div>
  );
}
