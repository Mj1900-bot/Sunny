// ─────────────────────────────────────────────────────────────────
// AutoPage — premium automation command center for SUNNY.
//
// Renders:
//  • Hero stat strip with live counters + system heartbeat
//  • Animated tab bar with badge counts
//  • Four premium tabs: AGENTS, ACTIVITY, SCHEDULED, TODOS
// ─────────────────────────────────────────────────────────────────

import { useMemo, useState, type CSSProperties } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { isTauri } from '../../lib/tauri';
import { PageGrid, PageCell, StatBlock } from '../_shared';
import { useDaemons } from '../../store/daemons';
import { useSubAgents } from '../../store/subAgents';
import { AgentsTab } from './AgentsTab';
import { ActivityTab } from './ActivityTab';
import { ScheduledTab, type SchedulerCounts } from './ScheduledTab';
import { TodosTab, useTodoCounts } from './TodosTab';

type TabId = 'agents' | 'activity' | 'scheduled' | 'todos';

const TAB_DEFS: ReadonlyArray<{ id: TabId; label: string; icon: string }> = [
  { id: 'agents',    label: 'AGENTS',    icon: '⬡' },
  { id: 'activity',  label: 'ACTIVITY',  icon: '◈' },
  { id: 'scheduled', label: 'SCHEDULED', icon: '◎' },
  { id: 'todos',     label: 'TODOS',     icon: '☑' },
];

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const tabBarStyle: CSSProperties = {
  display: 'flex',
  gap: 0,
  borderBottom: '1px solid var(--line-soft)',
  marginBottom: 16,
  position: 'relative',
  overflow: 'hidden',
};

const tabBtnStyle = (active: boolean): CSSProperties => ({
  all: 'unset',
  cursor: 'pointer',
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '10px 14px',
  fontFamily: 'var(--display)',
  fontSize: 10,
  letterSpacing: '0.22em',
  fontWeight: 700,
  color: active ? '#fff' : 'var(--ink-dim)',
  background: active
    ? 'linear-gradient(180deg, rgba(57, 229, 255, 0.18) 0%, rgba(57, 229, 255, 0.04) 100%)'
    : 'transparent',
  borderBottom: active ? '2px solid var(--cyan)' : '2px solid transparent',
  transition: 'all 200ms ease',
  position: 'relative',
});

const tabIconStyle = (active: boolean): CSSProperties => ({
  fontSize: 13,
  color: active ? 'var(--cyan)' : 'var(--ink-dim)',
  filter: active ? 'drop-shadow(0 0 4px var(--cyan))' : 'none',
  transition: 'color 200ms ease, filter 200ms ease',
});

const tabBadgeStyle = (value: number | string, tone: string): CSSProperties => ({
  fontFamily: 'var(--mono)',
  fontSize: 9,
  fontWeight: 700,
  color: '#fff',
  background: tone,
  padding: '1px 6px',
  borderRadius: 2,
  letterSpacing: '0.08em',
  boxShadow: `0 0 6px ${tone}55`,
  minWidth: 14,
  textAlign: 'center',
  lineHeight: 1.4,
  display: value === 0 || value === '0' ? 'none' : 'inline-block',
});

const heartbeatStyle = (alive: boolean): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: alive ? 'var(--green)' : 'var(--ink-dim)',
  boxShadow: alive ? '0 0 10px var(--green)' : 'none',
  animation: alive ? 'pulseDot 1.4s infinite' : 'none',
  flexShrink: 0,
});

const contentWrapStyle: CSSProperties = {
  animation: 'fadeSlideIn 250ms ease-out',
};

const offlineStyle: CSSProperties = {
  padding: 32,
  border: '1px dashed rgba(57, 229, 255, 0.25)',
  background: 'rgba(6, 14, 22, 0.5)',
  color: 'var(--ink-dim)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  lineHeight: 1.6,
  textAlign: 'center',
};

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────

export function AutoPage() {
  const [tab, setTab] = useState<TabId>('agents');
  const [schedCounts, setSchedCounts] = useState<SchedulerCounts>({ enabled: 0, total: 0 });

  // Live data for stats
  const daemons = useDaemons(s => s.list);
  const runs = useSubAgents(s => s.runs);
  const todoCounts = useTodoCounts();

  const enabledAgents = useMemo(() => daemons.filter(d => d.enabled).length, [daemons]);
  const activeRuns = useMemo(
    () => runs.filter(r => r.status === 'queued' || r.status === 'running').length,
    [runs],
  );
  const systemAlive = activeRuns > 0 || enabledAgents > 0;

  // Next fire countdown
  const nextFire = useMemo(() => {
    const upcoming = daemons
      .filter(d => d.enabled && d.next_run !== null)
      .map(d => d.next_run as number)
      .sort((a, b) => a - b);
    if (upcoming.length === 0) return '—';
    const diff = Math.max(0, upcoming[0] - Math.floor(Date.now() / 1000));
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }, [daemons]);

  // Tab badges
  const badgeFor = (id: TabId): { value: number | string; tone: string } => {
    switch (id) {
      case 'agents':    return { value: enabledAgents, tone: 'var(--green)' };
      case 'activity':  return { value: activeRuns, tone: 'var(--cyan)' };
      case 'scheduled': return { value: schedCounts.enabled, tone: 'var(--amber)' };
      case 'todos':     return { value: todoCounts.open, tone: 'var(--violet)' };
    }
  };

  if (!isTauri) {
    return (
      <ModuleView title="AUTOMATION">
        <div style={offlineStyle}>
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 14,
              letterSpacing: '0.28em',
              color: 'var(--cyan)',
              fontWeight: 700,
              marginBottom: 14,
            }}
          >
            BACKEND REQUIRED
          </div>
          The Auto page needs the Tauri scheduler runtime. Launch SUNNY via{' '}
          <code
            style={{
              margin: '0 4px',
              color: 'var(--cyan)',
              background: 'rgba(57, 229, 255, 0.08)',
              padding: '2px 6px',
            }}
          >
            pnpm tauri dev
          </code>{' '}
          to manage scheduled jobs.
        </div>
      </ModuleView>
    );
  }

  return (
    <ModuleView title="AUTOMATION">
      <PageGrid>
        {/* Hero stats row */}
        <PageCell span={12}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 10,
              animation: 'fadeSlideIn 300ms ease-out',
            }}
          >
            <StatBlock
              label="AGENTS"
              value={`${enabledAgents}/${daemons.length}`}
              sub="enabled"
              tone="green"
            />
            <StatBlock
              label="LIVE RUNS"
              value={String(activeRuns)}
              sub={activeRuns > 0 ? 'streaming' : 'idle'}
              tone={activeRuns > 0 ? 'cyan' : 'amber'}
            />
            <StatBlock
              label="SCHEDULED"
              value={`${schedCounts.enabled}/${schedCounts.total}`}
              sub="jobs active"
              tone="amber"
            />
            <StatBlock
              label="NEXT FIRE"
              value={nextFire}
              sub="countdown"
              tone="violet"
            />
            <StatBlock
              label="TODOS"
              value={`${todoCounts.open}/${todoCounts.total}`}
              sub={`${todoCounts.total - todoCounts.open} done`}
              tone="gold"
            />
            {/* System heartbeat */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                border: '1px solid var(--line-soft)',
                background: systemAlive
                  ? 'linear-gradient(135deg, rgba(125, 255, 154, 0.06), transparent)'
                  : 'rgba(6, 14, 22, 0.5)',
              }}
            >
              <div style={heartbeatStyle(systemAlive)} />
              <div>
                <div
                  style={{
                    fontFamily: 'var(--display)',
                    fontSize: 8,
                    letterSpacing: '0.22em',
                    color: 'var(--ink-dim)',
                    fontWeight: 700,
                  }}
                >
                  SYSTEM
                </div>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 14,
                    fontWeight: 700,
                    color: systemAlive ? 'var(--green)' : 'var(--ink-dim)',
                    marginTop: 2,
                  }}
                >
                  {systemAlive ? 'ACTIVE' : 'IDLE'}
                </div>
              </div>
            </div>
          </div>
        </PageCell>

        {/* Tab bar */}
        <PageCell span={12}>
          <div style={tabBarStyle}>
            {TAB_DEFS.map(t => {
              const badge = badgeFor(t.id);
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={tabBtnStyle(active)}
                  aria-pressed={active}
                >
                  <span style={tabIconStyle(active)}>{t.icon}</span>
                  {t.label}
                  <span style={tabBadgeStyle(badge.value, badge.tone)}>
                    {badge.value}
                  </span>
                </button>
              );
            })}
          </div>
        </PageCell>

        {/* Tab content */}
        <PageCell span={12}>
          <div key={tab} style={contentWrapStyle}>
            {tab === 'agents' && <AgentsTab />}
            {tab === 'activity' && <ActivityTab />}
            {tab === 'scheduled' && <ScheduledTab onCountsChange={setSchedCounts} />}
            {tab === 'todos' && <TodosTab />}
          </div>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
