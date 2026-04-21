/**
 * TASKS — macOS Reminders inbox with Sunny integration hooks.
 *
 * Smart lists: TODAY / NEXT7 / SOMEDAY / OVERDUE computed from due_date.
 * Priority badges (P1/P2/P3) from title prefix !!! / !! / ! and keyword scan.
 * Bulk ops: Shift-click range, ⌘A select all, Delete = delete, C = complete.
 * Inline rename on double-click title.
 * "ASK SUNNY TO SORT" — sends the list to Sunny for ordering suggestion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, TabBar, EmptyState, StatBlock,
  usePoll, Toolbar, ToolbarButton, Chip,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import type { SunnyNavAction } from '../../hooks/useNavBridge';
import { useTasksStateSync } from '../../hooks/usePageStateSync';
import { NewTaskRow } from './NewTaskRow';
import { TaskRow } from './TaskRow';
import {
  completeReminder, createReminder, deleteReminder, listLists, listReminders,
  renameReminder, type Reminder,
} from './api';
import { sortReminders, type SortMode } from './sort';

const VALID_TABS: ReadonlySet<string> = new Set(['today', 'next7', 'someday', 'overdue', 'done']);

type SmartList = 'today' | 'next7' | 'someday' | 'overdue' | 'done';

function smartFilter(tasks: ReadonlyArray<Reminder>, list: SmartList): Reminder[] {
  const now = Date.now();
  const todayEnd = (() => {
    const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime();
  })();
  const next7End = todayEnd + 6 * 86_400_000;

  switch (list) {
    case 'today':
      return tasks.filter(t => !t.completed && t.due && new Date(t.due).getTime() <= todayEnd);
    case 'next7':
      return tasks.filter(t =>
        !t.completed && t.due &&
        new Date(t.due).getTime() > todayEnd &&
        new Date(t.due).getTime() <= next7End,
      );
    case 'someday':
      return tasks.filter(t => !t.completed && (!t.due || new Date(t.due).getTime() > next7End));
    case 'overdue':
      return tasks.filter(t => !t.completed && t.due && new Date(t.due).getTime() < now);
    case 'done':
      return tasks.filter(t => t.completed);
  }
}

export function TasksPage() {
  const [tab, setTab] = useState<SmartList>('today');
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('due');
  const { data: tasks, loading, error, reload } = usePoll(() => listReminders(true), 20_000);
  const { data: lists } = usePoll(listLists, 60_000);

  const listRows: ReadonlyArray<Reminder> = tasks ?? [];
  const filtered = useMemo(() => smartFilter(listRows, tab), [listRows, tab]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return filtered;
    return filtered.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.list.toLowerCase().includes(q) ||
      (t.notes && t.notes.toLowerCase().includes(q)),
    );
  }, [filtered, q]);

  const sortedVisible = useMemo(() => sortReminders(visible, sortMode), [visible, sortMode]);

  const counts = useMemo(() => ({
    today:   smartFilter(listRows, 'today').length,
    next7:   smartFilter(listRows, 'next7').length,
    someday: smartFilter(listRows, 'someday').length,
    overdue: smartFilter(listRows, 'overdue').length,
    done:    listRows.filter(t => t.completed).length,
  }), [listRows]);

  // ── Bulk selection ──────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedIdx = useRef<number>(-1);

  // Clear selection when tab, search, or sort changes (indices are per-visible list)
  useEffect(() => { setSelected(new Set()); lastClickedIdx.current = -1; }, [tab, query, sortMode]);

  // Push the Tasks page's visible state to the Rust backend so the
  // agent's `page_state_tasks` tool can answer "what am I looking at".
  const selectedIdList = useMemo(
    () => Array.from(selected).slice(0, 32),
    [selected],
  );
  const tasksSnapshot = useMemo(() => ({
    active_tab: tab,
    selected_ids: selectedIdList,
    filter_query: query,
    total_count: listRows.length,
    completed_count: counts.done,
  }), [tab, selectedIdList, query, listRows.length, counts.done]);
  useTasksStateSync(tasksSnapshot);

  const handleRowClick = useCallback((e: React.MouseEvent, id: string, idx: number) => {
    if (e.shiftKey && lastClickedIdx.current >= 0) {
      const lo = Math.min(lastClickedIdx.current, idx);
      const hi = Math.max(lastClickedIdx.current, idx);
      const range = sortedVisible.slice(lo, hi + 1).map(t => t.id);
      setSelected(prev => new Set([...prev, ...range]));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    } else {
      setSelected(prev => {
        if (prev.size === 1 && prev.has(id)) return new Set();
        return new Set([id]);
      });
    }
    lastClickedIdx.current = idx;
  }, [sortedVisible]);

  // ⌘A select all, Delete delete selected, C complete selected
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        setSelected(new Set(sortedVisible.map(t => t.id)));
        return;
      }
      if (selected.size === 0) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const ids = [...selected];
        void Promise.all(ids.map(id => deleteReminder(id))).then(reload);
        setSelected(new Set());
      }
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        const ids = [...selected];
        void Promise.all(ids.map(id => completeReminder(id))).then(reload);
        setSelected(new Set());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sortedVisible, selected, reload]);

  const bulkComplete = async () => {
    await Promise.all([...selected].map(id => completeReminder(id)));
    setSelected(new Set());
    reload();
  };

  const bulkDelete = async () => {
    await Promise.all([...selected].map(id => deleteReminder(id)));
    setSelected(new Set());
    reload();
  };

  // ── agent page_action listener ──────────────────────────────────────────
  // Handles `sunny://nav.action` events scoped to this page. Actions:
  //   filter_tab     {tab}           → setTab()
  //   create_task    {title, list?}  → createReminder() + reload()
  //   complete_task  {id}            → completeReminder() + reload()
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<SunnyNavAction>;
      const { view, action, args } = ce.detail ?? ({} as SunnyNavAction);
      if (view !== 'tasks') return;
      switch (action) {
        case 'filter_tab': {
          const next = typeof args?.tab === 'string' ? args.tab : '';
          if (VALID_TABS.has(next)) setTab(next as SmartList);
          break;
        }
        case 'create_task': {
          const title = typeof args?.title === 'string' ? args.title.trim() : '';
          const list = typeof args?.list === 'string' ? args.list : undefined;
          if (!title) return;
          void createReminder(title, list).then(() => reload());
          break;
        }
        case 'complete_task': {
          const id = typeof args?.id === 'string' ? args.id : '';
          if (!id) return;
          void completeReminder(id).then(() => reload());
          break;
        }
        default:
          // Unknown action — quietly ignore. The agent already gets a
          // successful dispatch ack; we don't want to surface noise
          // for forward-compat actions yet to be wired.
          break;
      }
    };
    window.addEventListener('sunny:nav.action', handler);
    return () => window.removeEventListener('sunny:nav.action', handler);
  }, [reload]);

  const askSunnyToSort = () => {
    const titles = sortedVisible.map((t, i) => `${i + 1}. ${t.title}${t.due ? ` [due ${t.due}]` : ''}`).join('\n');
    const scope = q ? `filtered “${query.trim()}” within ${tab.toUpperCase()}` : tab.toUpperCase();
    askSunny(
      `Here are my current tasks (${scope}):\n${titles}\n\nSuggest the best order to tackle them today, with a one-sentence reason for each choice. Focus on urgency, energy cost, and dependencies.`,
      'tasks-sort',
    );
  };

  return (
    <ModuleView title="TASKS · REMINDERS">
      <PageGrid>
        <PageCell span={12}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            <StatBlock label="TODAY"   value={String(counts.today)}   tone="amber" />
            <StatBlock label="NEXT 7"  value={String(counts.next7)}   tone="cyan" />
            <StatBlock label="SOMEDAY" value={String(counts.someday)} tone="teal" />
            <StatBlock label="OVERDUE" value={String(counts.overdue)} tone={counts.overdue > 0 ? 'red' : 'green'} />
            <StatBlock label="DONE"    value={String(counts.done)}    tone="green" />
          </div>
        </PageCell>

        <PageCell span={12}>
          <NewTaskRow
            lists={lists ?? []}
            onCreate={async (title, list) => {
              const created = await createReminder(title, list);
              if (!created) throw new Error('Reminders.app rejected that — check permissions.');
              reload();
            }}
          />
        </PageCell>

        <PageCell span={12}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Toolbar>
              <TabBar
                value={tab}
                onChange={v => setTab(v)}
                tabs={[
                  { id: 'today',   label: 'TODAY',   count: counts.today },
                  { id: 'next7',   label: 'NEXT 7',  count: counts.next7 },
                  { id: 'someday', label: 'SOMEDAY',  count: counts.someday },
                  { id: 'overdue', label: 'OVERDUE',  count: counts.overdue },
                  { id: 'done',    label: 'DONE',     count: counts.done },
                ] as const}
              />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="filter…"
                aria-label="Filter tasks by title, list, or notes"
                style={{
                  width: 140,
                  marginLeft: 8,
                  padding: '5px 8px',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  letterSpacing: '0.06em',
                  color: 'var(--ink)',
                  background: 'rgba(0,0,0,0.35)',
                  border: '1px solid var(--line-soft)',
                  outline: 'none',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--cyan)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--line-soft)'; }}
              />
              {q && (
                <>
                  <Chip tone="dim" style={{ fontSize: 8 }}>
                    {visible.length}/{filtered.length}
                  </Chip>
                  <ToolbarButton onClick={() => setQuery('')}>CLEAR FILTER</ToolbarButton>
                </>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                {selected.size > 0 && (
                  <>
                    <Chip tone="cyan">{selected.size} selected</Chip>
                    <ToolbarButton tone="green" onClick={() => void bulkComplete()}>COMPLETE</ToolbarButton>
                    <ToolbarButton tone="red" onClick={() => void bulkDelete()}>DELETE</ToolbarButton>
                  </>
                )}
                {sortedVisible.length > 0 && (
                  <ToolbarButton tone="violet" onClick={askSunnyToSort}>ASK SUNNY TO SORT</ToolbarButton>
                )}
                <ToolbarButton onClick={reload}>REFRESH</ToolbarButton>
              </div>
            </Toolbar>
            <Toolbar>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
                color: 'var(--ink-dim)', fontWeight: 700, marginRight: 4,
              }}>SORT</span>
              {([
                { id: 'due' as const, label: 'DUE' },
                { id: 'priority' as const, label: 'P1↓' },
                { id: 'title' as const, label: 'A→Z' },
                { id: 'list' as const, label: 'LIST' },
                { id: 'created' as const, label: 'NEWEST' },
              ]).map(({ id, label }) => (
                <ToolbarButton
                  key={id}
                  active={sortMode === id}
                  onClick={() => setSortMode(id)}
                  title={id === 'due' ? 'Soonest due first; no due last' : id === 'priority' ? 'P1 before P2 before none' : undefined}
                >
                  {label}
                </ToolbarButton>
              ))}
            </Toolbar>
          </div>
        </PageCell>

        <PageCell span={12}>
          {!tasks && loading ? (
            <EmptyState title="Loading reminders" hint="Reading from Reminders.app…" />
          ) : error && !tasks ? (
            <EmptyState title="Reminders unavailable" hint={error} />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={tab === 'done' ? 'Nothing completed yet' : `Nothing in ${tab.toUpperCase()}`}
              hint={tab === 'overdue' ? "You're not behind on anything." : 'Add a task above to get started.'}
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No matches"
              hint={`Nothing in ${tab.toUpperCase()} matches “${query.trim()}”. Clear the filter or try another word.`}
            />
          ) : (
            <Section title={tab.toUpperCase()} right={<Chip tone="dim">{sortedVisible.length}{q ? ` / ${filtered.length}` : ''}</Chip>}>
              {sortedVisible.map((t, idx) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  selected={selected.has(t.id)}
                  onClick={e => handleRowClick(e, t.id, idx)}
                  onComplete={async id => { await completeReminder(id); reload(); }}
                  onDelete={async id => { await deleteReminder(id); reload(); }}
                  onRename={async (id, title) => { await renameReminder(id, title); reload(); }}
                />
              ))}
            </Section>
          )}
        </PageCell>

        <PageCell span={12}>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
            padding: '6px 10px',
            border: '1px solid var(--line-soft)',
            background: 'rgba(57, 229, 255, 0.025)',
            display: 'flex', gap: 16, flexWrap: 'wrap',
            letterSpacing: '0.08em',
          }}>
            <span><b style={{ color: 'var(--cyan)' }}>↵</b> save</span>
            <span><b style={{ color: 'var(--cyan)' }}>2×click</b> rename</span>
            <span><b style={{ color: 'var(--cyan)' }}>⌘A</b> select all</span>
            <span><b style={{ color: 'var(--cyan)' }}>Shift-click</b> range</span>
            <span><b style={{ color: 'var(--cyan)' }}>C</b> complete</span>
            <span><b style={{ color: 'var(--cyan)' }}>⌫</b> delete</span>
            <span><b style={{ color: 'var(--amber)' }}>!/!!/!!!</b> priority</span>
          </div>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
