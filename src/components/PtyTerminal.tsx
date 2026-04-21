import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
// Addon types only — the real modules are loaded dynamically inside the
// mount effect to keep them out of the initial JS bundle (~200 KB saving).
import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import type { SearchAddon as SearchAddonType } from '@xterm/addon-search';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { Panel } from './Panel';
import { invoke, listen, isTauri } from '../lib/tauri';
import { AnsiStream, labelFromTitle, splitTitleRunning } from '../lib/ansiParse';
import { useTerminals } from '../store/terminals';
import '@xterm/xterm/css/xterm.css';

type Props = {
  id: string;
  title: string;
  small: string;
  panelId: string;
  initialCommand?: string;
  statusLine?: ReactNode;
  chromeless?: boolean;
  onExpand?: () => void;
  onClose?: () => void;
};

type PtyPayload = { id: string; data: string };

const THEME: ITheme = {
  background: 'transparent',
  foreground: '#e6f8ff',
  cursor: '#39e5ff',
  cursorAccent: '#02080c',
  selectionBackground: 'rgba(57,229,255,0.25)',
  black: '#02080c',
  red: '#ff4d5e',
  green: '#7dff9a',
  yellow: '#ffb347',
  blue: '#6bf1ff',
  magenta: '#b48cff',
  cyan: '#39e5ff',
  white: '#e6f8ff',
};

const FONT_FAMILY = "'JetBrains Mono', ui-monospace, monospace";
const FONT_SIZE = 11;
const LINE_HEIGHT = 1.25;

function nonce(): string {
  return Math.random().toString(36).slice(2, 8);
}

// Handle to the in-flight xterm runtime so the inline search bar and
// the React header can reach the addons without prop-drilling them out
// through the effect.
type Runtime = {
  term: XTerm;
  fit: FitAddonType;
  search: SearchAddonType;
  sessionId: string;
  isAlive: () => boolean;
};

export function PtyTerminal({
  id,
  title,
  small,
  panelId,
  initialCommand,
  statusLine,
  chromeless,
  onExpand,
  onClose,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  // Keep setters available inside the effect without re-running on
  // every store mutation (which would obliterate the xterm session).
  const storeRef = useRef(useTerminals.getState());
  useEffect(() => useTerminals.subscribe(s => (storeRef.current = s)), []);

  // Keep the latest title in a ref so the PTY-setup effect can read it
  // without listing `title` in its dependency array. Listing `title` in
  // deps destroyed and recreated the entire backend PTY session on every
  // OSC title update — which made overlay terminals non-functional.
  const titleRef = useRef(title);
  titleRef.current = title;

  // Inline search UI — opened with ⌘F, drives the SearchAddon.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isTauri) return;
    const host = hostRef.current;
    if (!host) return;

    const sessionId = `${id}-${nonce()}`;

    const term = new XTerm({
      theme: THEME,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      allowTransparency: true,
      scrollback: 10_000,
      convertEol: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      wordSeparator: ' ()[]{}\'"`,;',
      // Glyph-cache-friendly — improves WebGL renderer throughput on
      // dense logs.
      minimumContrastRatio: 1,
    });

    // Copy/paste key bindings. xterm's `.paste()` uses bracketed paste
    // automatically when the shell has enabled DECSET 2004 — which
    // modern zsh / bash / fish all do — so multi-line pastes arrive as
    // a single chunk instead of each line being run immediately.
    term.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return true;
      if ((e.key === 'c' || e.key === 'C') && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (e.key === 'v' || e.key === 'V') {
        navigator.clipboard
          .readText()
          .then(text => {
            if (text) term.paste(text);
          })
          .catch(() => {});
        return false;
      }
      // ⌘F opens the inline search bar. We stop xterm from receiving
      // the keystroke so it doesn't get inserted into the shell.
      if (e.key === 'f' || e.key === 'F') {
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }
      // ⌘K clears the scrollback and visible buffer.
      if (e.key === 'k' || e.key === 'K') {
        try { term.clear(); } catch { /* terminal disposed mid-keystroke */ }
        return false;
      }
      return true;
    });

    // OSC/ANSI stream parser.
    const parser = new AnsiStream();

    let disposed = false;
    // fitRef holds the FitAddon once boot() resolves — used by ResizeObserver.
    let fitAddon: FitAddonType | null = null;
    let opened = false;
    let unlistenData: UnlistenFn | null = null;
    let unlistenClosed: UnlistenFn | null = null;
    let initialSent = false;
    let pendingInput = '';

    storeRef.current.setSessionId(id, null);

    // Resize coalescing via rAF: a window drag fires the ResizeObserver
    // dozens of times per second, and each raw `.fit()` does a heavy
    // re-measure. We mark dirty and process at most once per animation
    // frame, which is the visible refresh cadence anyway.
    let resizeScheduled = false;
    const requestFit = (): void => {
      if (resizeScheduled || disposed || !fitAddon) return;
      resizeScheduled = true;
      requestAnimationFrame(() => {
        resizeScheduled = false;
        if (disposed || !fitAddon) return;
        try {
          fitAddon.fit();
        } catch (err) {
          console.error(`pty fit(${sessionId}) failed`, err);
        }
      });
    };

    const flushPendingInput = () => {
      if (!opened || disposed || pendingInput.length === 0) return;
      const data = pendingInput;
      pendingInput = '';
      invoke<void>('pty_write', { id: sessionId, data }).catch(error => {
        console.error(`pty_write(${sessionId}) flush failed`, error);
      });
    };

    const sendInitial = () => {
      if (initialSent || disposed || !opened || !initialCommand) return;
      initialSent = true;
      invoke<void>('pty_write', { id: sessionId, data: `${initialCommand}\n` }).catch(error => {
        console.error(`pty_write initial(${sessionId}) failed`, error);
      });
    };

    const handlePtyChunk = (data: string) => {
      term.write(data);
      const { plain, events } = parser.feed(data);
      const store = storeRef.current;
      if (plain.length > 0) store.appendOutput(id, plain);
      for (const ev of events) {
        if (ev.kind === 'title') {
          const { label, running } = splitTitleRunning(ev.text);
          store.setAutoTitle(id, labelFromTitle(label, titleRef.current));
          store.setRunning(id, running);
        } else if (ev.kind === 'cwd') {
          store.setCwd(id, ev.path);
        }
      }
    };

    const boot = async () => {
      // Dynamically import all xterm addons so they land in a lazy chunk and
      // stay out of the critical-path bundle (~200 KB saving for initial load).
      const [
        { FitAddon },
        { WebLinksAddon },
        { SearchAddon },
        { Unicode11Addon },
        { WebglAddon },
      ] = await Promise.all([
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-search'),
        import('@xterm/addon-unicode11'),
        import('@xterm/addon-webgl'),
      ]);

      if (disposed) return;

      const fit = new FitAddon();
      fitAddon = fit;
      const links = new WebLinksAddon();
      const search = new SearchAddon();
      const unicode11 = new Unicode11Addon();
      term.loadAddon(fit);
      term.loadAddon(links);
      term.loadAddon(search);
      term.loadAddon(unicode11);

      // Expose the runtime for search bar access once addons are loaded.
      runtimeRef.current = {
        term,
        fit,
        search,
        sessionId,
        isAlive: () => !disposed,
      };

      term.open(host);

      // Upgrade character-width calculations from Unicode 6 (xterm's
      // built-in) to Unicode 11 so emoji, CJK, and newer symbols render
      // at their correct column width. MUST be set after `term.open()`
      // — setting it pre-open leaves `_core._store` uninitialized and
      // the first clear/dispose on the Unicode addon path crashes with
      // "this._terminal._core._store._isDisposed" when the tile is torn
      // down or a second tile mounts.
      try { term.unicode.activeVersion = '11'; } catch (err) {
        console.warn(`xterm unicode11 init failed for ${sessionId}`, err);
      }

      // WebGL renderer — GPU-accelerated, 2–5x faster for dense log output.
      // Installed opportunistically: if WebGL is unavailable or the GPU rejects
      // the context (headless, some VMs, first-launch policy), we fall back
      // silently to the canvas renderer which works everywhere.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
        });
        term.loadAddon(webgl);
      } catch (err) {
        console.warn(`xterm WebGL unavailable for ${sessionId}, using canvas`, err);
      }
      term.focus();

      // Wire up rAF then fit — the addons are now loaded so this is safe.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        /* tile not yet laid out — recover on first observer tick */
      }
      const cols = Math.max(20, term.cols);
      const rows = Math.max(5, term.rows);

      try {
        unlistenData = await listen<PtyPayload>(`sunny://pty/${sessionId}`, payload => {
          if (disposed) return;
          if (payload && payload.id === sessionId) {
            handlePtyChunk(payload.data);
            if (!initialSent && initialCommand) sendInitial();
          }
        });
        if (disposed) {
          unlistenData?.();
          unlistenData = null;
          return;
        }

        unlistenClosed = await listen<PtyPayload>(`sunny://pty/${sessionId}/closed`, () => {
          if (disposed) return;
          term.writeln('\r\n\x1b[2m[session closed]\x1b[0m');
          storeRef.current.setRunning(id, null);
        });
        if (disposed) {
          unlistenData?.();
          unlistenClosed?.();
          unlistenData = null;
          unlistenClosed = null;
          return;
        }

        await invoke<void>('pty_open', { id: sessionId, cols, rows });
        if (disposed) {
          invoke<void>('pty_close', { id: sessionId }).catch(() => {});
          unlistenData?.();
          unlistenClosed?.();
          unlistenData = null;
          unlistenClosed = null;
          return;
        }
        opened = true;
        storeRef.current.setSessionId(id, sessionId);
        flushPendingInput();

        if (initialCommand) {
          setTimeout(() => {
            if (!disposed && !initialSent) sendInitial();
          }, 600);
        }
      } catch (error) {
        console.error(`pty_open(${sessionId}) failed`, error);
        if (!disposed) {
          term.writeln(`\r\n\x1b[31mFailed to start shell: ${String(error)}\x1b[0m`);
        }
      }
    };

    const dataDisposable = term.onData(data => {
      if (disposed) return;
      if (!opened) {
        pendingInput += data;
        return;
      }
      // Track Enter keypresses as "commands" for the stats display.
      if (data.includes('\r')) {
        storeRef.current.recordCommand(id);
      }
      invoke<void>('pty_write', { id: sessionId, data }).catch(error => {
        console.error(`pty_write(${sessionId}) failed`, error);
      });
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (!opened || disposed) return;
      invoke<void>('pty_resize', { id: sessionId, cols, rows }).catch(error => {
        console.error(`pty_resize(${sessionId}) failed`, error);
      });
    });

    const focusOnClick = () => term.focus();
    host.addEventListener('mousedown', focusOnClick);

    const observer = new ResizeObserver(() => requestFit());
    observer.observe(host);

    boot();

    return () => {
      disposed = true;
      observer.disconnect();
      host.removeEventListener('mousedown', focusOnClick);
      try { dataDisposable.dispose(); } catch { /* xterm addon torn down */ }
      try { resizeDisposable.dispose(); } catch { /* addon torn down */ }
      unlistenData?.();
      unlistenClosed?.();
      invoke<void>('pty_close', { id: sessionId }).catch(() => {});
      storeRef.current.setSessionId(id, null);
      runtimeRef.current = null;
      // Wrap the final dispose — some xterm addons (notably unicode11
      // when init raced) throw "_core._store._isDisposed" from their
      // own dispose path, which otherwise propagates into React's
      // render loop and trips the Module Fault error screen.
      try { term.dispose(); } catch (err) {
        console.warn(`xterm dispose threw for ${sessionId} (ignored)`, err);
      }
    };
  // `title` is intentionally NOT listed here — it's read via titleRef
  // so OSC-driven title changes don't tear down the live PTY session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, initialCommand]);

  // ---- Search bar wiring ----

  const runSearch = useCallback(
    (query: string, direction: 'next' | 'prev'): void => {
      const rt = runtimeRef.current;
      if (!rt || !rt.isAlive() || query.length === 0) return;
      const opts = { incremental: false, caseSensitive: false, regex: false };
      if (direction === 'next') rt.search.findNext(query, opts);
      else rt.search.findPrevious(query, opts);
    },
    [],
  );

  const closeSearch = useCallback(() => {
    const rt = runtimeRef.current;
    if (rt?.isAlive()) rt.search.clearDecorations();
    setSearchOpen(false);
    setSearchQuery('');
    // Return focus to the xterm so typing continues in the shell.
    setTimeout(() => runtimeRef.current?.term.focus(), 0);
  }, []);

  const controls = (onExpand || onClose) ? (
    <span
      style={{
        display: 'inline-flex',
        gap: 6,
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      {onExpand ? (
        <HeaderButton
          label="Expand"
          title="Open in multi-terminal workspace"
          onClick={onExpand}
        >
          <ExpandGlyph />
        </HeaderButton>
      ) : null}
      {onClose ? (
        <HeaderButton label="Close" title="Close terminal" onClick={onClose}>
          <CloseGlyph />
        </HeaderButton>
      ) : null}
    </span>
  ) : null;

  const body = (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: THEME.background,
      }}
    >
      {statusLine ? <div style={{ flex: '0 0 auto' }}>{statusLine}</div> : null}
      {isTauri ? (
        <div
          ref={hostRef}
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            width: '100%',
            background: THEME.background,
            padding: '6px 8px',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
        />
      ) : (
        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--dim)',
            fontFamily: FONT_FAMILY,
            fontSize: 11,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            background: THEME.background,
          }}
        >
          Terminal only available in Tauri runtime
        </div>
      )}
      {searchOpen ? (
        <SearchBar
          value={searchQuery}
          inputRef={searchInputRef}
          onChange={v => {
            setSearchQuery(v);
            runSearch(v, 'next');
          }}
          onNext={() => runSearch(searchQuery, 'next')}
          onPrev={() => runSearch(searchQuery, 'prev')}
          onClose={closeSearch}
        />
      ) : null}
    </div>
  );

  if (chromeless) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          minWidth: 0,
          overflow: 'hidden',
          border: '1px solid var(--line-soft)',
          background: 'rgba(2,8,12,0.85)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.4), 0 10px 24px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderBottom: '1px solid var(--line-soft)',
            fontFamily: FONT_FAMILY,
            fontSize: 10,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'var(--cyan)',
            background: 'rgba(57,229,255,0.04)',
          }}
        >
          <span
            style={{
              flex: '1 1 auto',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </span>
          {small ? (
            <span style={{ opacity: 0.6, fontSize: 9, letterSpacing: '0.18em' }}>{small}</span>
          ) : null}
          {controls ? (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{controls}</span>
          ) : null}
        </div>
        <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>{body}</div>
      </div>
    );
  }

  return (
    <Panel
      id={panelId}
      title={title}
      right={small}
      headerExtra={controls}
      bodyStyle={{ padding: 0 }}
    >
      {body}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Inline search bar — ⌘F opens it, Esc closes. Keeps the xterm buffer
// unchanged; uses SearchAddon decorations to highlight matches.
// ---------------------------------------------------------------------------

function SearchBar({
  value,
  inputRef,
  onChange,
  onNext,
  onPrev,
  onClose,
}: {
  value: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  return (
    <div style={SEARCH_BAR_STYLE} onClick={e => e.stopPropagation()}>
      <span
        style={{
          fontSize: 9,
          letterSpacing: '0.22em',
          color: 'var(--cyan)',
          textTransform: 'uppercase',
          opacity: 0.7,
        }}
      >
        FIND
      </span>
      <input
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            onPrev();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            onNext();
          }
        }}
        placeholder="Search scrollback…"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        style={SEARCH_INPUT_STYLE}
      />
      <span style={SEARCH_ACTIONS_STYLE}>
        <HeaderButton label="Previous match" title="Previous (⇧⏎)" onClick={onPrev}>
          <ChevronGlyph up />
        </HeaderButton>
        <HeaderButton label="Next match" title="Next (⏎)" onClick={onNext}>
          <ChevronGlyph />
        </HeaderButton>
        <HeaderButton label="Close search" title="Close (Esc)" onClick={onClose}>
          <CloseGlyph />
        </HeaderButton>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header chrome
// ---------------------------------------------------------------------------

function HeaderButton({
  label,
  title,
  onClick,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    padding: 0,
    margin: 0,
    border: '1px solid var(--cyan)',
    background: 'rgba(57,229,255,0.10)',
    color: 'var(--cyan)',
    borderRadius: 2,
    cursor: 'pointer',
    lineHeight: 0,
    boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
      style={style}
    >
      {children}
    </button>
  );
}

function ExpandGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d="M1 4 V1 H4" />
      <path d="M9 4 V1 H6" />
      <path d="M1 6 V9 H4" />
      <path d="M9 6 V9 H6" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d="M1 1 L9 9" />
      <path d="M9 1 L1 9" />
    </svg>
  );
}

function ChevronGlyph({ up }: { up?: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      aria-hidden="true"
      style={up ? { transform: 'scaleY(-1)' } : undefined}
    >
      <path d="M2 4 L5 7 L8 4" />
    </svg>
  );
}

const SEARCH_BAR_STYLE: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 10,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  background: 'rgba(4, 10, 14, 0.92)',
  border: '1px solid var(--cyan)',
  borderRadius: 3,
  boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
  fontFamily: FONT_FAMILY,
};

const SEARCH_INPUT_STYLE: CSSProperties = {
  width: 200,
  padding: '3px 6px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57,229,255,0.05)',
  color: 'var(--cyan)',
  fontFamily: FONT_FAMILY,
  fontSize: 11,
  outline: 'none',
};

const SEARCH_ACTIONS_STYLE: CSSProperties = {
  display: 'inline-flex',
  gap: 4,
  alignItems: 'center',
};
