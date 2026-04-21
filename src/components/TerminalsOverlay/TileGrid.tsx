// TerminalsOverlay/TileGrid.tsx
//
// Right-pane content: layout-mode header bar + a grid / row / column /
// single-tile view of PtyTerminal instances. Each TileHost is memoized
// with a narrow subscription for perf.

import {
  memo,
  useState,
  type CSSProperties,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { PtyTerminal } from '../PtyTerminal';
import { useTerminals, type TerminalsState } from '../../store/terminals';
import {
  HEADER_BAR,
  PILL_BTN,
  ADD_BTN,
  EMPTY_STATE,
  TAB_STRIP,
  shortenPath,
  TERMINAL_COLORS,
  type LayoutMode,
} from './styles';

// ---------------------------------------------------------------------------
// HeaderBar — layout mode buttons + stats
// ---------------------------------------------------------------------------

export function HeaderBar({
  layout,
  onLayout,
  fullscreenId,
  onExitFullscreen,
  overlayCount,
  onAdd,
}: {
  layout: LayoutMode;
  onLayout: (m: LayoutMode) => void;
  fullscreenId: string | null;
  onExitFullscreen: () => void;
  overlayCount: number;
  onAdd: () => void;
}) {
  const modes: Array<{ id: LayoutMode; icon: string; label: string }> = [
    { id: 'grid', icon: '⊞', label: 'Grid' },
    { id: 'rows', icon: '☰', label: 'Rows' },
    { id: 'cols', icon: '∥', label: 'Columns' },
    { id: 'single', icon: '▣', label: 'Single' },
  ];

  return (
    <div style={HEADER_BAR}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <span>
          {fullscreenId
            ? 'FULLSCREEN'
            : `${overlayCount} TILE${overlayCount === 1 ? '' : 'S'}`}
        </span>
        {!fullscreenId && (
          <span style={{ display: 'inline-flex', gap: 3 }}>
            {modes.map(m => (
              <button
                key={m.id}
                type="button"
                onClick={() => onLayout(m.id)}
                title={m.label}
                style={{
                  ...PILL_BTN,
                  background: layout === m.id
                    ? 'rgba(57,229,255,0.14)'
                    : 'rgba(57,229,255,0.03)',
                  borderColor: layout === m.id
                    ? 'rgba(57,229,255,0.35)'
                    : 'rgba(57,229,255,0.12)',
                  fontSize: 12,
                  padding: '2px 7px',
                  lineHeight: 1,
                }}
              >
                {m.icon}
              </button>
            ))}
          </span>
        )}
      </span>

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {fullscreenId ? (
          <button type="button" onClick={onExitFullscreen} style={PILL_BTN}>
            EXIT FULLSCREEN
          </button>
        ) : (
          <>
            <button type="button" onClick={onAdd} style={PILL_BTN}>
              ＋ ADD
            </button>
            <span
              style={{
                opacity: 0.45,
                fontSize: 9,
                letterSpacing: '0.14em',
              }}
            >
              ⌘T NEW · ⌘F FIND · ESC CLOSE
            </span>
          </>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabStrip — horizontal terminal tabs for quick switching
// ---------------------------------------------------------------------------

export function TabStrip({
  ids,
  focusedId,
  onFocus,
  onClose,
}: {
  ids: ReadonlyArray<string>;
  focusedId: string | null;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
}) {
  if (ids.length <= 1) return null;
  return (
    <div style={TAB_STRIP}>
      {ids.map(id => (
        <Tab
          key={id}
          id={id}
          active={id === focusedId}
          onFocus={() => onFocus(id)}
          onClose={() => onClose(id)}
        />
      ))}
    </div>
  );
}

const Tab = memo(function Tab({
  id,
  active,
  onFocus,
  onClose,
}: {
  id: string;
  active: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const meta = useTerminals(
    useShallow((s: TerminalsState) => {
      const session = s.sessions.find(x => x.id === id);
      if (!session) return { present: false as const };
      return {
        present: true as const,
        title: session.title || 'terminal',
        color: session.color,
      };
    }),
  );
  const [hovered, setHovered] = useState(false);
  if (!meta.present) return null;

  const accent = meta.color
    ? TERMINAL_COLORS[meta.color] ?? 'var(--cyan)'
    : 'var(--cyan)';

  return (
    <div
      onClick={onFocus}
      onDoubleClick={onFocus}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 14px',
        fontSize: 10,
        letterSpacing: '0.06em',
        color: active ? accent : 'rgba(230,248,255,0.5)',
        background: active
          ? 'rgba(57,229,255,0.04)'
          : hovered
          ? 'rgba(57,229,255,0.02)'
          : 'transparent',
        borderBottom: active
          ? `2px solid ${accent}`
          : '2px solid transparent',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition:
          'color 100ms ease, background 100ms ease, border-color 100ms ease',
        userSelect: 'none',
      }}
    >
      {meta.color && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: TERMINAL_COLORS[meta.color] ?? accent,
            flexShrink: 0,
          }}
        />
      )}
      <span
        style={{
          maxWidth: 120,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {meta.title}
      </span>
      {hovered && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onClose();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            padding: 0,
            margin: 0,
            border: 'none',
            background: 'rgba(57,229,255,0.1)',
            color: 'var(--cyan)',
            borderRadius: 2,
            cursor: 'pointer',
            fontSize: 8,
            lineHeight: 1,
          }}
          aria-label="Close tab"
        >
          ✕
        </button>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// TileGrid — renders terminals in the selected layout
// ---------------------------------------------------------------------------

export function TileGrid({
  tileIds,
  layout,
  fullscreenId,
  focusedId,
  onFullscreen,
  onClose,
  onFocus,
  onAdd,
}: {
  tileIds: ReadonlyArray<string>;
  layout: LayoutMode;
  fullscreenId: string | null;
  focusedId: string | null;
  onFullscreen: (id: string) => void;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
  onAdd: () => void;
}) {
  if (tileIds.length === 0) return <EmptyState onAdd={onAdd} />;

  const effectiveLayout = fullscreenId ? 'single' : layout;
  const visibleIds =
    effectiveLayout === 'single'
      ? tileIds.filter(id => id === (fullscreenId ?? focusedId ?? tileIds[0]))
      : tileIds;

  const gridStyle = getGridStyle(effectiveLayout, visibleIds.length);

  return (
    <div style={gridStyle}>
      {visibleIds.map(tid => (
        <TileHost
          key={tid}
          id={tid}
          isFocused={tid === focusedId}
          onFullscreen={() => onFullscreen(tid)}
          onClose={() => onClose(tid)}
          onFocus={() => onFocus(tid)}
        />
      ))}
    </div>
  );
}

function getGridStyle(
  layout: LayoutMode,
  count: number,
): CSSProperties {
  const base: CSSProperties = {
    flex: '1 1 auto',
    minHeight: 0,
    minWidth: 0,
    padding: 14,
    display: 'grid',
    gap: 12,
    overflow: 'hidden',
  };

  switch (layout) {
    case 'grid':
      return {
        ...base,
        gridTemplateColumns: `repeat(${Math.max(1, Math.min(count, 3))}, 1fr)`,
        gridAutoRows: '1fr',
      };
    case 'rows':
      return {
        ...base,
        gridTemplateColumns: '1fr',
        gridAutoRows: '1fr',
      };
    case 'cols':
      return {
        ...base,
        gridTemplateColumns: `repeat(${count}, 1fr)`,
        gridTemplateRows: '1fr',
      };
    case 'single':
      return {
        ...base,
        gridTemplateColumns: '1fr',
        gridTemplateRows: '1fr',
      };
  }
}

// ---------------------------------------------------------------------------
// TileHost — memoized with narrow subscription per tile.
// ---------------------------------------------------------------------------

export const TileHost = memo(function TileHost({
  id,
  isFocused,
  onFullscreen,
  onClose,
  onFocus,
}: {
  id: string;
  isFocused: boolean;
  onFullscreen: () => void;
  onClose: () => void;
  onFocus: () => void;
}) {
  const meta = useTerminals(
    useShallow((s: TerminalsState) => {
      const session = s.sessions.find(x => x.id === id);
      if (!session) return { present: false as const };
      return {
        present: true as const,
        title: session.title || 'terminal',
        small: session.running ?? (session.cwd ? shortenPath(session.cwd) : 'zsh'),
        color: session.color,
      };
    }),
  );
  if (!meta.present) return null;

  const borderColor = meta.color
    ? TERMINAL_COLORS[meta.color] ?? 'var(--cyan)'
    : 'var(--cyan)';

  return (
    <div
      onClick={onFocus}
      style={{
        minHeight: 0,
        minWidth: 0,
        height: '100%',
        overflow: 'hidden',
        outline: isFocused ? `1px solid ${borderColor}` : '1px solid transparent',
        outlineOffset: -1,
        borderRadius: 4,
        transition: 'outline-color 0.2s ease, box-shadow 0.2s ease',
        boxShadow: isFocused
          ? `0 0 16px ${borderColor}25, inset 0 0 10px ${borderColor}12`
          : 'none',
      }}
    >
      <PtyTerminal
        id={id}
        panelId={`overlay-${id}`}
        title={meta.title}
        small={meta.small}
        chromeless
        onExpand={onFullscreen}
        onClose={onClose}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div style={EMPTY_STATE}>
      <div
        style={{
          fontSize: 28,
          opacity: 0.25,
          marginBottom: 4,
        }}
      >
        ⌨
      </div>
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
        }}
      >
        No terminals in workspace
      </div>
      <button
        type="button"
        onClick={onAdd}
        style={{ ...ADD_BTN, width: 'auto', padding: '10px 18px', borderRadius: 5, borderTop: 'none', border: '1px solid rgba(57,229,255,0.15)' }}
      >
        <span style={{ fontSize: 14 }}>＋</span>
        <span>New terminal</span>
      </button>
    </div>
  );
}
