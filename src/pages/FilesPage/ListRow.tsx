import { useState } from 'react';
import { KIND_STYLES } from './utils';
import { RowBtn } from './components';
import { fmtRelative, fmtSize, kindColor, kindLabel } from './utils';
import type { Entry } from './types';

// ---------------------------------------------------------------------------
// ListRow — single row in the list view
// ---------------------------------------------------------------------------

export type ListRowProps = {
  entry: Entry;
  /** Odd/even banding for scanability in long directories. */
  stripe?: 'odd' | 'even';
  nowSecs: number;
  isSelected: boolean;
  isFocused: boolean;
  isRenaming: boolean;
  renameDraft: string;
  onRenameDraft: (s: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onClick: (e: Entry, ev: React.MouseEvent) => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onRename: () => void;
  onTrash: () => void;
  onDuplicate: () => void;
};

export function ListRow(props: ListRowProps) {
  const { entry: e, stripe, nowSecs, isSelected, isFocused, isRenaming } = props;
  const [hovered, setHovered] = useState(false);
  const kStyle = KIND_STYLES[kindColor(e)];
  const label = kindLabel(e);

  const band = stripe === 'odd' ? 'rgba(57, 229, 255, 0.03)' : stripe === 'even' ? 'transparent' : undefined;
  const bg = isSelected
    ? 'rgba(57, 229, 255, 0.12)'
    : isFocused
    ? 'rgba(57, 229, 255, 0.05)'
    : band;
  const outline = isFocused ? '1px solid rgba(57, 229, 255, 0.35)' : undefined;

  return (
    <div
      className="list-row"
      data-path={e.path}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={ev => {
        if (isRenaming) return;
        props.onClick(e, ev);
      }}
      onDoubleClick={() => {
        if (e.is_dir) return; // single-click already navigates
        props.onOpen();
      }}
      style={{
        gridTemplateColumns: '22px 72px 1fr 110px 130px',
        position: 'relative',
        background: bg,
        outline,
        outlineOffset: '-1px',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: isSelected ? 'var(--cyan)' : 'var(--ink-dim)',
          fontWeight: 700,
        }}
      >
        {isSelected ? '●' : '○'}
      </span>
      <span
        className="kind"
        style={{
          minWidth: 0,
          color: kStyle.color,
          border: `1px solid ${kStyle.border}`,
          background: kStyle.bg,
          padding: '2px 6px',
          textAlign: 'center',
          letterSpacing: '0.14em',
          fontWeight: 700,
          fontSize: 10,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {isRenaming ? (
        <input
          autoFocus
          type="text"
          value={props.renameDraft}
          onChange={ev => props.onRenameDraft(ev.target.value)}
          onClick={ev => ev.stopPropagation()}
          onKeyDown={ev => {
            ev.stopPropagation();
            if (ev.key === 'Enter') props.onRenameCommit();
            else if (ev.key === 'Escape') props.onRenameCancel();
          }}
          onBlur={props.onRenameCommit}
          spellCheck={false}
          style={{
            fontSize: 12,
            padding: '4px 8px',
            fontFamily: 'var(--mono)',
            width: '100%',
            boxSizing: 'border-box',
          }}
        />
      ) : (
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--label)',
            color: e.is_dir ? 'var(--ink)' : 'var(--ink-2)',
            fontWeight: e.is_dir ? 600 : 500,
          }}
        >
          {e.name}
        </span>
      )}
      <span className="meta" style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
        {e.is_dir ? '—' : fmtSize(e.size)}
      </span>
      <span className="meta" style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
        {fmtRelative(e.modified_secs, nowSecs)}
      </span>

      {hovered && !isRenaming && (
        <div
          onClick={ev => ev.stopPropagation()}
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            gap: 3,
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            background: 'rgba(4, 10, 16, 0.94)',
            border: '1px solid var(--line-soft)',
            padding: '2px 4px',
          }}
        >
          <RowBtn onClick={props.onOpen}>OPEN</RowBtn>
          <span style={{ color: 'var(--ink-dim)' }}>·</span>
          <RowBtn onClick={props.onReveal}>REVEAL</RowBtn>
          <span style={{ color: 'var(--ink-dim)' }}>·</span>
          <RowBtn onClick={props.onCopyPath}>COPY</RowBtn>
          <span style={{ color: 'var(--ink-dim)' }}>·</span>
          <RowBtn onClick={props.onRename}>RENAME</RowBtn>
          <span style={{ color: 'var(--ink-dim)' }}>·</span>
          <RowBtn onClick={props.onDuplicate}>DUPE</RowBtn>
          <span style={{ color: 'var(--ink-dim)' }}>·</span>
          <RowBtn onClick={props.onTrash} tone="red">TRASH</RowBtn>
        </div>
      )}
    </div>
  );
}
