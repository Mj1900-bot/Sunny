/**
 * SnippetsPanel — lists saved snippets for the current lang tab.
 * Allows recall (load into editor) and delete.
 */

import { Chip, Toolbar, ToolbarButton, ScrollList } from '../_shared';
import { type Snippet, deleteSnippet } from './snippets';

export function SnippetsPanel({
  snippets, lang, onRecall, onDeleted,
}: {
  snippets: ReadonlyArray<Snippet>;
  lang: 'py' | 'sh';
  onRecall: (code: string) => void;
  onDeleted: () => void;
}) {
  const filtered = snippets.filter(s => s.lang === lang);
  if (filtered.length === 0) {
    return (
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
        padding: '10px 8px', border: '1px dashed var(--line-soft)',
      }}>no saved snippets — click SAVE on any output block</div>
    );
  }
  return (
    <ScrollList maxHeight={240}>
      {filtered.map(s => (
        <div key={s.id} style={{
          border: '1px solid var(--line-soft)', background: 'rgba(6,14,22,0.5)',
          padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Chip tone={lang === 'py' ? 'cyan' : 'amber'}>{lang.toUpperCase()}</Chip>
            <span style={{
              flex: 1, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{s.label}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
              {new Date(s.savedAt).toLocaleDateString()}
            </span>
          </div>
          <pre style={{
            margin: 0, padding: '4px 8px',
            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'rgba(0,0,0,0.3)', borderLeft: '2px solid var(--line-soft)',
            maxHeight: 80, overflow: 'auto',
          }}>{s.code}</pre>
          <Toolbar>
            <ToolbarButton tone="cyan" onClick={() => onRecall(s.code)}>LOAD</ToolbarButton>
            <ToolbarButton tone="red" onClick={() => { deleteSnippet(s.id); onDeleted(); }}>DELETE</ToolbarButton>
          </Toolbar>
        </div>
      ))}
    </ScrollList>
  );
}
