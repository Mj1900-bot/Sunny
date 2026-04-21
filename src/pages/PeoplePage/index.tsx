/**
 * PEOPLE — relationships layer on top of CONTACTS + iMessage history.
 *
 * New in this version:
 *  - WarmthHeatmap: 30 days × top-N contacts, opacity = recency
 *  - CheckInSuggestions: people gone cold after warmth
 *  - PersonDetailPane: right pane with conversation history + notes
 */

import { useCallback, useMemo, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, EmptyState, StatBlock, ScrollList, Toolbar, ToolbarButton,
  usePoll, useDebounced, TabBar, KeyHint, relTime,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { copyToClipboard } from '../../lib/clipboard';
import { useView } from '../../store/view';
import { PersonCard, warmth, type Person } from './PersonCard';
import { PersonDetailPane } from './PersonDetailPane';
import { WarmthHeatmap } from './WarmthHeatmap';
import { CheckInSuggestions } from './CheckInSuggestions';
import { loadBook, loadRecentChats, normaliseHandle, type ContactBookEntry, type MessageContact } from './api';

type Tab = 'all' | 'warm' | 'cooling' | 'cold';

function buildPeople(book: ReadonlyArray<ContactBookEntry>, chats: ReadonlyArray<MessageContact>): Person[] {
  const byKey = new Map<string, Person>();
  for (const c of chats) {
    const key = normaliseHandle(c.handle);
    if (!key) continue;
    byKey.set(key, { key, handle: c.handle, display: c.display, lastChat: c, book: null });
  }
  for (const b of book) {
    const key = b.handle_key;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, { ...existing, book: b, display: existing.display || b.name });
    } else {
      byKey.set(key, { key, handle: b.handle_key, display: b.name, lastChat: null, book: b });
    }
  }
  return Array.from(byKey.values());
}

function daysSince(ts: number): number { return (Date.now() / 1000 - ts) / 86_400; }

type SortMode = 'recent' | 'name' | 'handle';

export function PeoplePage() {
  const [tab, setTab] = useState<Tab>('warm');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [copyFlash, setCopyFlash] = useState<'md' | 'json' | null>(null);
  const debounced = useDebounced(query, 220);

  const warmDays = useView(s => s.settings.peopleWarmDays);
  const coldDays = useView(s => s.settings.peopleColdDays);
  const thresholds = useMemo(() => ({ warmDays, coldDays }), [warmDays, coldDays]);

  const { data: book } = usePoll(loadBook, 120_000);
  const { data: chats } = usePoll(loadRecentChats, 30_000);

  const people = useMemo(() => buildPeople(book ?? [], chats ?? []), [book, chats]);

  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    return people
      .filter(p => {
        if (q && !p.display.toLowerCase().includes(q) && !p.handle.toLowerCase().includes(q)) return false;
        const d = p.lastChat ? daysSince(p.lastChat.last_ts) : Infinity;
        if (tab === 'warm')    return d < warmDays;
        if (tab === 'cooling') return d >= warmDays && d < coldDays;
        if (tab === 'cold')    return d >= coldDays;
        return true;
      });
  }, [people, tab, debounced, warmDays, coldDays]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sortMode === 'name') {
      arr.sort((a, b) => a.display.localeCompare(b.display, undefined, { sensitivity: 'base' }));
    } else if (sortMode === 'handle') {
      arr.sort((a, b) => a.handle.localeCompare(b.handle, undefined, { sensitivity: 'base' }));
    } else {
      arr.sort((a, b) => (b.lastChat?.last_ts ?? 0) - (a.lastChat?.last_ts ?? 0));
    }
    return arr;
  }, [filtered, sortMode]);

  const peopleMarkdown = useCallback((list: ReadonlyArray<Person>) => {
    const lines = list.map(p => {
      const w = warmth(p.lastChat?.last_ts, thresholds);
      const last = p.lastChat ? relTime(p.lastChat.last_ts) : '—';
      return `- **${p.display}** (\`${p.handle}\`) · ${w} · last ${last}`;
    });
    return ['# People', `Sorted: ${sortMode}`, '', ...lines].join('\n');
  }, [sortMode, thresholds]);

  const handleCopyMd = useCallback(async () => {
    const ok = await copyToClipboard(peopleMarkdown(sorted));
    if (ok) {
      setCopyFlash('md');
      window.setTimeout(() => setCopyFlash(null), 1_000);
    }
  }, [peopleMarkdown, sorted]);

  const handleCopyJson = useCallback(async () => {
    const payload = sorted.map(p => ({
      display: p.display,
      handle: p.handle,
      warmth: warmth(p.lastChat?.last_ts, thresholds),
      last_ts: p.lastChat?.last_ts ?? null,
      message_count: p.lastChat?.message_count ?? 0,
    }));
    const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (ok) {
      setCopyFlash('json');
      window.setTimeout(() => setCopyFlash(null), 1_000);
    }
  }, [sorted, thresholds]);

  const counts = useMemo(() => ({
    all: people.length,
    warm: people.filter(p => p.lastChat && daysSince(p.lastChat.last_ts) < warmDays).length,
    cooling: people.filter(p => p.lastChat && daysSince(p.lastChat.last_ts) >= warmDays && daysSince(p.lastChat.last_ts) < coldDays).length,
    cold: people.filter(p => p.lastChat && daysSince(p.lastChat.last_ts) >= coldDays).length,
  }), [people, warmDays, coldDays]);

  const selected = useMemo(
    () => sorted.find(p => p.key === selectedKey) ?? null,
    [sorted, selectedKey],
  );

  return (
    <ModuleView title="PEOPLE · RELATIONSHIPS">
      <PageGrid>
        {/* Stats */}
        <PageCell span={12}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <StatBlock label="KNOWN" value={String(counts.all)} tone="cyan" />
            <StatBlock label="WARM" value={String(counts.warm)} sub={`< ${warmDays} days`} tone="green" />
            <StatBlock label="COOLING" value={String(counts.cooling)} sub={`${warmDays}–${coldDays} days`} tone="amber" />
            <StatBlock label="COLD" value={String(counts.cold)} sub={`≥ ${coldDays} days`} tone="red" />
          </div>
        </PageCell>

        {/* Heatmap */}
        {(chats ?? []).length > 0 && (
          <PageCell span={12}>
            <WarmthHeatmap chats={chats ?? []} />
          </PageCell>
        )}

        {/* Check-in suggestions */}
        {people.length > 0 && (
          <PageCell span={12}>
            <CheckInSuggestions people={people} thresholds={thresholds} />
          </PageCell>
        )}

        {/* Toolbar + search */}
        <PageCell span={12}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <TabBar
              value={tab}
              onChange={(t: string) => setTab(t as Tab)}
              tabs={[
                { id: 'all',     label: 'ALL',     count: counts.all },
                { id: 'warm',    label: 'WARM',    count: counts.warm },
                { id: 'cooling', label: 'COOLING', count: counts.cooling },
                { id: 'cold',    label: 'COLD',    count: counts.cold },
              ]}
            />
            <div style={{ flex: 1 }} />
            <Toolbar>
              <ToolbarButton tone="cyan" active={sortMode === 'recent'} onClick={() => setSortMode('recent')}>RECENT</ToolbarButton>
              <ToolbarButton tone="cyan" active={sortMode === 'name'} onClick={() => setSortMode('name')}>NAME A→Z</ToolbarButton>
              <ToolbarButton tone="cyan" active={sortMode === 'handle'} onClick={() => setSortMode('handle')}>HANDLE</ToolbarButton>
              <ToolbarButton tone="cyan" disabled={sorted.length === 0} onClick={() => void handleCopyMd()}>
                {copyFlash === 'md' ? 'COPIED MD' : 'COPY MD'}
              </ToolbarButton>
              <ToolbarButton tone="teal" disabled={sorted.length === 0} onClick={() => void handleCopyJson()}>
                {copyFlash === 'json' ? 'COPIED JSON' : 'COPY JSON'}
              </ToolbarButton>
              <ToolbarButton
                tone="violet"
                onClick={() => askSunny(`Draft a 5-person check-in list from my relationships — prioritize people I haven't talked to in 2-6 weeks who matter to me.`, 'people')}
              >AI SUGGEST</ToolbarButton>
            </Toolbar>
          </div>
        </PageCell>

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
              placeholder="name · handle · phone · email…"
              aria-label="Filter people"
              style={{
                all: 'unset', flex: 1, minWidth: 180,
                padding: '4px 0',
                fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
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
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10,
              color: 'var(--ink-dim)', letterSpacing: '0.1em',
            }}>
              {sorted.length} / {people.length}
            </span>
            <span style={{ width: 1, height: 12, background: 'var(--line-soft)' }} />
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <KeyHint>CLICK</KeyHint>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)', letterSpacing: '0.12em' }}>
                TO OPEN DETAIL
              </span>
            </div>
          </div>
        </PageCell>

        {/* Left: contact grid · Right: detail pane */}
        <PageCell span={7}>
          {sorted.length === 0 ? (
            <EmptyState title="No one here" hint="No contacts match the current tab + filter." />
          ) : (
            <ScrollList maxHeight={480}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                {sorted.slice(0, 80).map(p => (
                  <PersonCard
                    key={p.handle}
                    p={p}
                    thresholds={thresholds}
                    selected={p.key === selectedKey}
                    onSelect={() => setSelectedKey(p.key === selectedKey ? null : p.key)}
                  />
                ))}
              </div>
            </ScrollList>
          )}
        </PageCell>

        <PageCell span={5}>
          <PersonDetailPane person={selected} />
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
