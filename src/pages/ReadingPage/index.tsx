/**
 * READING — a later-queue for articles, with AI summaries on demand.
 *
 * Bookmarks are stored locally (no new Rust table needed). TLDR / BRIEF
 * buttons ask Sunny to one-sentence / three-sentence the excerpt; the reply
 * streams into chat panel via the standard askSunny event. The right-hand
 * reader pane renders the locally-cached excerpt so you can skim without
 * losing your place in the list.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, StatBlock, EmptyState, Toolbar, ToolbarButton,
  TabBar, ScrollList, Chip, relTime,
} from '../_shared';
import { invokeSafe } from '../../lib/tauri';
import { askSunny } from '../../lib/askSunny';
import { useView } from '../../store/view';
import { AddForm } from './AddForm';
import {
  bulkSetStatusForIds,
  dedupeByUrl,
  duplicateReading,
  exportQueueJson,
  importQueueMerge,
  importQueueReplace,
  removeReading,
  setStatus,
  updateTags,
  useReading,
  type ReadingItem,
} from './store';

type Tab = 'queue' | 'reading' | 'done' | 'all';
type SortKey = 'added' | 'shortest' | 'longest' | 'domain';

const STATUS_TO_TAB: Record<0 | 1 | 2, Exclude<Tab, 'all'>> = { 0: 'queue', 1: 'reading', 2: 'done' };
const WEEK_SECS = 7 * 86_400;

const STATUS_LABEL: Record<0 | 1 | 2, string> = {
  0: 'QUEUE', 1: 'READING', 2: 'DONE',
};
const STATUS_TONE: Record<0 | 1 | 2, 'cyan' | 'amber' | 'green'> = {
  0: 'cyan', 1: 'amber', 2: 'green',
};

export function ReadingPage() {
  const items = useReading();
  // Initial tab follows MODULES · READING DEFAULT TAB. Per-visit changes
  // are preserved via useState — we only consult the default on mount.
  const defaultTab = useView(s => s.settings.readingDefaultTab);
  const [tab, setTab] = useState<Tab>(() => defaultTab as Tab);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('added');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const importModeRef = useRef<'merge' | 'replace'>('merge');
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [dataBanner, setDataBanner] = useState<string | null>(null);

  const counts = useMemo(() => ({
    queue:   items.filter(i => i.status === 0).length,
    reading: items.filter(i => i.status === 1).length,
    done:    items.filter(i => i.status === 2).length,
    all:     items.length,
  }), [items]);

  const filtered = useMemo(() => {
    let list = tab === 'all' ? items : items.filter(i => STATUS_TO_TAB[i.status] === tab);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.domain.toLowerCase().includes(q) ||
        (i.tags ?? []).some(t => t.toLowerCase().includes(q)) ||
        (i.excerpt ?? '').toLowerCase().includes(q),
      );
    }
    if (tagFilter) {
      list = list.filter(i => (i.tags ?? []).includes(tagFilter));
    }
    const sorted = [...list];
    if (sortKey === 'shortest') {
      sorted.sort((a, b) => (a.minutes ?? 999) - (b.minutes ?? 999));
    } else if (sortKey === 'longest') {
      sorted.sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0));
    } else if (sortKey === 'domain') {
      sorted.sort((a, b) => a.domain.localeCompare(b.domain));
    } else {
      sorted.sort((a, b) => b.added_at - a.added_at);
    }
    return sorted;
  }, [items, tab, query, tagFilter, sortKey]);

  // UNREAD / READ THIS WEEK / AVG LENGTH replace the old status bars —
  // gives a sense of throughput rather than just pile sizes.
  const stats = useMemo(() => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const unread = items.filter(i => i.status === 0).length;
    const readThisWeek = items.filter(
      i => i.status === 2 && (nowSecs - i.added_at) < WEEK_SECS,
    ).length;
    const withMinutes = items.filter(i => typeof i.minutes === 'number' && i.minutes !== null);
    const avgLen = withMinutes.length > 0
      ? Math.round(
          withMinutes.reduce((n, i) => n + (i.minutes ?? 0), 0) / withMinutes.length,
        )
      : 0;
    return { unread, readThisWeek, avgLen };
  }, [items]);

  // Collect tag universe from whatever matches the current tab (ignoring
  // tagFilter itself), so the chip row offers useful ways to slice.
  const tagUniverse = useMemo(() => {
    const base = tab === 'all' ? items : items.filter(i => STATUS_TO_TAB[i.status] === tab);
    const bag = new Map<string, number>();
    for (const it of base) for (const t of (it.tags ?? [])) bag.set(t, (bag.get(t) ?? 0) + 1);
    return [...bag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [items, tab]);

  const selected = useMemo(
    () => (selectedId ? items.find(i => i.id === selectedId) ?? null : null),
    [items, selectedId],
  );

  const filteredIdsKey = useMemo(() => filtered.map(i => i.id).join('\0'), [filtered]);

  // When the current id is not in the filtered list (tab/search/tag change),
  // snap to the first visible row. If the user cleared with Esc (`null`),
  // do not force a selection back on.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId(prev => {
      if (prev && filtered.some(i => i.id === prev)) return prev;
      if (prev === null) return null;
      return filtered[0]!.id;
    });
  }, [filteredIdsKey]);

  useLayoutEffect(() => {
    if (!selectedId) return;
    const safe = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(selectedId)
      : selectedId.replace(/["\\]/g, '');
    const el = document.querySelector(`[data-reading-id="${safe}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId, filteredIdsKey]);

  const open = (url: string) => { void invokeSafe('open_url', { url }); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keyboard nav: j/k to step, o to open original, enter to toggle reader.
  const navigate = useCallback((dir: 1 | -1) => {
    if (filtered.length === 0) return;
    const currentIdx = selected
      ? Math.max(0, filtered.findIndex(f => f.id === selected.id))
      : -1;
    const nextIdx = currentIdx < 0
      ? (dir === 1 ? 0 : filtered.length - 1)
      : (currentIdx + dir + filtered.length) % filtered.length;
    const next = filtered[nextIdx];
    if (next) setSelectedId(next.id);
  }, [filtered, selected]);

  return (
    <ModuleView title="READING · LATER">
      <PageGrid>
        <PageCell span={12}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <StatBlock label="UNREAD" value={String(stats.unread)} tone="cyan" />
            <StatBlock label="READ THIS WEEK" value={String(stats.readThisWeek)} tone="green" />
            <StatBlock
              label="AVG LENGTH"
              value={stats.avgLen > 0 ? `${stats.avgLen} min` : '—'}
              tone="violet"
            />
          </div>
        </PageCell>

        <PageCell span={12}>
          <AddForm />
        </PageCell>

        <PageCell span={12}>
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const reader = new FileReader();
              reader.onload = () => {
                const t = String(reader.result ?? '');
                if (importModeRef.current === 'merge') {
                  const { added, error } = importQueueMerge(t);
                  setDataBanner(error ? `Merge: ${error}` : `Merged ${added} new URL(s)`);
                } else {
                  if (!window.confirm('Replace the entire reading queue with this file?')) return;
                  const { ok, error } = importQueueReplace(t);
                  setDataBanner(ok ? 'Queue replaced from file' : `Replace failed: ${error ?? 'unknown'}`);
                }
                window.setTimeout(() => setDataBanner(null), 5000);
              };
              reader.readAsText(f);
            }}
          />
          <Toolbar>
            <span style={{
              fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
              color: 'var(--ink-dim)', fontWeight: 700,
            }}>DATA</span>
            <ToolbarButton
              tone="cyan"
              onClick={() => {
                const name = `sunny-reading-${new Date().toISOString().slice(0, 10)}.json`;
                const blob = new Blob([exportQueueJson()], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = name;
                a.click();
                URL.revokeObjectURL(a.href);
                setDataBanner('Exported JSON');
                window.setTimeout(() => setDataBanner(null), 3000);
              }}
            >EXPORT JSON</ToolbarButton>
            <ToolbarButton
              onClick={() => {
                importModeRef.current = 'merge';
                importFileRef.current?.click();
              }}
            >MERGE IMPORT</ToolbarButton>
            <ToolbarButton
              tone="amber"
              onClick={() => {
                importModeRef.current = 'replace';
                importFileRef.current?.click();
              }}
            >REPLACE IMPORT</ToolbarButton>
            <ToolbarButton
              onClick={() => {
                const n = dedupeByUrl();
                setDataBanner(n > 0 ? `Removed ${n} duplicate URL(s)` : 'No duplicates');
                window.setTimeout(() => setDataBanner(null), 4000);
              }}
            >DEDUPE URLS</ToolbarButton>
            <ToolbarButton
              tone="green"
              onClick={() => {
                const ids = filtered.filter(i => i.status !== 2).map(i => i.id);
                if (ids.length === 0) {
                  setDataBanner('Nothing to mark');
                  window.setTimeout(() => setDataBanner(null), 2500);
                  return;
                }
                bulkSetStatusForIds(ids, 2);
                setDataBanner(`Marked ${ids.length} as done`);
                window.setTimeout(() => setDataBanner(null), 4000);
              }}
            >MARK VISIBLE DONE</ToolbarButton>
            <ToolbarButton
              tone="violet"
              onClick={() => {
                const md = filtered.map((it, i) =>
                  `${i + 1}. [${it.title.replace(/\]/g, '')}](${it.url}) · ${it.domain}`,
                ).join('\n');
                void navigator.clipboard?.writeText(md).then(() => {
                  setDataBanner('Markdown list copied');
                  window.setTimeout(() => setDataBanner(null), 3000);
                });
              }}
            >COPY LIST</ToolbarButton>
          </Toolbar>
          {dataBanner && (
            <div style={{
              marginTop: 6,
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
              color: 'var(--cyan)',
            }}>{dataBanner}</div>
          )}
        </PageCell>

        <PageCell span={12}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <TabBar
              value={tab}
              onChange={(t: string) => setTab(t as Tab)}
              tabs={[
                { id: 'queue',   label: 'QUEUE',   count: counts.queue },
                { id: 'reading', label: 'READING', count: counts.reading },
                { id: 'done',    label: 'DONE',    count: counts.done },
                { id: 'all',     label: 'ALL',     count: counts.all },
              ]}
            />
            <span style={{ flex: 1 }} />
            <div style={{ position: 'relative', minWidth: 220, flex: '0 1 280px' }}>
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="search saved…"
                style={{
                  all: 'unset', width: '100%', boxSizing: 'border-box',
                  padding: '6px 44px 6px 10px',
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                  border: '1px solid var(--line-soft)',
                  background: 'rgba(0, 0, 0, 0.3)',
                }}
              />
              <span style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
                letterSpacing: '0.12em', pointerEvents: 'none',
              }}>⌘F</span>
            </div>
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              style={{
                all: 'unset', cursor: 'pointer',
                padding: '6px 10px',
                fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.2em',
                color: 'var(--ink-2)', fontWeight: 700,
                border: '1px solid var(--line-soft)',
                background: 'rgba(0, 0, 0, 0.3)',
              }}
            >
              <option value="added">NEWEST</option>
              <option value="shortest">SHORTEST</option>
              <option value="longest">LONGEST</option>
              <option value="domain">DOMAIN</option>
            </select>
          </div>
        </PageCell>

        {tagUniverse.length > 0 && (
          <PageCell span={12}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
                color: 'var(--ink-dim)', fontWeight: 700, marginRight: 2,
              }}>TAGS</span>
              <TagPill
                label="ALL"
                tone={tagFilter === null ? 'cyan' : 'dim'}
                active={tagFilter === null}
                onClick={() => setTagFilter(null)}
              />
              {tagUniverse.map(([t, n]) => (
                <TagPill
                  key={t}
                  label={`${t} · ${n}`}
                  tone={tagFilter === t ? 'violet' : 'dim'}
                  active={tagFilter === t}
                  onClick={() => setTagFilter(tagFilter === t ? null : t)}
                />
              ))}
            </div>
          </PageCell>
        )}

        <PageCell span={12}>
          {filtered.length === 0 ? (
            <EmptyState
              title={query || tagFilter ? 'No matches' : `Nothing in ${tab}`}
              hint={query || tagFilter
                ? 'Try clearing filters or the search box.'
                : 'Paste a URL above to start saving articles for later.'}
            />
          ) : (
            <div
              tabIndex={0}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') { e.preventDefault(); navigate(1); }
                else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') { e.preventDefault(); navigate(-1); }
                else if (e.key === 'Escape') { setSelectedId(null); }
                else if (e.key === 'Enter' && selected) {
                  const t = e.target as HTMLElement | null;
                  if (t?.closest?.('input, textarea, select, button')) return;
                  e.preventDefault();
                  open(selected.url);
                }
                else if (e.key.toLowerCase() === 'o' && selected) { open(selected.url); }
              }}
              style={{
                outline: 'none',
                display: 'grid',
                gridTemplateColumns: selected ? 'minmax(0, 1.05fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
                gap: 12,
                minHeight: 0,
              }}
            >
              <ScrollList maxHeight={560} style={{ gap: 4 }}>
                {filtered.map(it => (
                  <ReadingRow
                    key={it.id}
                    it={it}
                    onOpen={open}
                    onSelect={() => setSelectedId(it.id)}
                    isSelected={selected?.id === it.id}
                  />
                ))}
              </ScrollList>
              {selected && <ReaderPane it={selected} onOpen={open} onClose={() => setSelectedId(null)} />}
            </div>
          )}
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}

function TagPill({
  label, tone, active, onClick,
}: {
  label: string; tone: 'cyan' | 'violet' | 'dim'; active: boolean; onClick: () => void;
}) {
  const color = tone === 'dim' ? 'var(--ink-dim)' : `var(--${tone})`;
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset', cursor: 'pointer',
        padding: '3px 8px',
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.18em',
        fontWeight: 700,
        color: active ? '#fff' : color,
        border: `1px solid ${color}`,
        background: active ? `${color}22` : 'rgba(0, 0, 0, 0.25)',
        textTransform: 'uppercase',
      }}
    >{label}</button>
  );
}

// ----- Reader pane ----------------------------------------------------------

function ReaderPane({
  it, onOpen, onClose,
}: {
  it: ReadingItem;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const wordCount = useMemo(() => {
    const txt = (it.excerpt ?? '').trim();
    return txt ? txt.split(/\s+/).length : 0;
  }, [it.excerpt]);

  return (
    <aside style={{
      border: '1px solid var(--line-soft)',
      borderLeft: `2px solid var(--${STATUS_TONE[it.status]})`,
      background: 'rgba(6, 14, 22, 0.55)',
      padding: '16px 20px',
      display: 'flex', flexDirection: 'column', gap: 12,
      minHeight: 0, overflow: 'auto',
      maxHeight: 560,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
        color: 'var(--ink-dim)', fontWeight: 700,
      }}>
        <Chip tone={STATUS_TONE[it.status]}>{STATUS_LABEL[it.status]}</Chip>
        <span>{it.domain.toUpperCase()}</span>
        {it.minutes != null && <span>· {it.minutes} MIN READ</span>}
        <span>· SAVED {relTime(it.added_at).toUpperCase()}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onClose}
          title="Close reader (Esc)"
          style={{
            all: 'unset', cursor: 'pointer',
            padding: '0 6px', color: 'var(--ink-dim)',
            fontFamily: 'var(--display)', fontSize: 14, fontWeight: 900,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--cyan)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--ink-dim)')}
        >×</button>
      </div>
      <h2 style={{
        margin: 0,
        fontFamily: 'var(--display)', color: 'var(--cyan)',
        fontSize: 22, lineHeight: 1.2, letterSpacing: '0.02em', fontWeight: 700,
      }}>{it.title}</h2>
      {it.summary && (
        <div style={{
          fontFamily: 'var(--label)', fontSize: 12.5, color: 'var(--ink-2)',
          lineHeight: 1.55,
          padding: '10px 12px',
          background: 'rgba(180, 140, 255, 0.06)',
          borderLeft: '2px solid var(--violet)',
        }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.24em',
            color: 'var(--violet)', fontWeight: 700, marginBottom: 4,
          }}>SUNNY SUMMARY</div>
          {it.summary}
        </div>
      )}
      {it.excerpt ? (
        <div style={{
          fontFamily: 'var(--label)', fontSize: 15, lineHeight: 1.65,
          color: 'var(--ink)',
          maxWidth: '68ch',
          whiteSpace: 'pre-wrap',
        }}>{it.excerpt}</div>
      ) : (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
          fontStyle: 'italic',
        }}>No excerpt cached — open the original or re-save to fetch.</div>
      )}
      {wordCount > 0 && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
          letterSpacing: '0.18em', paddingTop: 4,
          borderTop: '1px solid var(--line-soft)',
        }}>EXCERPT · {wordCount} WORDS</div>
      )}
      <Toolbar>
        <ToolbarButton onClick={() => onOpen(it.url)} tone="cyan">OPEN ORIGINAL</ToolbarButton>
        <ToolbarButton
          tone="violet"
          onClick={() => askSunny(
            it.excerpt
              ? `Three-sentence brief of: ${it.excerpt}`
              : `Fetch ${it.url} and give a three-sentence brief. Topic: ${it.title}.`,
            'reading',
          )}
        >BRIEF</ToolbarButton>
        <ToolbarButton
          tone="amber"
          onClick={() => askSunny(
            it.excerpt
              ? `Extract the 3 key insights and 2 open questions from: ${it.excerpt}`
              : `Fetch ${it.url} and extract the 3 key insights and 2 open questions.`,
            'reading',
          )}
        >INSIGHTS</ToolbarButton>
      </Toolbar>
    </aside>
  );
}

// ----- Row ------------------------------------------------------------------

function ReadingRow({
  it, onOpen, onSelect, isSelected,
}: {
  it: ReadingItem;
  onOpen: (url: string) => void;
  onSelect: () => void;
  isSelected: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const accent = `var(--${STATUS_TONE[it.status]})`;
  return (
    <div
      data-reading-id={it.id}
      onClick={onSelect}
      style={{
        position: 'relative',
        border: isSelected ? `1px solid ${accent}` : '1px solid var(--line-soft)',
        borderLeft: `2px solid ${accent}`,
        padding: '10px 14px',
        display: 'flex', flexDirection: 'column', gap: 6,
        background: isSelected
          ? 'rgba(57, 229, 255, 0.06)'
          : 'rgba(6, 14, 22, 0.55)',
        cursor: 'pointer',
        transition: 'border-color 140ms ease, background 140ms ease',
      }}
      onMouseEnter={e => {
        if (!isSelected) e.currentTarget.style.borderColor = 'var(--cyan)';
      }}
      onMouseLeave={e => {
        if (!isSelected) e.currentTarget.style.borderColor = 'var(--line-soft)';
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        letterSpacing: '0.12em', textTransform: 'uppercase',
      }}>
        <span style={{ color: accent, fontWeight: 700 }}>{STATUS_LABEL[it.status]}</span>
        <span>·</span>
        <span>{it.domain}</span>
        {it.minutes != null && (<><span>·</span><span>{it.minutes} MIN</span></>)}
        <span style={{ flex: 1 }} />
        <span>{relTime(it.added_at)}</span>
      </div>
      <button
        onClick={e => { e.stopPropagation(); onOpen(it.url); }}
        style={{
          all: 'unset', cursor: 'pointer',
          fontFamily: 'var(--label)', fontSize: 14, fontWeight: 600,
          color: isSelected ? '#fff' : 'var(--ink)',
          textAlign: 'left',
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          lineHeight: 1.35,
        }}
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--cyan)')}
        onMouseLeave={e => (e.currentTarget.style.color = isSelected ? '#fff' : 'var(--ink)')}
        title="Open original"
      >{it.title}</button>
      {it.summary && (
        <div style={{
          fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink-2)',
          lineHeight: 1.5,
          padding: '6px 10px', background: 'rgba(180, 140, 255, 0.05)',
          borderLeft: '2px solid var(--violet)',
          overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>{it.summary}</div>
      )}
      <div
        onClick={e => e.stopPropagation()}
        style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <TagEditor it={it} />
        <span style={{ flex: 1 }} />
        {it.status !== 1 && (
          <ToolbarButton onClick={() => setStatus(it.id, 1)} tone="amber">READING</ToolbarButton>
        )}
        {it.status !== 2 && (
          <ToolbarButton onClick={() => setStatus(it.id, 2)} tone="green">DONE</ToolbarButton>
        )}
        <ToolbarButton
          tone="violet"
          onClick={() => askSunny(
            it.excerpt
              ? `One sentence summary of: ${it.excerpt}`
              : `Fetch ${it.url} and give one sentence summary. Topic: ${it.title}.`,
            'reading',
          )}
        >TLDR</ToolbarButton>
        <button
          onClick={() => setMenu(v => !v)}
          aria-label="More actions"
          style={{
            all: 'unset', cursor: 'pointer',
            padding: '4px 8px',
            fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.2em',
            fontWeight: 700, color: 'var(--ink-dim)',
            border: '1px solid var(--line-soft)',
            background: 'rgba(0, 0, 0, 0.3)',
          }}
        >⋯</button>
      </div>
      {menu && (
        <OverflowMenu
          onOpen={() => onOpen(it.url)}
          onCopy={() => { void navigator.clipboard?.writeText(it.url); setMenu(false); }}
          onDuplicate={() => { duplicateReading(it.id); setMenu(false); }}
          onReset={() => setStatus(it.id, 0)}
          onDelete={() => removeReading(it.id)}
          onClose={() => setMenu(false)}
        />
      )}
    </div>
  );
}

function OverflowMenu({
  onOpen, onCopy, onDuplicate, onReset, onDelete, onClose,
}: {
  onOpen: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onReset: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', right: 10, bottom: 50, zIndex: 4,
        border: '1px solid var(--line-soft)',
        background: 'rgba(6, 14, 22, 0.96)',
        padding: 4,
        display: 'flex', flexDirection: 'column', gap: 2,
        minWidth: 160,
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.5)',
      }}
    >
      <MenuItem label="Open original" onClick={() => { onOpen(); onClose(); }} />
      <MenuItem label="Copy URL" onClick={onCopy} />
      <MenuItem label="Duplicate" onClick={onDuplicate} />
      <MenuItem label="Reset to queue" onClick={() => { onReset(); onClose(); }} />
      <MenuItem label="Remove" tone="red" onClick={() => { onDelete(); onClose(); }} />
    </div>
  );
}

function MenuItem({
  label, onClick, tone,
}: { label: string; onClick: () => void; tone?: 'red' }) {
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset', cursor: 'pointer',
        padding: '6px 10px',
        fontFamily: 'var(--label)', fontSize: 12,
        color: tone === 'red' ? 'var(--red)' : 'var(--ink)',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(57, 229, 255, 0.08)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >{label}</button>
  );
}

// ----- Tag editor -----------------------------------------------------------

function TagEditor({ it }: { it: ReadingItem }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const next = draft.trim();
    if (next && !(it.tags ?? []).includes(next)) {
      updateTags(it.id, [...(it.tags ?? []), next]);
    }
    setDraft('');
    setAdding(false);
  };

  const remove = (t: string) => {
    updateTags(it.id, (it.tags ?? []).filter(x => x !== t));
  };

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
    >
      {(it.tags ?? []).map(t => (
        <span
          key={t}
          onClick={() => remove(t)}
          title="click to remove"
          style={{ cursor: 'pointer' }}
        >
          <Chip tone="violet">{t} ×</Chip>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setAdding(false); setDraft(''); }
          }}
          onBlur={commit}
          placeholder="tag…"
          style={{
            all: 'unset',
            padding: '2px 7px',
            border: '1px solid var(--violet)',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--violet)',
            letterSpacing: '0.14em',
            background: 'rgba(0, 0, 0, 0.3)',
            minWidth: 80,
          }}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          style={{
            all: 'unset', cursor: 'pointer',
            padding: '2px 8px',
            border: '1px dashed var(--ink-dim)',
            color: 'var(--ink-dim)',
            fontFamily: 'var(--display)', fontSize: 10, letterSpacing: '0.18em',
            fontWeight: 700,
          }}
        >+</button>
      )}
    </div>
  );
}
