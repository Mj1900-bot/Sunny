/**
 * MarkdownPreview — lightweight inline markdown renderer for PERSONA fields.
 *
 * Supports: **bold**, _italic_, `code`, and line breaks. No external dep.
 * Only used for constitution text fields where the complexity stays minimal.
 */

type Segment = { type: 'bold' | 'italic' | 'code' | 'text'; text: string };

function parseInline(raw: string): Segment[] {
  const segs: Segment[] = [];
  // We process the string left-to-right with a simple state machine.
  let i = 0;
  let buf = '';

  while (i < raw.length) {
    if (raw[i] === '*' && raw[i + 1] === '*') {
      if (buf) { segs.push({ type: 'text', text: buf }); buf = ''; }
      const end = raw.indexOf('**', i + 2);
      if (end === -1) { buf += raw.slice(i); break; }
      segs.push({ type: 'bold', text: raw.slice(i + 2, end) });
      i = end + 2;
    } else if (raw[i] === '_') {
      if (buf) { segs.push({ type: 'text', text: buf }); buf = ''; }
      const end = raw.indexOf('_', i + 1);
      if (end === -1) { buf += raw[i]; i++; continue; }
      segs.push({ type: 'italic', text: raw.slice(i + 1, end) });
      i = end + 1;
    } else if (raw[i] === '`') {
      if (buf) { segs.push({ type: 'text', text: buf }); buf = ''; }
      const end = raw.indexOf('`', i + 1);
      if (end === -1) { buf += raw[i]; i++; continue; }
      segs.push({ type: 'code', text: raw.slice(i + 1, end) });
      i = end + 1;
    } else {
      buf += raw[i];
      i++;
    }
  }
  if (buf) segs.push({ type: 'text', text: buf });
  return segs;
}

function renderSegment(seg: Segment, key: number): React.ReactNode {
  switch (seg.type) {
    case 'bold':   return <strong key={key} style={{ color: 'var(--ink)', fontWeight: 700 }}>{seg.text}</strong>;
    case 'italic': return <em key={key} style={{ color: 'var(--ink-2)', fontStyle: 'italic' }}>{seg.text}</em>;
    case 'code':   return (
      <code
        key={key}
        style={{
          fontFamily: 'var(--mono)', fontSize: '0.9em',
          color: 'var(--cyan)',
          background: 'rgba(57, 229, 255, 0.08)',
          padding: '1px 4px',
        }}
      >{seg.text}</code>
    );
    default:       return <span key={key}>{seg.text}</span>;
  }
}

export function MarkdownPreview({ text, style }: { text: string; style?: React.CSSProperties }) {
  if (!text.trim()) {
    return (
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
        padding: '8px 12px',
        border: '1px dashed var(--line-soft)',
        ...style,
      }}>
        (empty)
      </div>
    );
  }

  const lines = text.split('\n');
  return (
    <div style={{
      fontFamily: 'var(--label)', fontSize: 12.5, color: 'var(--ink-2)',
      lineHeight: 1.65,
      padding: '10px 14px',
      border: '1px solid var(--line-soft)',
      borderLeft: '2px solid var(--violet)',
      background: 'rgba(0, 0, 0, 0.25)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      ...style,
    }}>
      {lines.map((line, li) => {
        const segs = parseInline(line);
        return (
          <div key={li} style={{ minHeight: '1.2em' }}>
            {segs.map((s, si) => renderSegment(s, si))}
          </div>
        );
      })}
    </div>
  );
}
