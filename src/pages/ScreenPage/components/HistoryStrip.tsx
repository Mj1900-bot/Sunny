import type { Capture } from '../types';
import { labelSmall } from '../styles';
import { formatAge, dataUrl } from '../utils';
import { getCaptureTags } from '../captureTags';

export type HistoryStripProps = {
  history: ReadonlyArray<Capture>;
  currentId: string | null;
  onRestore: (c: Capture) => void;
  now: number;
  ocrMatchIds?: ReadonlySet<string>;
  tagsVersion?: number; // bump to force re-read of tags
};

export function HistoryStrip({
  history, currentId, onRestore, now,
  ocrMatchIds, tagsVersion: _tagsVersion,
}: HistoryStripProps) {
  if (history.length === 0) return null;
  return (
    <div
      className="section"
      style={{ padding: 10, margin: 0, display: 'flex', gap: 8, alignItems: 'flex-start' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', paddingRight: 4, minWidth: 62, paddingTop: 4 }}>
        <span style={labelSmall}>HISTORY</span>
        <span style={{ ...labelSmall, fontSize: 9, color: 'var(--ink-dim)' }}>
          {history.length} · SCROLL
        </span>
      </div>
      <div
        style={{
          display: 'flex', gap: 6, flex: 1,
          overflowX: 'auto', paddingBottom: 4,
          scrollSnapType: 'x mandatory',
        }}
      >
        {history.map(c => {
          const active = c.id === currentId;
          const isMatch = ocrMatchIds?.has(c.id) ?? false;
          const tags = getCaptureTags(c.id);
          return (
            <button
              key={c.id}
              onClick={() => onRestore(c)}
              title={`${c.source} · ${c.image.width}×${c.image.height} · ${formatAge(now - c.capturedAt)} · click to restore`}
              style={{
                all: 'unset',
                cursor: 'pointer',
                position: 'relative',
                width: 96,
                minHeight: 60,
                border: `1px solid ${active ? 'var(--cyan)' : isMatch ? 'var(--amber)' : 'var(--line-soft)'}`,
                background: 'rgba(2,6,10,0.5)',
                flexShrink: 0,
                overflow: 'hidden',
                boxShadow: active
                  ? '0 0 10px rgba(57,229,255,0.3)'
                  : isMatch
                    ? '0 0 8px rgba(255,179,71,0.25)'
                    : 'none',
                scrollSnapAlign: 'start',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ position: 'relative', height: 60, overflow: 'hidden' }}>
                <img
                  src={dataUrl(c.image)}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <span
                  style={{
                    position: 'absolute', left: 2, bottom: 1,
                    fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.08em',
                    color: active ? 'var(--cyan)' : 'var(--ink-2)',
                    textShadow: '0 0 6px rgba(2,6,10,0.9)', fontWeight: 700,
                  }}
                >
                  {c.source.split(' ')[0]} · {formatAge(now - c.capturedAt)}
                </span>
                {isMatch && (
                  <span style={{
                    position: 'absolute', right: 2, top: 2,
                    background: 'var(--amber)', color: '#000',
                    fontFamily: 'var(--mono)', fontSize: 8, padding: '1px 3px', fontWeight: 700,
                  }}>OCR</span>
                )}
              </div>
              {/* Tag strip */}
              {tags.length > 0 && (
                <div style={{
                  display: 'flex', gap: 2, flexWrap: 'nowrap', overflow: 'hidden',
                  padding: '2px 3px',
                  background: 'rgba(0,0,0,0.5)',
                }}>
                  {tags.slice(0, 3).map(tag => (
                    <span key={tag} style={{
                      fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--violet)',
                      border: '1px solid var(--violet)', padding: '0 3px',
                      letterSpacing: '0.06em', whiteSpace: 'nowrap',
                    }}>{tag}</span>
                  ))}
                  {tags.length > 3 && (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--ink-dim)' }}>+{tags.length - 3}</span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
