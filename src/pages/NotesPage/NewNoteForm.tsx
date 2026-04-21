import { useEffect, useRef, useState } from 'react';

export function NewNoteForm({
  folders, onCreate, onCancel,
}: {
  folders: ReadonlyArray<string>;
  onCreate: (title: string, body: string, folder: string | undefined) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [folder, setFolder] = useState('');
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onCreate(t, body, folder || undefined);
    setTitle(''); setBody('');
  };

  return (
    <div
      onKeyDown={e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
      }}
      style={{
        border: '1px solid var(--line-soft)',
        borderLeft: '2px solid var(--violet)',
        background: 'rgba(6, 14, 22, 0.65)',
        padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
        color: 'var(--violet)', fontWeight: 700,
      }}>
        <span>NEW NOTE</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.16em' }}>
          ⌘↵ SAVE · ESC CANCEL
        </span>
      </div>
      <label htmlFor="new-note-title" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>Note title</label>
      <input
        id="new-note-title"
        ref={titleRef}
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Title"
        style={{
          all: 'unset',
          padding: '8px 10px',
          fontFamily: 'var(--label)', fontSize: 15, color: 'var(--ink)',
          fontWeight: 600,
          border: '1px solid var(--line-soft)',
          background: 'rgba(0, 0, 0, 0.3)',
        }}
      />
      <label htmlFor="new-note-body" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>Note body</label>
      <textarea
        id="new-note-body"
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Start writing…"
        rows={3}
        style={{
          all: 'unset',
          padding: '8px 10px',
          fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink)',
          lineHeight: 1.55,
          border: '1px solid var(--line-soft)',
          background: 'rgba(0, 0, 0, 0.3)',
          resize: 'vertical',
          minHeight: 56,
        }}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <label htmlFor="new-note-folder" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>Folder</label>
        <select
          id="new-note-folder"
          value={folder}
          onChange={e => setFolder(e.target.value)}
          style={{
            all: 'unset', cursor: 'pointer',
            padding: '6px 10px',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
            border: '1px solid var(--line-soft)',
            background: 'rgba(0, 0, 0, 0.3)',
            minWidth: 160,
          }}
        >
          <option value="">default folder</option>
          {folders.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              all: 'unset', cursor: 'pointer',
              padding: '6px 14px',
              fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.22em',
              fontWeight: 700, color: 'var(--ink-dim)',
              border: '1px solid var(--line-soft)',
              background: 'rgba(0, 0, 0, 0.3)',
            }}
          >CANCEL</button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!title.trim()}
          style={{
            all: 'unset', cursor: title.trim() ? 'pointer' : 'not-allowed',
            padding: '6px 16px',
            fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.22em',
            fontWeight: 700, color: 'var(--violet)',
            border: '1px solid var(--violet)',
            background: title.trim() ? 'rgba(180, 140, 255, 0.15)' : 'rgba(180, 140, 255, 0.05)',
            opacity: title.trim() ? 1 : 0.5,
          }}
        >CREATE</button>
      </div>
    </div>
  );
}
