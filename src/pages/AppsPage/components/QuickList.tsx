/**
 * QuickList — pinned favorites strip with drag-to-reorder.
 *
 * Renders as a compact horizontal scroll row above the main grid.
 * Drag-and-drop reordering is done via the HTML5 Drag API — no extra deps.
 * Items fire onLaunch on click, onReorder when a drag completes.
 */
import { useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import type { App } from '../types';

type Props = {
  readonly apps: readonly App[];
  readonly iconCache: ReadonlyMap<string, string>;
  readonly runningSet: ReadonlySet<string>;
  readonly onLaunch: (name: string) => void;
  readonly onReorder: (newOrder: readonly string[]) => void;
};

const stripStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  overflowX: 'auto',
  paddingBottom: 4,
  alignItems: 'center',
};

const itemBase: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
  padding: '6px 8px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.55)',
  cursor: 'grab',
  minWidth: 56,
  flexShrink: 0,
  position: 'relative',
  transition: 'border-color 0.15s ease, background 0.15s ease',
};

const nameStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.06em',
  color: 'var(--ink-2)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 52,
};

const dotStyle: CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  width: 5,
  height: 5,
  borderRadius: '50%',
  background: 'var(--green)',
  boxShadow: '0 0 4px rgba(125, 255, 154, 0.8)',
};

export function QuickList({ apps, iconCache, runningSet, onLaunch, onReorder }: Props) {
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  if (apps.length === 0) return null;

  const onDragStart = (idx: number) => (e: DragEvent) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (idx: number) => (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverIdx(idx);
  };

  const onDrop = (dropIdx: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = dragIdx.current;
    dragIdx.current = null;
    setOverIdx(null);
    if (from === null || from === dropIdx) return;
    const next = [...apps.map(a => a.name)];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(dropIdx, 0, moved);
    onReorder(next);
  };

  const onDragEnd = () => {
    dragIdx.current = null;
    setOverIdx(null);
  };

  return (
    <div style={stripStyle} aria-label="Quick-launch favorites">
      {apps.map((app, idx) => {
        const icon = iconCache.get(app.path);
        const isRunning = runningSet.has(app.name);
        const isDragOver = overIdx === idx;
        return (
          <div
            key={app.path}
            role="button"
            tabIndex={0}
            draggable
            title={`${app.name}${isRunning ? ' · running' : ''}`}
            onClick={() => onLaunch(app.name)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLaunch(app.name); }
            }}
            onDragStart={onDragStart(idx)}
            onDragOver={onDragOver(idx)}
            onDrop={onDrop(idx)}
            onDragEnd={onDragEnd}
            style={{
              ...itemBase,
              borderColor: isDragOver ? 'var(--cyan)' : isRunning ? 'rgba(125, 255, 154, 0.4)' : 'var(--line-soft)',
              background: isDragOver ? 'rgba(57, 229, 255, 0.12)' : isRunning ? 'rgba(125, 255, 154, 0.04)' : 'rgba(6, 14, 22, 0.55)',
            }}
          >
            {isRunning && <span style={dotStyle} aria-hidden="true" />}
            {icon ? (
              <img
                src={`data:image/png;base64,${icon}`}
                alt=""
                draggable={false}
                style={{ width: 24, height: 24, objectFit: 'contain' }}
              />
            ) : (
              <span
                style={{
                  width: 24,
                  height: 24,
                  border: '1px solid var(--line-soft)',
                  background: 'rgba(57, 229, 255, 0.04)',
                  display: 'block',
                }}
              />
            )}
            <span style={nameStyle}>{app.name}</span>
          </div>
        );
      })}
    </div>
  );
}
