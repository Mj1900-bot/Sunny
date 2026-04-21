/**
 * Memory — the "what SUNNY remembers" inspector.
 *
 * R12-B additions:
 *   • Cross-tab search bar at top (hits episodic+semantic+procedural in parallel)
 *   • Per-tab row-count chips in tab bar ("EPISODIC · 204")
 *   • RowMenu (EDIT/DELETE/COPY/PIN) wired into EpisodicTab and SemanticTab
 *
 * Four stores: EPISODIC · SEMANTIC · PROCEDURAL · GRAPH + TOOLS/INSIGHTS/HISTORY
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { TABS } from './constants';
import { CrossTabSearch } from './CrossTabSearch';
import { EpisodicTab } from './EpisodicTab';
import { GraphTab } from './GraphTab';
import { HistoryTab } from './HistoryTab';
import { InsightsTab } from './InsightsTab';
import { ProceduralTab } from './ProceduralTab';
import { SemanticTab } from './SemanticTab';
import {
  DISPLAY_FONT,
  statPillStyle,
  statsRowStyle,
  tabBarStyle,
  tabStyle,
} from './styles';
import { TauriRequired } from './TauriRequired';
import { ToolsTab } from './ToolsTab';
import type { ConsolidatorStatus, MemoryStats, Tab } from './types';
import { usePersistentState } from './utils';

// Guard for localStorage reads
const VALID_TABS: ReadonlySet<string> = new Set(TABS.map(t => t.id));
function isTab(v: unknown): v is Tab {
  return typeof v === 'string' && VALID_TABS.has(v);
}
const TAB_STORAGE_KEY = 'sunny.memory.tab';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MemoryPage(): JSX.Element {
  const [tab, setTab] = usePersistentState<Tab>(TAB_STORAGE_KEY, 'episodic', isTab);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [consolidator, setConsolidator] = useState<ConsolidatorStatus | null>(null);

  const refreshStats = useCallback(async () => {
    if (!isTauri) return;
    const [s, c] = await Promise.all([
      invokeSafe<MemoryStats>('memory_stats'),
      invokeSafe<ConsolidatorStatus>('memory_consolidator_status'),
    ]);
    if (s) setStats(s);
    if (c) setConsolidator(c);
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats, tab]);

  // Keyboard hotkeys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === '1') setTab('episodic');
      else if (e.key === '2') setTab('semantic');
      else if (e.key === '3') setTab('procedural');
      else if (e.key === '4') setTab('graph');
      else if (e.key === '5') setTab('tools');
      else if (e.key === '6') setTab('insights');
      else if (e.key === '7') setTab('history');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTab]);

  const badge = stats
    ? `EP ${stats.episodic_count} · SE ${stats.semantic_count} · PR ${stats.procedural_count}`
    : undefined;

  const handleSeeAll = (targetTab: Tab) => {
    setTab(targetTab);
  };

  if (!isTauri) return <TauriRequired />;

  return (
    <ModuleView title="MEMORY" badge={badge}>
      <StatsHeader stats={stats} consolidator={consolidator} />

      {/* Cross-tab search — only shown on episodic/semantic/procedural, not graph/tools/insights/history */}
      {(tab === 'episodic' || tab === 'semantic' || tab === 'procedural') && (
        <CrossTabSearch onSeeAll={handleSeeAll} />
      )}

      <TabBar tab={tab} setTab={setTab} stats={stats} />
      <TabBody tab={tab} onChange={refreshStats} />
    </ModuleView>
  );
}

// ---------------------------------------------------------------------------
// Header — stats at a glance + consolidator status
// ---------------------------------------------------------------------------

function StatsHeader({
  stats,
  consolidator,
}: {
  stats: MemoryStats | null;
  consolidator: ConsolidatorStatus | null;
}): JSX.Element {
  const oldest = stats?.oldest_episodic_secs ?? null;
  const ageDays = oldest
    ? Math.max(0, Math.floor((Date.now() / 1000 - oldest) / 86400))
    : null;

  return (
    <div style={statsRowStyle}>
      <span style={statPillStyle}>
        <span style={{ color: 'var(--ink-dim)' }}>EPISODIC</span>
        <strong style={{ fontFamily: DISPLAY_FONT }}>{stats?.episodic_count ?? '—'}</strong>
      </span>
      <span style={statPillStyle}>
        <span style={{ color: 'var(--ink-dim)' }}>SEMANTIC</span>
        <strong style={{ fontFamily: DISPLAY_FONT }}>{stats?.semantic_count ?? '—'}</strong>
      </span>
      <span style={statPillStyle}>
        <span style={{ color: 'var(--ink-dim)' }}>PROCEDURAL</span>
        <strong style={{ fontFamily: DISPLAY_FONT }}>{stats?.procedural_count ?? '—'}</strong>
      </span>
      {ageDays !== null && (
        <span style={{ ...statPillStyle, borderColor: 'transparent' }}>
          <span style={{ color: 'var(--ink-dim)' }}>OLDEST</span>
          <strong style={{ fontFamily: DISPLAY_FONT }}>{ageDays}d</strong>
        </span>
      )}
      {consolidator && (
        <span style={{ ...statPillStyle, borderColor: 'transparent' }}>
          <span style={{ color: 'var(--ink-dim)' }}>CONSOLIDATOR PENDING</span>
          <strong
            style={{
              fontFamily: DISPLAY_FONT,
              color:
                consolidator.pending_count >= consolidator.min_floor
                  ? 'var(--green)'
                  : 'var(--ink-dim)',
            }}
          >
            {consolidator.pending_count}
          </strong>
          <span style={{ color: 'var(--ink-dim)' }}>/ {consolidator.min_floor}</span>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab bar — includes per-tab row-count chips
// ---------------------------------------------------------------------------

function TabBar({
  tab,
  setTab,
  stats,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  stats: MemoryStats | null;
}): JSX.Element {
  // Map tab id → count from stats
  const countFor = (id: Tab): number | null => {
    if (!stats) return null;
    if (id === 'episodic') return stats.episodic_count;
    if (id === 'semantic') return stats.semantic_count;
    if (id === 'procedural') return stats.procedural_count;
    return null;
  };

  return (
    <div style={tabBarStyle} role="tablist" aria-label="Memory stores">
      {TABS.map(t => {
        const active = tab === t.id;
        const count = countFor(t.id);
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            style={{
              ...tabStyle(active),
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
            onClick={() => setTab(t.id)}
            title={`${t.label} · press ${t.hotkey}`}
          >
            <span>{t.label}</span>
            {count !== null && (
              <span style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                letterSpacing: '0.06em',
                color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                padding: '0 4px',
                border: '1px solid var(--line-soft)',
                lineHeight: 1.5,
              }}>
                {count}
              </span>
            )}
            <span style={{ opacity: 0.4, fontSize: 8 }}>{t.hotkey}</span>
          </button>
        );
      })}
    </div>
  );
}

function TabBody({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: () => void;
}): JSX.Element {
  if (tab === 'episodic') return <EpisodicTab onChange={onChange} />;
  if (tab === 'semantic') return <SemanticTab onChange={onChange} />;
  if (tab === 'procedural') return <ProceduralTab onChange={onChange} />;
  if (tab === 'graph') return <GraphTab />;
  if (tab === 'tools') return <ToolsTab />;
  if (tab === 'history') return <HistoryTab />;
  return <InsightsTab />;
}
