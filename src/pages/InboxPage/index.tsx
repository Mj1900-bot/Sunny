/**
 * INBOX — unified mail + iMessage view with Sunny shortcuts.
 *
 * Merges `mail_list_recent` and `messages_recent` into a single
 * chronological list (left), with a rich thread + quick-reply pane
 * on the right. Every "ASK SUNNY" button dispatches via `askSunny(...)`,
 * which flows through the same chat pipeline as a typed message.
 *
 * SUNNY TRIAGE: invokes Sunny to classify the last 20 items and writes
 * results back to localStorage so labels persist across refreshes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, TabBar, EmptyState, StatBlock, ScrollList,
  usePoll, useDebounced, Toolbar, ToolbarButton, KeyHint,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import type { SunnyNavAction } from '../../hooks/useNavBridge';
import { copyToClipboard } from '../../lib/clipboard';
import { useInboxStateSync } from '../../hooks/usePageStateSync';
import { ItemRow } from './ItemRow';
import { ThreadPane } from './ThreadPane';
import { loadInbox, unify, type UnifiedItem } from './api';
import { classify, type TriageLabel } from './triage';
import { useTriageTags } from './useTriageTags';
import { useInboxStars } from './useInboxStars';

type Tab = 'all' | 'unread' | 'mail' | 'chat';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'all',    label: 'ALL' },
  { id: 'unread', label: 'UNREAD' },
  { id: 'mail',   label: 'MAIL' },
  { id: 'chat',   label: 'CHAT' },
];

function isUnread(it: UnifiedItem): boolean {
  return it.kind === 'mail' ? it.data.unread : (it.data.unread_count ?? 0) > 0;
}

function buildInboxExportMarkdown(items: ReadonlyArray<UnifiedItem>, labelOf: (it: UnifiedItem) => TriageLabel): string {
  const lines = items.map(it => {
    const L = labelOf(it);
    if (it.kind === 'mail') {
      const m = it.data;
      return [
        `### [${L}] ${m.subject}`,
        `From: ${m.from}`,
        m.snippet ? m.snippet.slice(0, 400) : '',
        '',
      ].join('\n');
    }
    const c = it.data;
    return [
      `### [${L}] ${c.display}`,
      `${c.handle} · ${c.is_imessage ? 'iMessage' : 'SMS'}`,
      c.last_message.slice(0, 400),
      '',
    ].join('\n');
  });
  return ['# Inbox export', `Generated ${new Date().toISOString()}`, '', ...lines].join('\n');
}

export function InboxPage() {
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 220);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [triageFilter, setTriageFilter] = useState<'all' | TriageLabel>('all');
  const [starsOnly, setStarsOnly] = useState(false);
  const [copyFlash, setCopyFlash] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const { tags, writeTags } = useTriageTags();
  const { starred, toggleStar, isStarred } = useInboxStars();

  const { data, loading, error, reload } = usePoll(loadInbox, 20_000);

  const unified = useMemo(() => {
    if (!data) return [] as ReadonlyArray<UnifiedItem>;
    return unify(data.mail, data.chats);
  }, [data]);

  const effectiveLabel = useCallback((it: UnifiedItem): TriageLabel => {
    return tags[it.id] ?? classify(it).label;
  }, [tags]);

  const baseFiltered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    const byTab = (it: UnifiedItem) => {
      if (tab === 'mail') return it.kind === 'mail';
      if (tab === 'chat') return it.kind === 'chat';
      if (tab === 'unread') return isUnread(it);
      return true;
    };
    const byQuery = (it: UnifiedItem) => {
      if (!q) return true;
      if (it.kind === 'mail') {
        return it.data.subject.toLowerCase().includes(q)
          || it.data.from.toLowerCase().includes(q)
          || it.data.snippet.toLowerCase().includes(q);
      }
      return it.data.display.toLowerCase().includes(q)
        || it.data.handle.toLowerCase().includes(q)
        || it.data.last_message.toLowerCase().includes(q);
    };
    return unified.filter(it => byTab(it) && byQuery(it));
  }, [unified, tab, debounced]);

  const filtered = useMemo(() => {
    return baseFiltered.filter(it => {
      if (starsOnly && !starred.has(it.id)) return false;
      if (triageFilter !== 'all' && effectiveLabel(it) !== triageFilter) return false;
      return true;
    });
  }, [baseFiltered, starsOnly, starred, triageFilter, effectiveLabel]);

  const selected = useMemo(
    () => filtered.find(it => it.id === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  const counts = useMemo(() => ({
    all: unified.length,
    unread: unified.filter(isUnread).length,
    mail: unified.filter(it => it.kind === 'mail').length,
    chat: unified.filter(it => it.kind === 'chat').length,
  }), [unified]);

  const triageCounts = useMemo(() => {
    const acc = { urgent: 0, important: 0, later: 0, ignore: 0 };
    for (const it of unified) acc[effectiveLabel(it)]++;
    return acc;
  }, [unified, effectiveLabel]);

  // Push the Inbox page's visible state to the Rust backend so the
  // agent's `page_state_inbox` tool can answer "which message is open".
  const inboxFilter = useMemo(() => {
    const parts: string[] = [tab];
    if (starsOnly) parts.push('stars');
    if (triageFilter !== 'all') parts.push(triageFilter);
    if (debounced.trim()) parts.push(`q=${debounced.trim().slice(0, 64)}`);
    return parts.join(',');
  }, [tab, starsOnly, triageFilter, debounced]);
  const triageSummary = useMemo(
    () => `urgent=${triageCounts.urgent} important=${triageCounts.important} later=${triageCounts.later} ignore=${triageCounts.ignore}`,
    [triageCounts],
  );
  const inboxSnapshot = useMemo(() => ({
    selected_item_id: selectedId ?? undefined,
    filter: inboxFilter,
    triage_labels_summary: triageSummary,
  }), [selectedId, inboxFilter, triageSummary]);
  useInboxStateSync(inboxSnapshot);

  const handleSunnyTriage = useCallback(async () => {
    if (triaging) return;
    setTriaging(true);
    const slice = unified.slice(0, 20);
    const items = slice.map(it => ({
      id: it.id,
      label: it.kind === 'mail'
        ? `[MAIL] from:${it.data.from} subj:${it.data.subject}`
        : `[CHAT] from:${it.data.display} msg:${it.data.last_message}`,
    }));
    const prompt = [
      'Classify each of these inbox items as urgent/important/later/ignore.',
      'Reply ONLY with valid JSON: { "results": [{ "id": "…", "label": "urgent|important|later|ignore" }] }.',
      'Items:',
      ...items.map(it => `  ${it.id}: ${it.label}`),
    ].join('\n');

    const optimistic: Record<string, TriageLabel> = { ...tags };
    for (const it of slice) {
      optimistic[it.id] = classify(it).label;
    }
    writeTags(optimistic);

    askSunny(prompt, 'inbox-triage');
    await new Promise<void>(r => window.setTimeout(r, 2_000));
    setTriaging(false);
  }, [triaging, unified, tags, writeTags]);

  // Keyboard nav
  const move = useCallback((delta: number) => {
    if (filtered.length === 0) return;
    const currentId = selected?.id ?? filtered[0]?.id ?? null;
    const idx = Math.max(0, filtered.findIndex(it => it.id === currentId));
    const next = Math.max(0, Math.min(filtered.length - 1, idx + delta));
    const nextItem = filtered[next];
    if (nextItem) setSelectedId(nextItem.id);
  }, [filtered, selected?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) { reload(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, reload]);

  useEffect(() => {
    if (!selected || !listRef.current) return;
    const node = listRef.current.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(selected.id)}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useEffect(() => {
    if (filtered.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some(it => it.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null);
    }
  }, [filtered, selectedId]);

  // ── agent page_action listener ──────────────────────────────────────────
  // Handles `sunny://nav.action` events scoped to this page. Actions:
  //   filter       {tab?, triage?, starsOnly?}
  //   triage_all   {}                               → handleSunnyTriage()
  useEffect(() => {
    const VALID_TABS: ReadonlySet<string> = new Set(['all', 'unread', 'mail', 'chat']);
    const VALID_TRIAGE: ReadonlySet<string> = new Set([
      'all', 'urgent', 'important', 'later', 'ignore',
    ]);
    const handler = (e: Event) => {
      const ce = e as CustomEvent<SunnyNavAction>;
      const { view, action, args } = ce.detail ?? ({} as SunnyNavAction);
      if (view !== 'inbox') return;
      switch (action) {
        case 'filter': {
          if (typeof args?.tab === 'string' && VALID_TABS.has(args.tab)) {
            setTab(args.tab as Tab);
          }
          if (typeof args?.triage === 'string' && VALID_TRIAGE.has(args.triage)) {
            setTriageFilter(args.triage as 'all' | TriageLabel);
          }
          if (typeof args?.starsOnly === 'boolean') {
            setStarsOnly(args.starsOnly);
          }
          break;
        }
        case 'triage_all': {
          void handleSunnyTriage();
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('sunny:nav.action', handler);
    return () => window.removeEventListener('sunny:nav.action', handler);
  }, [handleSunnyTriage]);

  const handleCopyList = useCallback(async () => {
    const md = buildInboxExportMarkdown(filtered, effectiveLabel);
    const ok = await copyToClipboard(md);
    if (ok) {
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1_200);
    }
  }, [filtered, effectiveLabel]);

  return (
    <ModuleView title="INBOX · UNIFIED">
      <PageGrid>
        {/* ── Top stats ── */}
        <PageCell span={12}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <StatBlock
              label="UNREAD"
              value={String(counts.unread)}
              sub={`${counts.all} total`}
              tone={counts.unread > 0 ? 'pink' : 'cyan'}
            />
            <StatBlock
              label="URGENT"
              value={String(triageCounts.urgent)}
              sub={triageCounts.urgent > 0 ? 'needs action' : 'all clear'}
              tone={triageCounts.urgent > 0 ? 'red' : 'cyan'}
            />
            <StatBlock
              label="IMPORTANT"
              value={String(triageCounts.important)}
              sub="review soon"
              tone="amber"
            />
            <StatBlock
              label="LATER / IGNORE"
              value={`${triageCounts.later} · ${triageCounts.ignore}`}
              sub="deferred"
              tone="violet"
            />
          </div>
        </PageCell>

        {/* ── Toolbar row 1: tabs + primary actions ── */}
        <PageCell span={12}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <TabBar
              value={tab}
              onChange={(t: string) => setTab(t as Tab)}
              tabs={TABS.map(t => ({ ...t, count: counts[t.id] }))}
            />
            <div style={{ flex: 1 }} />
            <Toolbar>
              <ToolbarButton
                tone="gold"
                active={starsOnly}
                disabled={starred.size === 0 && !starsOnly}
                onClick={() => setStarsOnly(s => !s)}
              >
                ★ STARRED ({starred.size})
              </ToolbarButton>
              <ToolbarButton onClick={reload}>REFRESH</ToolbarButton>
              <ToolbarButton
                tone="cyan"
                disabled={filtered.length === 0}
                onClick={() => void handleCopyList()}
              >
                {copyFlash ? 'COPIED' : 'COPY LIST'}
              </ToolbarButton>
              <ToolbarButton
                tone="amber"
                disabled={filtered.length === 0}
                onClick={() => askSunny(
                  `Here is my filtered inbox:\n\n${buildInboxExportMarkdown(filtered, effectiveLabel)}\n\nIn 5 bullets: what should I handle first and why?`,
                  'inbox-prioritize',
                )}
              >PRIORITIZE</ToolbarButton>
              <ToolbarButton
                tone="violet"
                active={triaging}
                disabled={triaging || unified.length === 0}
                onClick={() => void handleSunnyTriage()}
              >
                {triaging ? 'TRIAGING…' : 'SUNNY TRIAGE'}
              </ToolbarButton>
            </Toolbar>
          </div>
        </PageCell>

        {/* ── Toolbar row 2: search + keyboard hints ── */}
        <PageCell span={12} style={{ marginTop: -4 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '6px 10px',
            border: '1px solid var(--line-soft)',
            background: 'rgba(6, 14, 22, 0.55)',
          }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
              letterSpacing: '0.18em',
            }}>SEARCH</span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="subject · from · body · handle…"
              aria-label="Filter inbox"
              style={{
                all: 'unset', flex: 1, minWidth: 180,
                padding: '4px 0',
                fontFamily: 'var(--mono)', fontSize: 12,
                color: 'var(--ink)',
              }}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                style={{
                  all: 'unset', cursor: 'pointer',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: 'var(--ink-dim)', letterSpacing: '0.16em',
                  padding: '2px 6px', border: '1px solid var(--line-soft)',
                }}
              >CLEAR</button>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <KeyHint>J</KeyHint><KeyHint>K</KeyHint>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)', letterSpacing: '0.12em' }}>
                NAV
              </span>
              <span style={{ width: 1, height: 12, background: 'var(--line-soft)', margin: '0 2px' }} />
              <KeyHint>R</KeyHint>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)', letterSpacing: '0.12em' }}>
                REFRESH
              </span>
            </div>
          </div>
        </PageCell>

        {/* ── List (left) ── */}
        <PageCell span={5}>
          {error && <EmptyState title="Inbox error" hint={error} />}
          {!error && loading && filtered.length === 0 && <EmptyState title="Loading inbox…" />}
          {!error && !loading && filtered.length === 0 && (
            <EmptyState title="Nothing here" hint="No items match the current tab + filter." />
          )}
          {!error && filtered.length > 0 && (
            <>
              {/* Triage summary strip */}
              <div style={{
                display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
                padding: '2px 2px 8px',
              }}>
                <ToolbarButton
                  tone="cyan"
                  active={triageFilter === 'all'}
                  onClick={() => setTriageFilter('all')}
                >LABEL · ALL</ToolbarButton>
                {(['urgent', 'important', 'later', 'ignore'] as const).map(label => {
                  const n = triageCounts[label];
                  if (n === 0) return null;
                  const active = triageFilter === label;
                  const filterTone: 'red' | 'amber' | 'violet' | 'teal' =
                    label === 'urgent' ? 'red' :
                    label === 'important' ? 'amber' :
                    label === 'later' ? 'violet' :
                    'teal';
                  return (
                    <ToolbarButton
                      key={label}
                      tone={filterTone}
                      active={active}
                      onClick={() => setTriageFilter(prev => (prev === label ? 'all' : label))}
                    >
                      {label} · {n}
                    </ToolbarButton>
                  );
                })}
                <span style={{
                  marginLeft: 'auto',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: 'var(--ink-dim)', letterSpacing: '0.1em',
                }}>
                  {filtered.length} / {unified.length}
                </span>
              </div>
              <ScrollList maxHeight={620} style={{ gap: 0 }}>
                <div ref={listRef} role="listbox" aria-label="Inbox items">
                  {filtered.map(it => (
                    <div key={it.id} data-item-id={it.id}>
                      <ItemRow
                        item={it}
                        selected={it.id === (selected?.id ?? null)}
                        onSelect={() => setSelectedId(it.id)}
                        overrideLabel={tags[it.id]}
                        starred={isStarred(it.id)}
                        onToggleStar={() => toggleStar(it.id)}
                      />
                    </div>
                  ))}
                </div>
              </ScrollList>
            </>
          )}
        </PageCell>

        <PageCell span={7}>
          <ThreadPane item={selected} onAskSunny={p => askSunny(p, 'inbox')} />
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
