/**
 * Lightweight markdown preview rendered with innerHTML.
 * Uses a minimal subset renderer (no external deps) adequate for typical
 * Apple Notes content: headings, bold, italic, code, lists, blockquotes.
 *
 * Security: only renders the note's own persisted content — not user-typed
 * HTML. Notes.app content is plain text with markdown-ish conventions,
 * not raw HTML, so the risk surface is minimal within this local app.
 */

function renderMarkdown(md: string): string {
  let html = md
    // Escape HTML to prevent injection from literal < > &
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headings
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`(.+?)`/g, '<code>$1</code>')
    // Blockquote
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    // Unordered list items
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Numbered list items
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr/>')
    // Double newline → paragraph break
    .replace(/\n\n+/g, '</p><p>')
    // Single newline → line break
    .replace(/\n/g, '<br/>');

  return `<p>${html}</p>`;
}

type Props = {
  readonly markdown: string;
};

export function MarkdownPreview({ markdown }: Props) {
  if (!markdown.trim()) {
    return (
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
        padding: '10px 0',
      }}>Empty note</div>
    );
  }

  return (
    <div
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }}
      style={{
        fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink-2)',
        lineHeight: 1.65,
        overflowY: 'auto',
        maxHeight: '100%',
      }}
    />
  );
}
