/**
 * BRAIN — model + memory runtime readout.
 *
 * Split into focused sub-components:
 *  - LlmTelemetrySection: token/cache rollup + sparkline
 *  - MemorySection: episodic/semantic/procedural counts + metric bars
 *  - ModelSwitcher: Ollama model list with filter + click-to-switch
 *  - ToolReliabilitySection: per-tool reliability table with export
 *  - Histogram: 14-day tool activity bar chart
 *
 * This file is the layout orchestrator — owns the data hooks and
 * distributes slices to each sub-component.
 */

import { useMemo, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, EmptyState, StatBlock,
  PageLead, Toolbar, ToolbarButton, Row, Chip,
} from '../_shared';
import { useView } from '../../store/view';
import { ACTIVITY_TONE } from '../WorldPage/types';
import { askSunny } from '../../lib/askSunny';
import {
  getBuckets, getLlmRecent, getLlmStats, getMemoryStats, getStatsSinceSecs,
  getWorld, listOllamaModels,
} from './api';
import { usePoll } from '../_shared';
import { Histogram } from './Histogram';
import { LlmTelemetrySection } from './LlmTelemetrySection';
import { MemorySection } from './MemorySection';
import { ModelSwitcher } from './ModelSwitcher';
import { ToolReliabilitySection } from './ToolReliabilitySection';
import { BrainHealth, type HealthInputs } from './BrainHealth';

function rateTone(ratePct: number): 'green' | 'amber' | 'red' {
  if (ratePct >= 90) return 'green';
  if (ratePct >= 70) return 'amber';
  return 'red';
}

export function BrainPage() {
  const provider      = useView(s => s.settings.provider);
  const model         = useView(s => s.settings.model);
  const temperature   = useView(s => s.settings.temperature);
  const maxTokens     = useView(s => s.settings.maxTokens);
  const contextBudget = useView(s => s.settings.contextBudget);
  const patchSettings = useView(s => s.patchSettings);

  const [sinceHours, setSinceHours] = useState(7 * 24);

  const { data: stats, reload: reloadStats } = usePoll(
    () => getStatsSinceSecs(sinceHours * 3600), 30_000, [sinceHours],
  );
  const { data: buckets, loading: bucketsLoading } = usePoll(() => getBuckets(14), 60_000);
  const { data: mem,    error: memError }           = usePoll(getMemoryStats, 30_000);
  const { data: world }                             = usePoll(getWorld, 4000);
  const { data: ollamaModels, loading: ollamaLoading } = usePoll(listOllamaModels, 120_000);
  const { data: llmStats }  = usePoll(getLlmStats, 10_000);
  const { data: llmRecent } = usePoll(() => getLlmRecent(20), 10_000);

  const sortedStats = useMemo(
    () => (stats ?? []).slice().sort((a, b) => b.count - a.count),
    [stats],
  );

  const totals = useMemo(
    () => sortedStats.reduce(
      (acc, s) => ({ count: acc.count + s.count, ok: acc.ok + s.ok_count, err: acc.err + s.err_count }),
      { count: 0, ok: 0, err: 0 },
    ),
    [sortedStats],
  );
  const totalRate = totals.count > 0 ? (totals.ok / totals.count) * 100 : 0;
  const totalTone = rateTone(totalRate);

  const handleResetStats = () => { setSinceHours(1); void reloadStats(); };
  const handleModelSwitch = (m: string) => { patchSettings({ model: m }); };

  return (
    <ModuleView title="BRAIN · RUNTIME">
      <PageGrid>
        {/* Row 1: Provider stats + time window picker */}
        <PageCell span={12}>
          <PageLead>
            Provider and sampling settings, memory footprint, tool histograms, per-tool reliability, and local Ollama models.
          </PageLead>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <StatBlock label="PROVIDER" value={provider.toUpperCase()} sub={model || 'no model set'} tone="cyan" />
            <StatBlock label="TEMPERATURE" value={temperature.toFixed(2)} sub={`max ${maxTokens}t`} tone="amber" />
            <StatBlock label="CONTEXT" value={`${(contextBudget / 1000).toFixed(0)}k`} sub="budget" tone="violet" />
            <StatBlock
              label="SUCCESS"
              value={totals.count > 0 ? `${totalRate.toFixed(0)}%` : '—'}
              sub={totals.count > 0 ? `${totals.count} calls / ${sinceHours >= 168 ? '7d' : `${sinceHours}h`}` : 'no calls in window'}
              tone={totalTone}
            />
          </div>

          {/* Brain Health gauge */}
          <BrainHealth inputs={{
            toolSuccessRate: totalRate,
            cacheHitRate: llmStats?.cache_hit_rate ?? -1,
            memoryRows: mem ? mem.episodic_count + mem.semantic_count + mem.procedural_count : 0,
            modelActive: !!model,
            worldOnline: !!world,
          } satisfies HealthInputs} />

          <Toolbar style={{ flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span style={{
              fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em', color: 'var(--ink-2)', fontWeight: 700,
            }}>TOOL STATS WINDOW</span>
            {[
              { h: 1, label: '1H' },
              { h: 24, label: '24H' },
              { h: 168, label: '7D' },
            ].map(({ h, label }) => (
              <ToolbarButton
                key={label}
                tone="cyan"
                active={sinceHours === h}
                title={`Show tool reliability for the last ${label.toLowerCase()}`}
                onClick={() => { setSinceHours(h); void reloadStats(); }}
              >
                {label}
              </ToolbarButton>
            ))}
            <ToolbarButton
              tone="green"
              title="Ask Sunny to analyze the runtime health"
              onClick={() => {
                const summary = [
                  `Provider: ${provider}, Model: ${model}`,
                  `Temperature: ${temperature}, Max tokens: ${maxTokens}`,
                  `Tool success rate: ${totalRate.toFixed(1)}% (${totals.count} calls in ${sinceHours >= 168 ? '7d' : `${sinceHours}h`})`,
                  `Memory: ${mem ? `${mem.episodic_count} episodic, ${mem.semantic_count} semantic, ${mem.procedural_count} procedural` : 'unavailable'}`,
                  `LLM cache hit rate: ${llmStats ? `${llmStats.cache_hit_rate.toFixed(1)}%` : 'unavailable'}`,
                ].join('\n');
                askSunny(
                  `Here's my current brain runtime state:\n\n${summary}\n\nHow healthy is the runtime? Any recommendations for tuning?`,
                  'brain',
                );
              }}
            >
              ✦ ANALYZE HEALTH
            </ToolbarButton>
          </Toolbar>
        </PageCell>

        {/* Row 2: LLM Telemetry */}
        <PageCell span={12}>
          <LlmTelemetrySection llmStats={llmStats ?? null} llmRecent={llmRecent ?? null} />
        </PageCell>

        {/* Row 3: Memory (6) | Histogram + World (6) */}
        <PageCell span={6}>
          <MemorySection mem={mem ?? null} memError={memError ?? undefined} />

          <Section title="WORLD MODEL" right={world ? `rev #${world.revision}` : 'offline'}>
            {world ? (
              <>
                <Row label="activity" value={<Chip tone={ACTIVITY_TONE[world.activity]}>{world.activity}</Chip>} />
                <Row
                  label="focus"
                  value={world.focus?.app_name ?? '—'}
                  right={world.focus ? `${world.focused_duration_secs}s` : undefined}
                />
                <Row
                  label="events today"
                  value={String(world.events_today)}
                  right={
                    world.next_event
                      ? new Date(world.next_event.start_iso).toLocaleTimeString(
                          undefined, { hour: '2-digit', minute: '2-digit' },
                        )
                      : '—'
                  }
                />
              </>
            ) : (
              <EmptyState title="World model offline" hint="World updater has not produced a snapshot yet." />
            )}
          </Section>
        </PageCell>

        <PageCell span={6}>
          <Section title="TOOL ACTIVITY · 14D" right="histogram by day">
            {bucketsLoading && (!buckets || buckets.length === 0) ? (
              <EmptyState title="Loading histogram…" />
            ) : (
              <Histogram buckets={buckets ?? []} />
            )}
          </Section>

          <ModelSwitcher
            ollamaModels={ollamaModels ?? null}
            ollamaLoading={ollamaLoading}
            activeModel={model}
            onSwitch={handleModelSwitch}
          />
        </PageCell>

        {/* Row 4: Tool Reliability (full width) */}
        <PageCell span={12}>
          <ToolReliabilitySection
            sortedStats={sortedStats}
            sinceHours={sinceHours}
            buckets={buckets ?? null}
            onRestore7d={() => { setSinceHours(7 * 24); void reloadStats(); }}
            onResetStats={handleResetStats}
          />
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
