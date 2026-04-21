import { useRef, useState } from 'react';
import { Chip } from '../_shared';
import type { Reminder } from './api';

type Props = {
  task: Reminder;
  selected?: boolean;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onClick?: (e: React.MouseEvent) => void;
};

function dueTone(due: string | null): 'red' | 'amber' | 'cyan' | null {
  if (!due) return null;
  const ts = new Date(due).getTime();
  if (isNaN(ts)) return null;
  const now = Date.now();
  const dayMs = 86_400_000;
  if (ts < now) return 'red';
  if (ts < now + dayMs) return 'amber';
  return 'cyan';
}

/** Short human-friendly relative due label: "OVERDUE", "TODAY", "TOMORROW", "FRI", "MAR 14". */
function dueLabel(due: string | null): string | null {
  if (!due) return null;
  const date = new Date(due);
  const ts = date.getTime();
  if (isNaN(ts)) return null;
  const now = new Date();
  const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const todayEnd = todayStart + 86_400_000;
  if (ts < now.getTime() && ts < todayStart) return 'OVERDUE';
  if (ts < todayStart) return 'OVERDUE';
  if (ts < todayEnd) return 'TODAY';
  if (ts < todayEnd + 86_400_000) return 'TOMORROW';
  if (ts < todayEnd + 6 * 86_400_000) {
    return date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

/** Derive P1/P2/P3 from title prefix bangs or keyword scan. Returns null when no priority signal. */
export function derivePriority(title: string): 'P1' | 'P2' | 'P3' | null {
  if (title.startsWith('!!!')) return 'P1';
  if (title.startsWith('!!')) return 'P2';
  if (title.startsWith('!')) return 'P3';
  const lower = title.toLowerCase();
  if (/\b(urgent|asap)\b/.test(lower)) return 'P1';
  if (/\bdeadline\b/.test(lower)) return 'P2';
  return null;
}

const PRIORITY_TONE: Record<string, 'red' | 'amber' | 'gold'> = {
  P1: 'red',
  P2: 'amber',
  P3: 'gold',
};

/** Strip leading ! prefixes from the display title. */
function displayTitle(title: string): string {
  return title.replace(/^!{1,3}\s*/, '');
}

export function TaskRow({ task, selected, onComplete, onDelete, onRename, onClick }: Props) {
  const tone = dueTone(task.due);
  const priority = derivePriority(task.title);

  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const startEdit = () => {
    setEditVal(task.title);
    setEditing(true);
    // Focus on next paint
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const commitEdit = () => {
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== task.title) {
      onRename(task.id, trimmed);
    }
    setEditing(false);
  };

  const selBorder = selected
    ? '2px solid var(--cyan)'
    : tone
      ? `2px solid var(--${tone})`
      : '2px solid var(--line-soft)';

  const label = dueLabel(task.due);
  const dueColor = tone ? `var(--${tone})` : 'var(--ink-dim)';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '9px 12px',
        border: selected ? '1px solid var(--cyan)' : '1px solid var(--line-soft)',
        borderLeft: selBorder,
        background: selected
          ? 'rgba(57, 229, 255, 0.08)'
          : task.completed
            ? 'rgba(6, 14, 22, 0.35)'
            : 'rgba(6, 14, 22, 0.55)',
        cursor: 'default',
        userSelect: 'none',
        transition: 'background 120ms ease, border-color 120ms ease',
        opacity: task.completed ? 0.7 : 1,
      }}
      onMouseEnter={e => {
        if (!selected) e.currentTarget.style.borderColor = 'rgba(57, 229, 255, 0.45)';
      }}
      onMouseLeave={e => {
        if (!selected) e.currentTarget.style.borderColor = 'var(--line-soft)';
      }}
    >
      {/* Complete checkbox — circular, accented, animated */}
      <button
        aria-label={task.completed ? 'Completed' : 'Complete task'}
        aria-pressed={task.completed}
        onClick={e => { e.stopPropagation(); onComplete(task.id); }}
        style={{
          all: 'unset', cursor: 'pointer',
          width: 18, height: 18,
          borderRadius: '50%',
          border: task.completed ? '1.5px solid var(--green)' : '1.5px solid var(--cyan)',
          background: task.completed ? 'rgba(125, 255, 154, 0.25)' : 'transparent',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          transition: 'background 160ms ease, border-color 160ms ease, transform 120ms ease',
          boxSizing: 'border-box',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = task.completed
            ? 'rgba(125, 255, 154, 0.35)'
            : 'rgba(57, 229, 255, 0.2)';
          e.currentTarget.style.transform = 'scale(1.08)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = task.completed ? 'rgba(125, 255, 154, 0.25)' : 'transparent';
          e.currentTarget.style.transform = 'none';
        }}
      >
        {task.completed && (
          <svg width="10" height="10" viewBox="0 0 10 10" style={{ display: 'block' }}>
            <polyline
              points="1.5,5.2 4,7.6 8.5,2.5"
              fill="none"
              stroke="var(--green)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      {/* Priority badge */}
      {priority && (
        <Chip tone={PRIORITY_TONE[priority]}>{priority}</Chip>
      )}

      {/* Title / inline editor */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {editing ? (
          <input
            ref={inputRef}
            value={editVal}
            autoFocus
            onChange={e => setEditVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={commitEdit}
            onClick={e => e.stopPropagation()}
            style={{
              all: 'unset',
              fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink)',
              background: 'rgba(57, 229, 255, 0.08)',
              padding: '1px 4px',
              width: '100%',
              border: '1px solid var(--cyan)',
            }}
          />
        ) : (
          <div
            onDoubleClick={e => { e.stopPropagation(); startEdit(); }}
            title="Double-click to rename"
            style={{
              fontFamily: 'var(--label)', fontSize: 13,
              color: task.completed ? 'var(--ink-dim)' : 'var(--ink)',
              textDecoration: task.completed ? 'line-through' : 'none',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {displayTitle(task.title)}
          </div>
        )}
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <Chip tone="dim">{task.list}</Chip>
          {task.notes && (
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flex: 1, minWidth: 0,
            }}>
              {task.notes}
            </span>
          )}
        </div>
      </div>

      {label && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2,
          flexShrink: 0,
        }}>
          <Chip tone={tone ?? 'cyan'} style={{ fontSize: 8 }}>{label}</Chip>
          {task.due && label !== 'OVERDUE' && label !== 'TODAY' && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: dueColor, opacity: 0.75 }}>
              {new Date(task.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
      )}

      <button
        aria-label="Delete task"
        title="Delete"
        onClick={e => { e.stopPropagation(); onDelete(task.id); }}
        style={{
          all: 'unset', cursor: 'pointer',
          padding: '2px 6px',
          fontFamily: 'var(--mono)', fontSize: 14, lineHeight: 1,
          color: 'var(--ink-dim)',
          transition: 'color 140ms, transform 140ms',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; e.currentTarget.style.transform = 'scale(1.15)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-dim)'; e.currentTarget.style.transform = 'none'; }}
      >×</button>
    </div>
  );
}
