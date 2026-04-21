import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/tauri';
import { IMG_EXTS } from './constants';
import { KIND_STYLES } from './utils';
import { fmtRelative, fmtSize, getExt, kindColor, kindLabel } from './utils';
import type { Entry } from './types';

// ---------------------------------------------------------------------------
// GridTile — single tile in grid view
// ---------------------------------------------------------------------------

export function GridTile({
  entry: e, nowSecs, isSelected, onClick,
}: {
  entry: Entry;
  nowSecs: number;
  isSelected: boolean;
  onClick: (e: Entry, ev: React.MouseEvent) => void;
}) {
  const kStyle = KIND_STYLES[kindColor(e)];
  const label = kindLabel(e);
  const ext = getExt(e.name);
  const isImg = IMG_EXTS.has(ext);

  return (
    <div
      data-path={e.path}
      onClick={ev => onClick(e, ev)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: 10,
        gap: 6,
        border: `1px solid ${isSelected ? 'var(--cyan)' : 'var(--line-soft)'}`,
        background: isSelected ? 'rgba(57, 229, 255, 0.1)' : 'rgba(6, 14, 22, 0.45)',
        cursor: 'pointer',
        textAlign: 'center',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%',
          aspectRatio: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: kStyle.bg,
          border: `1px solid ${kStyle.border}`,
          color: kStyle.color,
          fontFamily: 'var(--display)',
          fontSize: 12,
          letterSpacing: '0.18em',
          fontWeight: 700,
          overflow: 'hidden',
        }}
      >
        {isImg && isTauri ? (
          <img
            src={convertFileSrc(e.path)}
            alt={e.name}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : e.is_dir ? 'DIR' : (ext ? `.${ext}` : 'FILE').toUpperCase()}
      </div>
      <div
        style={{
          width: '100%',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={e.name}
      >
        {e.name}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          color: 'var(--ink-dim)',
          letterSpacing: '0.12em',
        }}
      >
        {e.is_dir ? label : `${fmtSize(e.size)} · ${fmtRelative(e.modified_secs, nowSecs)}`}
      </div>
    </div>
  );
}
