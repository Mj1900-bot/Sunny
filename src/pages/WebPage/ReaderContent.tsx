import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { invokeSafe } from '../../lib/tauri';

const contentInner: CSSProperties = {
  color: 'var(--ink)',
  fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
  fontSize: 14,
  lineHeight: 1.65,
};

type Props = {
  html: string;
  baseUrl: string;
  highlightQuery?: string;
  onNavigate: (url: string) => void;
  onExternal: (url: string) => void;
};

// The Rust side (src-tauri/src/web.rs) already sanitizes untrusted HTML to a
// tight allow-list: scripts / styles / iframes / svg / canvas / templates
// stripped, only a fixed set of inline tags kept, and only `href` (URL-scheme
// validated) + `alt` retained as attributes. `img[src]` is dropped entirely.
//
// That is the security boundary. This component's job is to take the already
// safe string and paint it as React nodes *without* handing the browser an
// innerHTML sink. We parse with `DOMParser('text/html')`, which by spec does
// NOT execute inline scripts, then walk only the tags we recognize and skip
// any attribute we did not explicitly allow-list below. Anything we don't
// recognize is rendered as its child text, never as raw markup.
//
// Anchor clicks are intercepted so http(s) links navigate inside the module;
// non-web schemes (mailto:, tel:, etc.) fall through to the OS handler.
// Right-clicks pop a small context menu (open in new tab / copy link /
// open externally) so reading-mode behaves like a real browser.

const ALLOWED_INLINE: ReadonlySet<string> = new Set([
  'a', 'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img',
]);

const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'img']);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// Render a string with every match of the query wrapped in a <mark>.
function highlightText(text: string, query: string, keyPrefix: string): ReactNode[] {
  if (query.trim().length === 0) return [text];
  const re = new RegExp(`(${escapeRegex(query)})`, 'gi');
  const parts = text.split(re);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      return (
        <mark
          key={`${keyPrefix}-m-${i}`}
          style={{
            background: 'rgba(245, 176, 66, 0.35)',
            color: 'inherit',
            padding: '0 1px',
          }}
        >
          {part}
        </mark>
      );
    }
    return part;
  });
}

function renderChildren(
  parent: Node,
  keyPrefix: string,
  query: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  parent.childNodes.forEach((child, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? '';
      if (text.length > 0) {
        if (query.length > 0) {
          out.push(...highlightText(text, query, key));
        } else {
          out.push(text);
        }
      }
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_INLINE.has(tag)) {
      out.push(...renderChildren(el, key, query));
      return;
    }
    if (VOID_TAGS.has(tag)) {
      if (tag === 'br') {
        out.push(<br key={key} />);
      } else if (tag === 'img') {
        const alt = el.getAttribute('alt') ?? '';
        if (alt.trim().length === 0) return;
        out.push(<img key={key} alt={alt} />);
      }
      return;
    }

    const kids = renderChildren(el, key, query);
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href !== null && href.length > 0) {
        out.push(
          <a key={key} href={href} data-web-anchor="1">
            {kids}
          </a>,
        );
      } else {
        out.push(<span key={key}>{kids}</span>);
      }
      return;
    }

    const Tag = tag as keyof React.JSX.IntrinsicElements;
    out.push(<Tag key={key}>{kids}</Tag>);
  });
  return out;
}

function parseReadable(html: string, query: string): ReactNode[] {
  if (html.length === 0) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  if (body === null) return [];
  return renderChildren(body, 'r', query);
}

type ContextMenuState = {
  x: number;
  y: number;
  href: string;
};

export function ReaderContent({
  html,
  baseUrl,
  highlightQuery,
  onNavigate,
  onExternal,
}: Props) {
  const query = highlightQuery ?? '';
  const nodes = useMemo(() => parseReadable(html, query), [html, query]);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const resolveHref = useCallback(
    (href: string): string | null => {
      if (href.length === 0 || href.startsWith('#')) return null;
      try {
        return new URL(href, baseUrl || undefined).toString();
      } catch {
        return null;
      }
    },
    [baseUrl],
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      const anchor = target.closest('a[data-web-anchor="1"]');
      if (anchor === null) return;
      const href = anchor.getAttribute('href');
      if (href === null) return;
      const resolved = resolveHref(href);
      event.preventDefault();
      if (resolved === null) return;
      const colon = resolved.indexOf(':');
      const scheme = colon > 0 ? resolved.slice(0, colon).toLowerCase() : '';
      if (scheme === 'http' || scheme === 'https') {
        onNavigate(resolved);
      } else {
        onExternal(resolved);
      }
    },
    [resolveHref, onNavigate, onExternal],
  );

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      const anchor = target.closest('a[data-web-anchor="1"]');
      if (anchor === null) return;
      const href = anchor.getAttribute('href');
      if (href === null) return;
      const resolved = resolveHref(href);
      if (resolved === null) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, href: resolved });
    },
    [resolveHref],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const style: CSSProperties = contentInner;

  return (
    <div
      className="sunny-web"
      style={style}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {nodes}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          href={menu.href}
          onClose={closeMenu}
          onOpenHere={() => {
            onNavigate(menu.href);
            closeMenu();
          }}
          onOpenNewTab={() => {
            // The WebPage keeps its own store; we can't reach it directly
            // from this component without a prop. Cheat: dispatch a
            // custom DOM event that WebPage subscribes to. Alternatively
            // the parent can pass `onOpenNewTab` — we do that in the
            // caller once the prop lands.
            window.dispatchEvent(
              new CustomEvent('sunny:web:open-new-tab', { detail: { url: menu.href } }),
            );
            closeMenu();
          }}
          onCopy={() => {
            void navigator.clipboard.writeText(menu.href).catch(() => {});
            closeMenu();
          }}
          onOpenExternal={() => {
            void invokeSafe<null>('open_url', { url: menu.href });
            closeMenu();
          }}
        />
      )}
    </div>
  );
}

function ContextMenu({
  x,
  y,
  href,
  onClose,
  onOpenHere,
  onOpenNewTab,
  onCopy,
  onOpenExternal,
}: {
  x: number;
  y: number;
  href: string;
  onClose: () => void;
  onOpenHere: () => void;
  onOpenNewTab: () => void;
  onCopy: () => void;
  onOpenExternal: () => void;
}) {
  return (
    <>
      {/* Full-page click-eater so any click outside the menu dismisses it. */}
      <div
        onClick={onClose}
        onContextMenu={e => {
          e.preventDefault();
          onClose();
        }}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          background: 'transparent',
        }}
      />
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: y,
          left: x,
          zIndex: 61,
          background: 'rgba(4, 12, 20, 0.98)',
          border: '1px solid var(--cyan)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--ink)',
          minWidth: 220,
          boxShadow: '0 4px 14px rgba(0, 220, 255, 0.15)',
        }}
      >
        <div
          style={{
            padding: '6px 10px',
            borderBottom: '1px dashed var(--line-soft)',
            fontSize: 9,
            letterSpacing: '0.14em',
            color: 'var(--ink-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={href}
        >
          {href}
        </div>
        <MenuItem label="Open here" onClick={onOpenHere} />
        <MenuItem label="Open in new tab" onClick={onOpenNewTab} />
        <MenuItem label="Copy link" onClick={onCopy} />
        <MenuItem label="Open in Safari" onClick={onOpenExternal} />
      </div>
    </>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'block',
        width: '100%',
        padding: '6px 10px',
        boxSizing: 'border-box',
        letterSpacing: '0.04em',
        color: hover ? 'var(--cyan)' : 'var(--ink)',
        background: hover ? 'rgba(0, 220, 255, 0.06)' : 'transparent',
      }}
    >
      {label}
    </button>
  );
}
