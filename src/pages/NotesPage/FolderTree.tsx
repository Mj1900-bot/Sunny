/**
 * Folder sidebar for NotesPage.
 * Shows each folder as a chip with a count badge.
 * Highlights the currently-selected folder.
 */

import { Chip } from '../_shared';

type Props = {
  readonly folders: ReadonlyArray<string>;
  readonly noteCounts: Readonly<Record<string, number>>;
  readonly totalCount: number;
  readonly selected: string;
  readonly onSelect: (folder: string) => void;
};

export function FolderTree({ folders, noteCounts, totalCount, selected, onSelect }: Props) {
  const all = [{ name: '', label: 'ALL NOTES', count: totalCount }, ...folders.map(f => ({ name: f, label: f, count: noteCounts[f] ?? 0 }))];

  return (
    <div style={{
      border: '1px solid var(--line-soft)',
      borderLeft: '2px solid var(--violet)',
      background: 'rgba(6,14,22,0.55)',
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <div style={{
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
        color: 'var(--violet)', fontWeight: 700,
        borderBottom: '1px solid var(--line-soft)', paddingBottom: 6, marginBottom: 4,
      }}>FOLDERS</div>
      {all.map(item => {
        const active = item.name === selected;
        return (
          <button
            key={item.name || '__all__'}
            onClick={() => onSelect(item.name)}
            style={{
              all: 'unset', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '5px 8px',
              borderLeft: active ? '2px solid var(--violet)' : '2px solid transparent',
              background: active ? 'rgba(180,140,255,0.12)' : 'transparent',
              transition: 'background 100ms ease',
            }}
          >
            <span style={{
              fontFamily: 'var(--label)', fontSize: 12,
              color: active ? '#fff' : 'var(--ink-2)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{item.label}</span>
            <Chip tone={active ? 'violet' : 'dim'} style={{ fontSize: 9, padding: '1px 5px' }}>
              {item.count}
            </Chip>
          </button>
        );
      })}
    </div>
  );
}
