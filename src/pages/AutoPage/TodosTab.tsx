import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTasks } from '../../store/tasks';
import { ProgressRing } from '../_shared';

type Filter = 'all' | 'open' | 'done';
type Priority = 'P1' | 'P2' | 'P3' | null;

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'ALL' },
  { id: 'open', label: 'OPEN' },
  { id: 'done', label: 'DONE' },
];

const PRIORITY_COLORS: Record<string, string> = {
  P1: 'var(--red)',
  P2: 'var(--amber)',
  P3: 'var(--cyan)',
};

const chipBaseStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 12px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.04)',
  color: 'var(--ink-dim)',
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  letterSpacing: '0.12em',
  transition: 'all 150ms ease',
};

const chipActiveStyle: CSSProperties = {
  ...chipBaseStyle,
  color: 'var(--cyan)',
  borderColor: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.14)',
};

const emptyStateStyle: CSSProperties = {
  border: '1px dashed var(--line-soft)',
  padding: '32px 12px',
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
};

const rowStyle = (done: boolean, priority: Priority): CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: 'auto auto 1fr auto auto',
  gap: 10,
  alignItems: 'center',
  padding: '10px 12px',
  borderBottom: '1px dashed var(--line-soft)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  background: done
    ? 'rgba(125, 255, 154, 0.03)'
    : priority === 'P1'
      ? 'rgba(255, 77, 94, 0.04)'
      : 'transparent',
  animation: 'fadeSlideIn 200ms ease-out',
  transition: 'background 150ms ease',
});

const deleteButtonStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '2px 8px',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink-dim)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.12em',
  transition: 'all 150ms ease',
};

const priorityChipStyle = (p: Priority, active: boolean): CSSProperties => ({
  all: 'unset',
  cursor: 'pointer',
  padding: '2px 6px',
  fontFamily: 'var(--mono)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.12em',
  border: `1px solid ${p ? PRIORITY_COLORS[p] : 'var(--line-soft)'}`,
  color: active && p ? PRIORITY_COLORS[p] : 'var(--ink-dim)',
  background: active && p ? `${PRIORITY_COLORS[p]}18` : 'transparent',
  transition: 'all 150ms ease',
});

/**
 * One-off task list (user todos) with priority chips, progress ring,
 * and enhanced visual design.
 */
export function TodosTab() {
  const tasks = useTasks(s => s.tasks);
  const addTask = useTasks(s => s.addTask);
  const toggleTask = useTasks(s => s.toggleTask);
  const deleteTask = useTasks(s => s.deleteTask);
  const clearCompleted = useTasks(s => s.clearCompleted);

  const [draft, setDraft] = useState('');
  const [draftPriority, setDraftPriority] = useState<Priority>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Per-task priorities stored in local state (the store doesn't persist priority yet)
  const [priorities, setPriorities] = useState<Record<string, Priority>>({});

  const open = useMemo(() => tasks.filter(t => !t.done).length, [tasks]);
  const total = tasks.length;
  const doneCount = total - open;
  const pct = total > 0 ? (doneCount / total) * 100 : 0;

  const visible = useMemo(() => {
    let list = tasks;
    if (filter === 'open') list = list.filter(t => !t.done);
    if (filter === 'done') list = list.filter(t => t.done);
    // Sort: P1 first, then P2, P3, unset; done items at end
    return [...list].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const pa = priorities[a.id] ?? '';
      const pb = priorities[b.id] ?? '';
      if (pa !== pb) {
        if (!pa) return 1;
        if (!pb) return -1;
        return pa.localeCompare(pb);
      }
      return 0;
    });
  }, [tasks, filter, priorities]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    addTask(text);
    // Find the newly added task and set its priority
    if (draftPriority) {
      // We set priority on next render after the task appears
      window.setTimeout(() => {
        const newest = useTasks.getState().tasks;
        const added = newest.find(t => t.text === text && !t.done);
        if (added) {
          setPriorities(prev => ({ ...prev, [added.id]: draftPriority }));
        }
      }, 50);
    }
    setDraft('');
    setDraftPriority(null);
    inputRef.current?.focus();
  }, [draft, draftPriority, addTask]);

  const onInputKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }, [submit]);

  const onRowKey = useCallback((e: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleTask(id);
    }
  }, [toggleTask]);

  const cyclePriority = useCallback((id: string) => {
    setPriorities(prev => {
      const cur = prev[id] ?? null;
      const next: Priority = cur === null ? 'P1' : cur === 'P1' ? 'P2' : cur === 'P2' ? 'P3' : null;
      return { ...prev, [id]: next };
    });
  }, []);

  return (
    <div style={{ animation: 'fadeSlideIn 200ms ease-out' }}>
      {/* Progress ring + summary */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '12px 14px',
        marginBottom: 14,
        border: '1px solid var(--line-soft)',
        background: 'rgba(57, 229, 255, 0.03)',
      }}>
        <ProgressRing
          progress={pct / 100}
          size={52}
          tone={pct >= 80 ? 'green' : pct >= 40 ? 'amber' : 'cyan'}
        />
        <div>
          <div style={{
            fontFamily: 'var(--display)',
            fontSize: 11,
            letterSpacing: '0.22em',
            color: 'var(--cyan)',
            fontWeight: 700,
          }}>
            COMPLETION
          </div>
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--ink-2)',
            marginTop: 2,
          }}>
            {doneCount}/{total} tasks completed · {open} remaining
          </div>
        </div>
      </div>

      {/* Input row with priority selector */}
      <div className="section">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, alignItems: 'stretch' }}>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="New task… (Enter to add)"
            aria-label="New task"
          />
          <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            {(['P1', 'P2', 'P3'] as const).map(p => (
              <button
                key={p}
                onClick={() => setDraftPriority(draftPriority === p ? null : p)}
                style={priorityChipStyle(p, draftPriority === p)}
                title={`Priority ${p}`}
              >
                {p}
              </button>
            ))}
          </div>
          <button className="primary" onClick={submit}>ADD</button>
        </div>
      </div>

      {/* Filters */}
      <div className="section" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map(f => {
          const active = f.id === filter;
          const count =
            f.id === 'open' ? open : f.id === 'done' ? doneCount : total;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              aria-pressed={active}
              style={active ? chipActiveStyle : chipBaseStyle}
            >
              {f.label} {count.toString().padStart(2, '0')}
            </button>
          );
        })}
      </div>

      {/* Task list */}
      <div className="section" style={{ padding: 0 }}>
        {visible.length === 0 ? (
          <div style={{ padding: 12 }}>
            <div style={emptyStateStyle}>
              NO TASKS — TYPE ABOVE TO ADD ONE
            </div>
          </div>
        ) : (
          visible.map(t => {
            const p = priorities[t.id] ?? null;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onKeyDown={e => onRowKey(e, t.id)}
                style={rowStyle(t.done, p)}
              >
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={() => toggleTask(t.id)}
                  aria-label={t.done ? 'Mark open' : 'Mark done'}
                  style={{ accentColor: 'var(--cyan)', cursor: 'pointer' }}
                />
                {/* Priority chip */}
                <button
                  onClick={() => cyclePriority(t.id)}
                  style={priorityChipStyle(p, p !== null)}
                  title="Click to cycle priority"
                >
                  {p ?? '—'}
                </button>
                <span
                  onClick={() => toggleTask(t.id)}
                  style={{
                    cursor: 'pointer',
                    color: t.done ? 'var(--ink-dim)' : 'var(--ink)',
                    textDecoration: t.done ? 'line-through' : 'none',
                    wordBreak: 'break-word',
                  }}
                >
                  {t.text}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  color: 'var(--ink-dim)',
                  whiteSpace: 'nowrap',
                }}>
                  {new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                <button
                  onClick={() => deleteTask(t.id)}
                  aria-label="Delete task"
                  style={deleteButtonStyle}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="section" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="primary"
          onClick={clearCompleted}
          disabled={doneCount === 0}
          style={doneCount === 0 ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
        >
          CLEAR COMPLETED
        </button>
      </div>
    </div>
  );
}

/** Count used by the AutoPage tab header to show "OPEN/TOTAL" beside TODOS. */
export function useTodoCounts(): { open: number; total: number } {
  const tasks = useTasks(s => s.tasks);
  const total = tasks.length;
  const open = tasks.filter(t => !t.done).length;
  return { open, total };
}
