// TerminalsOverlay — floating, draggable, resizable terminal workspace.
//
// Rendered via createPortal to document.body so it escapes any ancestor
// CSS transforms (the .stage element has transform: translate + scale).
//
// Non-modal: the user can interact with the app behind the window.
// Drag the title bar to move, edges/corners to resize, double-click
// the title bar to maximize/restore. Can be minimized to a badge.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import {
  useTerminals,
  TERMINALS_OPEN_EVENT,
  TERMINALS_CLOSE_EVENT,
  type TerminalsOpenDetail,
  type TerminalsState,
} from '../../store/terminals';
import { invoke, isTauri } from '../../lib/tauri';
import { Sidebar } from './Sidebar';
import { HeaderBar, TabStrip, TileGrid } from './TileGrid';
import { useWindowDrag, type Edge } from './useWindowDrag';
import {
  SHELL,
  WINDOW_HEADER,
  RIGHT_PANE,
  RESIZE_HANDLE,
  STATUS_BAR,
  TERMINAL_COLORS,
  PILL_BTN,
  shortenPath,
  formatUptime,
  type LayoutMode,
} from './styles';

// ---------------------------------------------------------------------------
// scheduleInitialCommand
// ---------------------------------------------------------------------------

function scheduleInitialCommand(appId: string, command: string): void {
  if (!isTauri || command.length === 0) return;
  const started = Date.now();
  const TIMEOUT_MS = 8_000;
  const POLL_MS = 60;
  const tick = (): void => {
    const session = useTerminals.getState().sessions.find(s => s.id === appId);
    const backendId = session?.sessionId;
    if (backendId) {
      void invoke<void>('pty_write', {
        id: backendId,
        data: `${command}\n`,
      }).catch(() => {});
      return;
    }
    if (Date.now() - started > TIMEOUT_MS) return;
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// TerminalsOverlay
// ---------------------------------------------------------------------------

export function TerminalsOverlay() {
  const overlayIds = useTerminals(
    useShallow((s: TerminalsState) => s.sessions.filter(x => x.origin === 'overlay').map(x => x.id)),
  );
  const dashboardIds = useTerminals(
    useShallow((s: TerminalsState) => s.sessions.filter(x => x.origin === 'dashboard').map(x => x.id)),
  );
  const focusedId = useTerminals(s => s.focusedId);
  const setFocused = useTerminals(s => s.setFocused);
  const addTerminal = useTerminals(s => s.add);
  const removeTerminal = useTerminals(s => s.remove);
  const clearAllOutput = useTerminals(s => s.clearAllOutput);
  const exportOutput = useTerminals(s => s.exportOutput);

  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutMode>('grid');

  // ---- Floating window ----
  const { rect, maximized, active: windowActive, startMove, startEdge, toggleMax } =
    useWindowDrag();

  // ---- Resizable sidebar (inner) ----
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarRef = useRef<{ startX: number; startW: number } | null>(null);
  const [sidebarHover, setSidebarHover] = useState(false);

  useEffect(() => {
    if (!sidebarResizing) return;
    const onMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return;
      setSidebarWidth(Math.max(200, Math.min(480, sidebarRef.current.startW + (e.clientX - sidebarRef.current.startX))));
    };
    const onUp = () => setSidebarResizing(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [sidebarResizing]);

  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      sidebarRef.current = { startX: e.clientX, startW: sidebarWidth };
      setSidebarResizing(true);
    },
    [sidebarWidth],
  );

  const handleAdd = useCallback(() => {
    const newId = addTerminal({ origin: 'overlay' });
    setFocused(newId);
    setFullscreenId(null);
    return newId;
  }, [addTerminal, setFocused]);

  const handleRemove = useCallback(
    (id: string) => {
      if (fullscreenId === id) setFullscreenId(null);
      removeTerminal(id);
    },
    [fullscreenId, removeTerminal],
  );

  const handleExport = useCallback(() => {
    if (!focusedId) return;
    const text = exportOutput(focusedId);
    if (text.length === 0) return;
    void navigator.clipboard.writeText(text);
  }, [focusedId, exportOutput]);

  // ---- Open / close events ----
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<TerminalsOpenDetail>).detail ?? {};
      const state = useTerminals.getState();
      const existingIds = state.sessions.filter(s => s.origin === 'overlay').map(s => s.id);
      if (existingIds.length === 0) {
        const newId = state.add({ origin: 'overlay' });
        state.setFocused(newId);
        if (detail.initialCommand) scheduleInitialCommand(newId, detail.initialCommand);
      } else if (detail.focusId && existingIds.includes(detail.focusId)) {
        state.setFocused(detail.focusId);
      }
      if (detail.fullscreen && detail.focusId) setFullscreenId(detail.focusId);
      else if (!detail.fullscreen) setFullscreenId(null);
      setOpen(true);
      setMinimized(false);
    };
    const onClose = () => setOpen(false);
    window.addEventListener(TERMINALS_OPEN_EVENT, onOpen);
    window.addEventListener(TERMINALS_CLOSE_EVENT, onClose);
    return () => { window.removeEventListener(TERMINALS_OPEN_EVENT, onOpen); window.removeEventListener(TERMINALS_CLOSE_EVENT, onClose); };
  }, []);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    if (!open || minimized) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        e.stopPropagation();
        if (fullscreenId) setFullscreenId(null);
        else setMinimized(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        handleAdd();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const state = useTerminals.getState();
        const tiles = state.sessions.filter(s => s.origin === 'overlay');
        const target = tiles[idx];
        if (target) {
          e.preventDefault();
          state.setFocused(target.id);
          if (fullscreenId) setFullscreenId(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, minimized, fullscreenId, handleAdd]);

  if (!open) return null;

  // ---- Minimized badge ----
  if (minimized || rect.w < 0) {
    return createPortal(
      <div
        onClick={() => { setMinimized(false); setOpen(true); }}
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          zIndex: 9990,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 16px',
          background: 'rgba(4,10,14,0.95)',
          border: '1px solid rgba(57,229,255,0.20)',
          borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
          cursor: 'pointer',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--cyan)',
          transition: 'transform 120ms ease, box-shadow 120ms ease',
        }}
        title="Click to restore terminal workspace"
      >
        <span style={{ fontSize: 14 }}>⌨</span>
        <span>{overlayIds.length} TERMINAL{overlayIds.length === 1 ? '' : 'S'}</span>
        <span
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#7dff9a', boxShadow: '0 0 4px #7dff9a',
          }}
        />
      </div>,
      document.body,
    );
  }

  const tileIds = fullscreenId ? overlayIds.filter(id => id === fullscreenId) : overlayIds;
  const isInteracting = windowActive || sidebarResizing;

  const windowStyle: CSSProperties = maximized
    ? { position: 'fixed', inset: 0, zIndex: 9990, borderRadius: 0, animation: 'termBoot 0.4s cubic-bezier(0.16, 1, 0.3, 1)', transformOrigin: 'center' }
    : { position: 'fixed', left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: 9990, borderRadius: 10, animation: 'termBoot 0.4s cubic-bezier(0.16, 1, 0.3, 1)', transformOrigin: 'center' };

  return createPortal(
    <div style={{ ...windowStyle, ...(isInteracting ? { userSelect: 'none' } : {}) }}>
      <style>{`
        @keyframes termBoot {
          0% { opacity: 0; transform: scale(0.95) translateY(10px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes eq {
          0% { transform: scaleY(0.2); }
          100% { transform: scaleY(1); }
        }
      `}</style>
      <div style={SHELL}>
        {/* ---- Window title bar ---- */}
        <div
          onMouseDown={startMove}
          onDoubleClick={toggleMax}
          style={{ ...WINDOW_HEADER, cursor: windowActive ? 'grabbing' : 'grab', borderRadius: maximized ? 0 : '10px 10px 0 0' }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13 }}>⌨</span>
            <span>Terminals</span>
            <span style={{ opacity: 0.4, fontSize: 9 }}>
              {overlayIds.length} session{overlayIds.length === 1 ? '' : 's'}
            </span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <WinBtn title="Export output to clipboard" onClick={handleExport}>📋</WinBtn>
            <WinBtn title="Clear all output" onClick={() => clearAllOutput()}>⌧</WinBtn>
            <WinBtn title="Minimize" onClick={() => setMinimized(true)}>⊖</WinBtn>
            <WinBtn title={maximized ? 'Restore' : 'Maximize'} onClick={e => { e.stopPropagation(); toggleMax(); }}>
              {maximized ? '⊗' : '⊡'}
            </WinBtn>
            <WinBtn title="Close (Esc)" onClick={e => { e.stopPropagation(); setOpen(false); }} danger>✕</WinBtn>
          </span>
        </div>

        {/* ---- Content area ---- */}
        <div style={{ flex: '1 1 auto', display: 'flex', minHeight: 0 }}>
          <Sidebar
            overlayIds={overlayIds}
            dashboardIds={dashboardIds}
            focusedId={focusedId}
            width={sidebarWidth}
            onFocus={id => { setFocused(id); if (fullscreenId && fullscreenId !== id) setFullscreenId(id); }}
            onAdd={handleAdd}
            onClose={() => setMinimized(true)}
          />
          {/* Inner sidebar resize */}
          <div
            onMouseDown={startSidebarResize}
            onMouseEnter={() => setSidebarHover(true)}
            onMouseLeave={() => setSidebarHover(false)}
            style={{ ...RESIZE_HANDLE, background: sidebarResizing ? 'rgba(57,229,255,0.25)' : sidebarHover ? 'rgba(57,229,255,0.12)' : 'transparent' }}
          >
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 2, height: 32, borderRadius: 1, background: sidebarResizing || sidebarHover ? 'rgba(57,229,255,0.4)' : 'rgba(57,229,255,0.08)', transition: 'background 120ms ease' }} />
          </div>
          <div style={RIGHT_PANE}>
            <HeaderBar
              layout={layout} onLayout={setLayout}
              fullscreenId={fullscreenId} onExitFullscreen={() => setFullscreenId(null)}
              overlayCount={overlayIds.length} onAdd={handleAdd}
            />
            <TabStrip
              ids={overlayIds} focusedId={focusedId}
              onFocus={id => { setFocused(id); if (fullscreenId && fullscreenId !== id) setFullscreenId(id); }}
              onClose={handleRemove}
            />
            <TileGrid
              tileIds={tileIds} layout={layout}
              fullscreenId={fullscreenId} focusedId={focusedId}
              onFullscreen={id => setFullscreenId(curr => (curr === id ? null : id))}
              onClose={handleRemove} onFocus={id => setFocused(id)} onAdd={handleAdd}
            />
            <StatusBar focusedId={focusedId} />
          </div>
        </div>
      </div>
      {!maximized && <ResizeEdges onStart={startEdge} />}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Window control button
// ---------------------------------------------------------------------------

function WinBtn({ title, onClick, children, danger }: {
  title: string; onClick: (e: React.MouseEvent) => void; children: React.ReactNode; danger?: boolean;
}) {
  return (
    <button type="button" title={title} onClick={onClick}
      style={{ ...PILL_BTN, fontSize: 11, padding: '2px 8px', lineHeight: 1, color: danger ? '#ff4d5e' : 'var(--cyan)', borderColor: danger ? 'rgba(255,77,94,0.25)' : undefined }}
    >{children}</button>
  );
}

// ---------------------------------------------------------------------------
// ResizeEdges
// ---------------------------------------------------------------------------

function ResizeEdges({ onStart }: { onStart: (edge: Edge, e: React.MouseEvent) => void }) {
  const E = 6;
  const zones: ReadonlyArray<{ edge: Edge; cursor: string; style: CSSProperties }> = [
    { edge: 'n',  cursor: 'ns-resize',   style: { top: 0, left: E * 2, right: E * 2, height: E } },
    { edge: 's',  cursor: 'ns-resize',   style: { bottom: 0, left: E * 2, right: E * 2, height: E } },
    { edge: 'w',  cursor: 'ew-resize',   style: { left: 0, top: E * 2, bottom: E * 2, width: E } },
    { edge: 'e',  cursor: 'ew-resize',   style: { right: 0, top: E * 2, bottom: E * 2, width: E } },
    { edge: 'nw', cursor: 'nwse-resize', style: { top: 0, left: 0, width: E * 2, height: E * 2 } },
    { edge: 'ne', cursor: 'nesw-resize', style: { top: 0, right: 0, width: E * 2, height: E * 2 } },
    { edge: 'sw', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: E * 2, height: E * 2 } },
    { edge: 'se', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: E * 2, height: E * 2 } },
  ];
  return <>{zones.map(z => <div key={z.edge} onMouseDown={e => onStart(z.edge, e)} style={{ position: 'absolute', ...z.style, cursor: z.cursor, zIndex: 3 }} />)}</>;
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

function StatusBar({ focusedId }: { focusedId: string | null }) {
  const info = useTerminals(
    useShallow((s: TerminalsState) => {
      if (!focusedId) return null;
      const session = s.sessions.find(x => x.id === focusedId);
      if (!session) return null;
      return {
        title: session.title, cwd: session.cwd, running: session.running,
        color: session.color, created_at: session.created_at,
        connected: session.sessionId !== null,
        outputBytes: session.outputBytes, commandCount: session.commandCount,
      };
    }),
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(t); }, []);

  if (!info) return <div style={STATUS_BAR}><span style={{ opacity: 0.5 }}>No terminal focused</span></div>;

  const accent = info.color ? TERMINAL_COLORS[info.color] ?? 'var(--cyan)' : 'var(--cyan)';
  const tokens = Math.round(info.outputBytes / 4);

  return (
    <div style={STATUS_BAR}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: info.connected ? '#7dff9a' : '#ff4d5e', boxShadow: info.connected ? '0 0 4px #7dff9a' : '0 0 4px #ff4d5e' }} title={info.connected ? 'Connected' : 'Disconnected'} />
      <span style={{ color: accent, fontWeight: 600, letterSpacing: '0.1em' }}>{info.title}</span>
      {info.cwd && <span title={info.cwd}><span style={{ opacity: 0.5, marginRight: 3 }}>📁</span>{shortenPath(info.cwd)}</span>}
      {info.running && <span><span style={{ opacity: 0.5, marginRight: 3 }}>⚡</span>{info.running}</span>}
      <span><span style={{ opacity: 0.5, marginRight: 3 }}>📊</span>{formatBytes(info.outputBytes)}</span>
      <span><span style={{ opacity: 0.5, marginRight: 3 }}>🪙</span>~{tokens.toLocaleString()} tok</span>
      <span><span style={{ opacity: 0.5, marginRight: 3 }}>⌨</span>{info.commandCount} cmd{info.commandCount === 1 ? '' : 's'}</span>
      <span><span style={{ opacity: 0.5, marginRight: 3 }}>⏱</span>{formatUptime(now - info.created_at)}</span>
      <span style={{ marginLeft: 'auto', opacity: 0.35, fontSize: 9, letterSpacing: '0.14em' }}>⌘T NEW · ESC MIN</span>
    </div>
  );
}
