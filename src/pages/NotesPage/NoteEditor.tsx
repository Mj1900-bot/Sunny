/**
 * NoteEditor — split-pane writing interface.
 *
 * Left: editable textarea (append-mode). Right: live markdown preview.
 * Selected text triggers a floating AI action bar: EXPAND / SUMMARIZE /
 * REWRITE PRO / REWRITE CASUAL.
 *
 * The editor resets when `note.id` changes (parent re-keys it) so we
 * never have to sync stale props → state inside an effect.
 *
 * Footer stats show body word/char counts plus live counts of the pending
 * append so users feel the shape of what they're about to commit.
 */

import { useMemo, useRef, useState } from 'react';
import { Chip, EmptyState, Toolbar, ToolbarButton } from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { appendNote, type Note } from './api';
import { MarkdownPreview } from './MarkdownPreview';
import { toggleNoteFavorite, useNoteFavorites } from './noteFavorites';

type InlineOp = 'EXPAND' | 'SUMMARIZE' | 'REWRITE PRO' | 'REWRITE CASUAL';

const INLINE_OPS: { label: InlineOp; tone: 'cyan' | 'amber' | 'violet' | 'green'; prompt: (sel: string) => string }[] = [
  {
    label: 'EXPAND',
    tone: 'cyan',
    prompt: sel => `Expand this into a polished paragraph while keeping my voice: "${sel}"`,
  },
  {
    label: 'SUMMARIZE',
    tone: 'amber',
    prompt: sel => `Summarize this in 2–3 sentences: "${sel}"`,
  },
  {
    label: 'REWRITE PRO',
    tone: 'violet',
    prompt: sel => `Rewrite this in a professional, formal tone: "${sel}"`,
  },
  {
    label: 'REWRITE CASUAL',
    tone: 'green',
    prompt: sel => `Rewrite this in a friendly, casual tone: "${sel}"`,
  },
];

function wordsOf(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function NoteEditor({
  note, onChanged,
}: {
  note: Note | null;
  onChanged: () => void;
}) {
  const [append, setAppend] = useState('');
  const [selection, setSelection] = useState('');
  const [previewMode, setPreviewMode] = useState<'split' | 'editor' | 'preview'>('split');
  const favorites = useNoteFavorites();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const bodyWords = useMemo(() => wordsOf(note?.body ?? ''), [note?.body]);
  const bodyChars = note?.body?.length ?? 0;
  const appendWords = useMemo(() => wordsOf(append), [append]);

  if (!note) {
    return <EmptyState title="No note selected" hint="Create a new note with ⌘N or pick one from the list." />;
  }

  const submitAppend = async () => {
    const trimmed = append.trim();
    if (!trimmed) return;
    await appendNote(note.id, trimmed);
    setAppend('');
    onChanged();
  };

  const handleSelect = () => {
    const el = textareaRef.current;
    if (!el) return;
    const sel = el.value.slice(el.selectionStart, el.selectionEnd).trim();
    setSelection(sel);
  };

  const hasSelection = selection.length > 0;

  const gridTemplate =
    previewMode === 'split' ? '1fr 1fr' :
    previewMode === 'editor' ? '1fr 0fr' :
    '0fr 1fr';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Title + meta */}
      <div style={{
        border: '1px solid var(--line-soft)',
        borderLeft: '3px solid var(--violet)',
        background: 'rgba(6,14,22,0.55)',
        padding: '12px 16px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Chip tone="violet">NOTE</Chip>
          <Chip tone="dim">{note.folder}</Chip>
          {note.modified && (
            <Chip tone="dim">
              {new Date(note.modified).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </Chip>
          )}
          <span style={{ flex: 1 }} />
          <ToolbarButton
            tone={favorites.has(note.id) ? 'amber' : 'teal'}
            active={favorites.has(note.id)}
            onClick={() => toggleNoteFavorite(note.id)}
            title="Star this note locally (not synced to Apple Notes)"
          >★ {favorites.has(note.id) ? 'SAVED' : 'STAR'}</ToolbarButton>
          <ToolbarButton
            onClick={() => void navigator.clipboard?.writeText(note.name || '(untitled)')}
          >COPY TITLE</ToolbarButton>
          <ToolbarButton
            onClick={() => void navigator.clipboard?.writeText(note.body ?? '')}
          >COPY BODY</ToolbarButton>
          <ToolbarButton
            tone="cyan"
            onClick={() => {
              const safe = (note.name || 'note').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80);
              const md = `# ${note.name || 'Untitled'}\n\n${note.body ?? ''}`;
              const blob = new Blob([md], { type: 'text/markdown' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `${safe}.md`;
              a.click();
              URL.revokeObjectURL(a.href);
            }}
          >EXPORT .MD</ToolbarButton>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
            letterSpacing: '0.14em',
          }}>
            {bodyWords.toLocaleString()} words · {bodyChars.toLocaleString()} chars
          </span>
        </div>
        <div style={{
          fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700, color: 'var(--ink)',
          letterSpacing: '0.02em',
        }}>
          {note.name || '(untitled)'}
        </div>
      </div>

      {/* View-mode switcher */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--line-soft)', paddingBottom: 4,
      }}>
        <span style={{
          fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
          color: 'var(--ink-dim)', fontWeight: 700,
        }}>VIEW</span>
        <ToolbarButton active={previewMode === 'editor'} onClick={() => setPreviewMode('editor')}>EDITOR</ToolbarButton>
        <ToolbarButton active={previewMode === 'split'} onClick={() => setPreviewMode('split')}>SPLIT</ToolbarButton>
        <ToolbarButton active={previewMode === 'preview'} onClick={() => setPreviewMode('preview')}>PREVIEW</ToolbarButton>
        <span style={{ flex: 1 }} />
        <ToolbarButton onClick={submitAppend} disabled={!append.trim()} tone="violet">APPEND</ToolbarButton>
      </div>

      {/* Split pane */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: gridTemplate,
          gap: previewMode === 'split' ? 8 : 0,
          minHeight: 260,
          transition: 'grid-template-columns 200ms ease',
        }}
      >
        {/* Editor */}
        {previewMode !== 'preview' && (
          <div style={{
            border: '1px solid var(--line-soft)',
            background: 'rgba(0,0,0,0.3)',
            display: 'flex', flexDirection: 'column',
            minWidth: 0,
          }}>
            <div style={{
              fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.24em',
              color: 'var(--cyan)', padding: '5px 10px',
              borderBottom: '1px solid var(--line-soft)',
              display: 'flex', justifyContent: 'space-between', fontWeight: 700,
            }}>
              <span>EDITOR · APPEND</span>
              {appendWords > 0 && (
                <span style={{ color: 'var(--ink-dim)' }}>{appendWords} WORDS</span>
              )}
            </div>
            <textarea
              ref={textareaRef}
              value={append}
              onChange={e => setAppend(e.target.value)}
              onSelect={handleSelect}
              onMouseUp={handleSelect}
              onKeyUp={handleSelect}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void submitAppend();
                }
              }}
              placeholder={note.body ? 'Add text to append… (⌘↵ to save)' : 'Write here… (⌘↵ to save)'}
              style={{
                all: 'unset', display: 'block', flex: 1,
                padding: '12px 14px',
                fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink)',
                lineHeight: 1.6, resize: 'none',
                minHeight: 220,
              }}
            />
          </div>
        )}

        {/* Preview */}
        {previewMode !== 'editor' && (
          <div style={{
            border: '1px solid var(--line-soft)',
            background: 'rgba(6,14,22,0.45)',
            display: 'flex', flexDirection: 'column',
            minWidth: 0,
          }}>
            <div style={{
              fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.24em',
              color: 'var(--violet)', padding: '5px 10px',
              borderBottom: '1px solid var(--line-soft)',
              fontWeight: 700,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>PREVIEW</span>
              <span style={{ color: 'var(--ink-dim)' }}>{append ? 'APPEND' : 'CURRENT'}</span>
            </div>
            <div style={{ flex: 1, padding: '12px 14px', overflowY: 'auto' }}>
              <MarkdownPreview markdown={append || note.body} />
            </div>
          </div>
        )}
      </div>

      {/* Inline AI ops — only shown when text is selected in the editor */}
      {hasSelection && (
        <div style={{
          border: '1px solid var(--line-soft)',
          borderLeft: '2px solid var(--cyan)',
          background: 'rgba(57,229,255,0.04)',
          padding: '8px 12px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.24em',
            color: 'var(--cyan)', fontWeight: 700,
          }}>SELECTION · "{selection.slice(0, 60)}{selection.length > 60 ? '…' : ''}"</div>
          <Toolbar>
            {INLINE_OPS.map(op => (
              <ToolbarButton
                key={op.label}
                tone={op.tone}
                onClick={() => askSunny(op.prompt(selection), 'notes')}
              >{op.label}</ToolbarButton>
            ))}
            <ToolbarButton onClick={() => setSelection('')}>CLEAR</ToolbarButton>
          </Toolbar>
        </div>
      )}

      {/* Whole-note AI ops */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '6px 0',
        borderTop: '1px solid var(--line-soft)',
      }}>
        <span style={{
          fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.24em',
          color: 'var(--ink-dim)', fontWeight: 700,
        }}>WHOLE NOTE</span>
        <ToolbarButton
          onClick={() => askSunny(`Summarize this note in 3 bullets: "${note.body.slice(0, 2000)}"`, 'notes')}
          tone="amber"
        >SUMMARIZE</ToolbarButton>
        <ToolbarButton
          onClick={() => askSunny(`Extract action items from this note: "${note.body.slice(0, 2000)}"`, 'notes')}
          tone="green"
        >EXTRACT TODOS</ToolbarButton>
        <ToolbarButton
          onClick={() => askSunny(`Expand this into a polished paragraph while keeping my voice: "${note.body.slice(0, 600)}"`, 'notes')}
          tone="cyan"
        >EXPAND</ToolbarButton>
      </div>
    </div>
  );
}
