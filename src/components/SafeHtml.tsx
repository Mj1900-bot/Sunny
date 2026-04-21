import { useMemo } from 'react';

/**
 * Renders a whitelisted subset of HTML strings from our seed files.
 * Only allows: <span class="X"> where X ∈ whitelist, plus text nodes.
 */
const CLASS_WHITELIST = new Set([
  'prompt', 'path', 'cmd', 'out', 'ok', 'warn', 'err', 'dim', 'cyan',
]);

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'span'; cls: string; children: Node[] };

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, '\u00a0');
}

function parse(html: string): Node[] {
  const tokenizer = /<span class="([a-z ]+)">|<\/span>/gi;
  const out: Node[] = [];
  const stack: { children: Node[] }[] = [{ children: out }];
  let cursor = 0;
  let match: RegExpExecArray | null = null;
  while ((match = tokenizer.exec(html)) !== null) {
    if (match.index > cursor) {
      stack[stack.length - 1].children.push({
        kind: 'text',
        text: decodeEntities(html.slice(cursor, match.index)),
      });
    }
    if (match[0].startsWith('<span')) {
      const classes = match[1]
        .split(/\s+/)
        .filter(c => CLASS_WHITELIST.has(c))
        .join(' ');
      const node: Node = { kind: 'span', cls: classes, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ children: node.children });
    } else if (stack.length > 1) {
      stack.pop();
    }
    cursor = tokenizer.lastIndex;
  }
  if (cursor < html.length) {
    stack[stack.length - 1].children.push({
      kind: 'text',
      text: decodeEntities(html.slice(cursor)),
    });
  }
  return out;
}

function render(nodes: Node[], key = 0): React.ReactNode {
  return nodes.map((n, i) => {
    if (n.kind === 'text') return <span key={`${key}-${i}`}>{n.text}</span>;
    return (
      <span key={`${key}-${i}`} className={n.cls}>
        {render(n.children, key * 100 + i)}
      </span>
    );
  });
}

export function SafeHtml({ html }: { html: string }) {
  const parsed = useMemo(() => parse(html), [html]);
  return <>{render(parsed)}</>;
}
