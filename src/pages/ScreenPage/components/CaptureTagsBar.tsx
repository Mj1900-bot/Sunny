/**
 * CaptureTagsBar — shows and edits tags for the currently selected capture.
 */

import { useState } from 'react';
import { getCaptureTags, addCaptureTag, removeCaptureTag } from '../captureTags';

export function CaptureTagsBar({
  captureId, onChanged,
}: {
  captureId: string;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState('');
  const tags = getCaptureTags(captureId);

  const commit = () => {
    const t = draft.trim();
    if (!t) return;
    addCaptureTag(captureId, t);
    setDraft('');
    onChanged();
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        letterSpacing: '0.1em', flexShrink: 0,
      }}>TAGS</span>
      {tags.map(tag => (
        <span
          key={tag}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 7px',
            border: '1px solid var(--violet)', color: 'var(--violet)',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
            background: 'rgba(180,140,255,0.06)',
          }}
        >
          {tag}
          <button
            onClick={() => { removeCaptureTag(captureId, tag); onChanged(); }}
            style={{
              all: 'unset', cursor: 'pointer', color: 'var(--ink-dim)',
              fontSize: 11, lineHeight: 1, marginLeft: 2,
            }}
            aria-label={`Remove tag ${tag}`}
          >×</button>
        </span>
      ))}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        placeholder="+ add tag"
        style={{
          all: 'unset',
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink)',
          padding: '2px 6px',
          border: '1px solid var(--line-soft)',
          background: 'rgba(0,0,0,0.25)',
          width: 80,
        }}
      />
    </div>
  );
}
