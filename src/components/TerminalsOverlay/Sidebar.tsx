// TerminalsOverlay/Sidebar.tsx
//
// Sidebar panel: filter bar, drag-to-reorder rows, color tags, inline
// rename, quick-action buttons (duplicate / close), Workspace + Dashboard
// sections, and the "New terminal" button.

import {
  memo,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTerminals, type TerminalColor, type TerminalsState } from '../../store/terminals';
import {
  SIDEBAR,
  SIDEBAR_HEADER,
  SIDEBAR_TITLE,
  ADD_BTN,
  RENAME_INPUT,
  FILTER_INPUT,
  PILL_BTN,
  TERMINAL_COLORS,
  COLOR_NAMES,
  shortenPath,
} from './styles';

// ---------------------------------------------------------------------------
// Sidebar shell
// ---------------------------------------------------------------------------

export function Sidebar({
  overlayIds,
  dashboardIds,
  focusedId,
  onFocus,
  onAdd,
  onClose,
  width,
}: {
  overlayIds: ReadonlyArray<string>;
  dashboardIds: ReadonlyArray<string>;
  focusedId: string | null;
  onFocus: (id: string) => void;
  onAdd: () => void;
  onClose: () => void;
  width?: number;
}) {
  const [filter, setFilter] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const reorder = useTerminals(s => s.reorderOverlay);

  const handleDrop = useCallback(
    (toIndex: number) => {
      if (dragIdx !== null && dragIdx !== toIndex) reorder(dragIdx, toIndex);
      setDragIdx(null);
      setDropIdx(null);
    },
    [dragIdx, reorder],
  );

  const filterLower = filter.toLowerCase();
  const filteredOverlay = filterLower.length > 0
    ? overlayIds.filter(id => {
        const s = useTerminals.getState().sessions.find(x => x.id === id);
        return s && s.title.toLowerCase().includes(filterLower);
      })
    : overlayIds;

  return (
    <aside style={{ ...SIDEBAR, ...(width ? { flex: `0 0 ${width}px` } : {}) }}>
      <div style={SIDEBAR_HEADER}>
        <span style={SIDEBAR_TITLE}>Terminals</span>
        <button
          type="button"
          onClick={onClose}
          title="Close workspace (Esc)"
          style={PILL_BTN}
          aria-label="Close terminals workspace"
        >
          ESC
        </button>
      </div>

      {/* ---- Filter ---- */}
      <div style={{ padding: '10px 16px 6px', position: 'relative' }}>
        <span
          style={{
            position: 'absolute',
            left: 26,
            top: 18,
            fontSize: 11,
            opacity: 0.5,
            pointerEvents: 'none',
          }}
        >
          ⌕
        </span>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter terminals…"
          spellCheck={false}
          style={FILTER_INPUT}
        />
      </div>

      {/* ---- Scrollable list ---- */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '4px 0' }}>
        <SidebarSection label="Workspace">
          {filteredOverlay.length === 0 ? (
            <div style={SIDEBAR_EMPTY}>
              {filter.length > 0
                ? 'No matching terminals.'
                : 'No terminals yet — add one below.'}
            </div>
          ) : (
            filteredOverlay.map((id, i) => (
              <SidebarRow
                key={id}
                id={id}
                index={i}
                active={focusedId === id}
                onClick={() => onFocus(id)}
                hotkey={i < 9 ? `⌘${i + 1}` : undefined}
                isDragTarget={dropIdx === i}
                onDragStart={() => setDragIdx(i)}
                onDragOver={idx => setDropIdx(idx)}
                onDrop={() => handleDrop(i)}
                onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
              />
            ))
          )}
        </SidebarSection>

        {dashboardIds.length > 0 ? (
          <SidebarSection label="Dashboard">
            {dashboardIds.map(id => (
              <SidebarRow key={id} id={id} index={-1} active={false} dim />
            ))}
          </SidebarSection>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onAdd}
        style={ADD_BTN}
        title="New terminal (⌘T)"
      >
        <span style={{ fontSize: 14, lineHeight: 1 }}>＋</span>
        <span>New terminal</span>
        <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 9 }}>⌘T</span>
      </button>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function SidebarSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          padding: '8px 20px',
          fontSize: 9,
          letterSpacing: '0.24em',
          textTransform: 'uppercase',
          color: 'rgba(230,248,255,0.38)',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SidebarRow — memoized, narrow subscription, drag-to-reorder.
// ---------------------------------------------------------------------------

const SidebarRow = memo(function SidebarRow({
  id,
  index,
  active,
  onClick,
  dim,
  hotkey,
  isDragTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  id: string;
  index: number;
  active: boolean;
  onClick?: () => void;
  dim?: boolean;
  hotkey?: string;
  isDragTarget?: boolean;
  onDragStart?: () => void;
  onDragOver?: (idx: number) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}) {
  const row = useTerminals(
    useShallow((s: TerminalsState) => {
      const session = s.sessions.find(x => x.id === id);
      if (!session) return { present: false as const };
      return {
        present: true as const,
        title: session.title,
        running: session.running,
        cwd: session.cwd,
        hasActivity: session.activity_tick > session.last_seen_tick,
        color: session.color,
        outputBytes: session.outputBytes,
        commandCount: session.commandCount,
      };
    }),
  );
  const setTitle = useTerminals(s => s.setTitle);
  const setColor = useTerminals(s => s.setColor);
  const duplicateTerm = useTerminals(s => s.duplicate);
  const removeTerm = useTerminals(s => s.remove);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [hovered, setHovered] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  if (!row.present) return null;

  const subtitle = row.running
    ? row.running
    : row.cwd
    ? shortenPath(row.cwd)
    : '—';

  const accentColor = row.color ? TERMINAL_COLORS[row.color] ?? 'var(--cyan)' : 'var(--cyan)';

  const style: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    textAlign: 'left',
    border: 0,
    padding: '9px 20px 9px 12px',
    background: active
      ? `linear-gradient(90deg, rgba(57,229,255,0.08), transparent)`
      : hovered
      ? 'rgba(57,229,255,0.03)'
      : 'transparent',
    borderLeft: active ? `2px solid ${accentColor}` : '2px solid transparent',
    borderTop: isDragTarget ? '2px solid var(--cyan)' : '2px solid transparent',
    color: dim ? 'rgba(230,248,255,0.55)' : accentColor,
    cursor: onClick ? 'pointer' : 'default',
    fontFamily: 'var(--mono)',
    transition: 'background 100ms ease, border-color 100ms ease',
    position: 'relative',
  };

  const commitRename = () => {
    const t = draft.trim();
    if (t.length > 0) setTitle(id, t, { pin: true });
    setRenaming(false);
  };

  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && onClick) {
      e.preventDefault();
      onClick();
    }
  };

  const cycleColor = (e: React.MouseEvent) => {
    e.stopPropagation();
    const currentIdx = row.color ? COLOR_NAMES.indexOf(row.color) : -1;
    const nextColor = COLOR_NAMES[(currentIdx + 1) % COLOR_NAMES.length] as TerminalColor;
    setColor(id, nextColor);
  };

  const handleDragStart = (e: DragEvent) => {
    if (dim) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    onDragStart?.();
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOver?.(index);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    onDrop?.();
  };

  return (
    <div
      ref={rowRef}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : -1}
      draggable={!dim}
      onClick={onClick}
      onKeyDown={onRowKeyDown}
      onDoubleClick={() => {
        if (dim) return;
        setDraft(row.title);
        setRenaming(true);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={() => onDragEnd?.()}
      style={style}
      title={onClick ? 'Click to focus · double-click to rename · drag to reorder' : undefined}
    >
      {/* Drag handle */}
      {!dim && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            opacity: hovered ? 0.7 : 0.2,
            cursor: 'grab',
            transition: 'opacity 120ms ease',
            letterSpacing: '-0.05em',
            lineHeight: 1,
            userSelect: 'none',
          }}
          aria-hidden="true"
        >
          ⠿
        </span>
      )}

      {/* Activity Equalizer or Static Color Dot */}
      {row.hasActivity && !active ? (
        <div
          onClick={!dim ? cycleColor : undefined}
          title={!dim ? 'Click to cycle color' : undefined}
          style={{
            flexShrink: 0,
            width: 9,
            height: 9,
            display: 'flex',
            alignItems: 'flex-end',
            gap: 1,
            cursor: !dim ? 'pointer' : 'default',
          }}
        >
          <div style={{ width: 2, height: '100%', background: accentColor, animation: 'eq 0.8s ease-in-out infinite alternate', transformOrigin: 'bottom', boxShadow: `0 0 4px ${accentColor}` }} />
          <div style={{ width: 2, height: '100%', background: accentColor, animation: 'eq 0.8s ease-in-out infinite alternate -0.4s', transformOrigin: 'bottom', boxShadow: `0 0 4px ${accentColor}` }} />
          <div style={{ width: 2, height: '100%', background: accentColor, animation: 'eq 0.8s ease-in-out infinite alternate -0.2s', transformOrigin: 'bottom', boxShadow: `0 0 4px ${accentColor}` }} />
        </div>
      ) : (
        <span
          onClick={!dim ? cycleColor : undefined}
          title={!dim ? 'Click to cycle color' : undefined}
          style={{
            flexShrink: 0,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: row.color ? TERMINAL_COLORS[row.color] ?? 'transparent' : 'transparent',
            border: row.color ? `1px solid ${TERMINAL_COLORS[row.color]}` : '1px solid rgba(255,255,255,0.1)',
            transition: 'background 160ms ease',
            cursor: !dim ? 'pointer' : 'default',
          }}
        />
      )}

      {/* Title + subtitle */}
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
              e.stopPropagation();
            }}
            onClick={e => e.stopPropagation()}
            style={RENAME_INPUT}
            spellCheck={false}
          />
        ) : (
          <div
            style={{
              fontSize: 12,
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {row.title}
          </div>
        )}
        <div
          style={{
            marginTop: 2,
            fontSize: 10,
            color: 'rgba(230,248,255,0.42)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {subtitle}
        </div>
        {/* Stats line */}
        {(row.outputBytes > 0 || row.commandCount > 0) && (
          <div
            style={{
              marginTop: 1,
              fontSize: 9,
              color: 'rgba(230,248,255,0.30)',
              letterSpacing: '0.06em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {row.outputBytes > 0 && (
              <span style={{ marginRight: 8 }}>
                📊 {row.outputBytes < 1024 ? `${row.outputBytes}B` : row.outputBytes < 1048576 ? `${(row.outputBytes / 1024).toFixed(1)}KB` : `${(row.outputBytes / 1048576).toFixed(1)}MB`}
              </span>
            )}
            {row.outputBytes > 0 && (
              <span style={{ marginRight: 8 }}>🪙 ~{Math.round(row.outputBytes / 4).toLocaleString()} tok</span>
            )}
            {row.commandCount > 0 && (
              <span>⌨ {row.commandCount} cmd{row.commandCount === 1 ? '' : 's'}</span>
            )}
          </div>
        )}
      </div>

      {/* Quick actions on hover */}
      {hovered && !dim && !renaming ? (
        <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
          <MicroBtn
            title="Duplicate"
            onClick={e => { e.stopPropagation(); duplicateTerm(id); }}
          >
            ⊕
          </MicroBtn>
          <MicroBtn
            title="Close"
            onClick={e => { e.stopPropagation(); removeTerm(id); }}
          >
            ✕
          </MicroBtn>
        </span>
      ) : hotkey ? (
        <span
          style={{
            flexShrink: 0,
            fontSize: 9,
            opacity: 0.45,
            letterSpacing: '0.14em',
          }}
        >
          {hotkey}
        </span>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Tiny action button
// ---------------------------------------------------------------------------

function MicroBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        padding: 0,
        margin: 0,
        border: '1px solid rgba(57,229,255,0.2)',
        background: 'rgba(57,229,255,0.06)',
        color: 'var(--cyan)',
        borderRadius: 3,
        cursor: 'pointer',
        fontSize: 10,
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

const SIDEBAR_EMPTY: CSSProperties = {
  padding: '8px 20px',
  fontSize: 10,
  color: 'rgba(230,248,255,0.38)',
  letterSpacing: '0.08em',
};
