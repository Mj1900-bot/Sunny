/**
 * COST — Per-session spend, cache efficiency, and model latency.
 *
 * Layout (12-col grid):
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Today's cost  │  Turns today  │  Cache hit %           │  (row 1, span 12)
 *   ├────────────────────┬───────────────────┬─────────────────┤
 *   │  Model donut (4)   │  Tier dist. (4)   │  Latency (4)    │  (row 2)
 *   ├──────────┬─────────┴───────────────────┴────────┬────────┤
 *   │  p50/p95 │  $/hr rolling chart                  │  Turns │  (row 3)
 *   │  (span 4)│  (span 4)                            │  (4)   │
 *   └──────────┴──────────────────────────────────────┴────────┘
 *
 * Live updates: subscribes to `sunny://cost/update` and `sunny://perf/update`
 * Tauri events.  Falls back to polling every 3 s if those events aren't
 * emitted (i.e. before the event-bus wiring is added).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { PageGrid, PageCell, Section, EmptyState } from '../_shared';
import { listen } from '../../lib/tauri';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  fetchCostToday, fetchRecentTurns, fetchPerfSnapshot,
  computeModelSlices, computeHourlyBuckets, computeTierSlices,
  type LlmStats,
} from './api';
import { invokeSafe } from '../../lib/tauri';
import { StatCards } from './StatCards';
import { DonutChart } from './DonutChart';
import { LatencySparkline } from './LatencySparkline';
import { LatencyTable } from './LatencyTable';
import { CostHourlyChart } from './CostHourlyChart';
import { TurnsLog } from './TurnsLog';
import { TierDistribution } from './TierDistribution';
import { LastTurnPill } from './LastTurnPill';
import type { CostToday, TelemetryEvent, PerfSnapshot } from './types';

const POLL_MS = 3_000;

export function CostPage() {
  const [costToday,   setCostToday]   = useState<CostToday | null>(null);
  const [llmStats,    setLlmStats]    = useState<LlmStats | null>(null);
  const [events,      setEvents]      = useState<ReadonlyArray<TelemetryEvent>>([]);
  const [perfSnap,    setPerfSnap]    = useState<PerfSnapshot | null>(null);
  const [perfLoading, setPerfLoading] = useState(true);
  const mountedRef = useRef(true);

  // ── Fetch all data in one pass ─────────────────────────────────────────
  const loadAll = async () => {
    const [cost, turns, stats, perf] = await Promise.all([
      fetchCostToday(),
      fetchRecentTurns(100),
      invokeSafe<LlmStats>('telemetry_llm_stats'),
      fetchPerfSnapshot(),
    ]);
    if (!mountedRef.current) return;
    if (cost)  setCostToday(cost);
    if (turns) setEvents(turns);
    if (stats) setLlmStats(stats);
    setPerfSnap(perf);
    setPerfLoading(false);
  };

  useEffect(() => {
    mountedRef.current = true;
    void loadAll();

    // Subscribe to push events; fall back gracefully if not emitted yet
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<null>('sunny://cost/update', () => { void loadAll(); }),
      listen<null>('sunny://perf/update', () => { void loadAll(); }),
    ];

    // Polling fallback at 3 s
    const timer = window.setInterval(() => { void loadAll(); }, POLL_MS);

    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      unlisteners.forEach(p => p.then(fn => fn()).catch(() => undefined));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived data ──────────────────────────────────────────────────────
  const modelSlices   = useMemo(() => computeModelSlices(events),  [events]);
  const hourlyBuckets = useMemo(() => computeHourlyBuckets(events), [events]);
  const tierSlices    = useMemo(
    () => costToday ? computeTierSlices(costToday.by_tier) : [],
    [costToday],
  );
  const lastEvent = events.length > 0 ? events[0] : null;
  const noData    = events.length === 0;

  return (
    <ModuleView title="COST · PERFORMANCE">
      <PageGrid>
        {/* Row 1: Stat cards + last-turn pill */}
        <PageCell span={12}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
              <StatCards costToday={costToday} llmStats={llmStats} />
            </div>
            <div style={{ flexShrink: 0, paddingTop: 4 }}>
              <LastTurnPill lastEvent={lastEvent} />
            </div>
          </div>
        </PageCell>

        {/* Row 2: Donut + Tier distribution + Latency sparkline */}
        <PageCell span={4}>
          <Section title="MODEL DISTRIBUTION · LAST 100 TURNS" right={`${events.length} events`}>
            {noData ? (
              <EmptyState
                title="No turns recorded"
                hint="Complete a conversation turn to see model distribution here."
              />
            ) : (
              <DonutChart slices={modelSlices} />
            )}
          </Section>
        </PageCell>

        <PageCell span={4}>
          <Section title="TIER DISTRIBUTION · TODAY">
            <TierDistribution slices={tierSlices} />
          </Section>
        </PageCell>

        <PageCell span={4}>
          <Section title="TURN LATENCY · LAST 100 (LOG SCALE)" right="ttft ms">
            <LatencySparkline events={events} />
          </Section>
        </PageCell>

        {/* Row 3: Latency table + Hourly cost chart + Turns log */}
        <PageCell span={4}>
          <LatencyTable snapshot={perfSnap} loading={perfLoading} />
        </PageCell>

        <PageCell span={4}>
          <CostHourlyChart buckets={hourlyBuckets} />
        </PageCell>

        <PageCell span={4}>
          <TurnsLog events={events} />
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
