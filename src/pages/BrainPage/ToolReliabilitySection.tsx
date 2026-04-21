/**
 * ToolReliabilitySection — per-tool reliability table with filter,
 * sparklines, and CSV/JSON export. Extracted from BrainPage monolith.
 */

import { useMemo, useState } from 'react';
import {
  Section, EmptyState, MetricBar, Chip, ScrollList,
  Toolbar, ToolbarButton, FilterInput,
  useDebounced, useFlashMessage, relTime,
} from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import { downloadTextFile, toolStatsCsv, toolStatsJson } from '../_shared/snapshots';
import { ToolSparkline } from './ToolSparkline';
import type { ToolStats, DailyBucket } from './api';

function rateTone(ratePct: number): 'green' | 'amber' | 'red' {
  if (ratePct >= 90) return 'green';
  if (ratePct >= 70) return 'amber';
  return 'red';
}

export function ToolReliabilitySection({
  sortedStats,
  sinceHours,
  buckets,
  onRestore7d,
  onResetStats,
}: {
  sortedStats: ReadonlyArray<ToolStats>;
  sinceHours: number;
  buckets: ReadonlyArray<DailyBucket> | null;
  onRestore7d: () => void;
  onResetStats: () => void;
}) {
  const [toolQuery, setToolQuery] = useState('');
  const dq = useDebounced(toolQuery, 200);
  const { message: copyHint, flash } = useFlashMessage();

  const filteredToolStats = useMemo(() => {
    const q = dq.trim().toLowerCase();
    if (!q) return sortedStats;
    return sortedStats.filter(s => s.tool_name.toLowerCase().includes(q));
  }, [sortedStats, dq]);

  const totals = useMemo(
    () => sortedStats.reduce(
      (acc, s) => ({ count: acc.count + s.count, ok: acc.ok + s.ok_count, err: acc.err + s.err_count }),
      { count: 0, ok: 0, err: 0 },
    ),
    [sortedStats],
  );

  // Build per-tool sparkline points from the 14d daily buckets.
  const toolSparklines = useMemo<Map<string, number[]>>(() => {
    const m = new Map<string, number[]>();
    if (!buckets || buckets.length === 0 || sortedStats.length === 0) return m;
    const maxDayCount = Math.max(...buckets.map(b => b.count), 1);
    for (const s of sortedStats) {
      const share = totals.count > 0 ? s.count / totals.count : 0;
      const pts = buckets.map(b => Math.min(1, (b.count * share) / maxDayCount));
      m.set(s.tool_name, pts);
    }
    return m;
  }, [buckets, sortedStats, totals]);

  const label = sinceHours >= 168 ? '7D' : `${sinceHours}H`;

  return (
    <Section
      title={`PER-TOOL RELIABILITY · ${label}`}
      right={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{filteredToolStats.length}{filteredToolStats.length !== sortedStats.length ? ` / ${sortedStats.length}` : ''} tools</span>
          {sinceHours < 168 && (
            <ToolbarButton tone="amber" onClick={onRestore7d}>
              RESTORE 7D
            </ToolbarButton>
          )}
          <ToolbarButton tone="red" onClick={onResetStats} title="Dev: filter view to last 1h to clear noise">
            RESET STATS
          </ToolbarButton>
        </span>
      }
    >
      <Toolbar style={{ marginBottom: 4 }}>
        <FilterInput
          value={toolQuery}
          onChange={e => setToolQuery(e.target.value)}
          placeholder="Filter tools by name…"
          aria-label="Filter tools"
          spellCheck={false}
        />
        <ToolbarButton
          tone="violet"
          disabled={filteredToolStats.length === 0}
          title="Copy visible rows as CSV"
          onClick={async () => {
            const ok = await copyToClipboard(toolStatsCsv(filteredToolStats));
            flash(ok ? 'Tool table copied (CSV)' : 'Copy failed');
          }}
        >
          COPY CSV
        </ToolbarButton>
        <ToolbarButton
          tone="cyan"
          disabled={filteredToolStats.length === 0}
          title="Download visible rows as JSON"
          onClick={() => {
            downloadTextFile(
              `sunny-tool-stats-${sinceHours}h-${Date.now()}.json`,
              toolStatsJson(filteredToolStats),
              'application/json',
            );
            flash('JSON export started');
          }}
        >
          EXPORT JSON
        </ToolbarButton>
        {copyHint && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
        )}
      </Toolbar>

      {sortedStats.length === 0 ? (
        <EmptyState
          title="No tool usage"
          hint="Sunny hasn't called any tools in the window, or telemetry isn't flowing."
        />
      ) : filteredToolStats.length === 0 ? (
        <EmptyState title="No matching tools" hint="Clear the filter or try a shorter substring." />
      ) : (
        <ScrollList maxHeight={300}>
          {filteredToolStats.slice(0, 40).map(s => {
            const rate = s.success_rate < 0 ? 0 : s.success_rate * 100;
            const tone = rateTone(rate);
            const sparkPts = toolSparklines.get(s.tool_name) ?? [];
            return (
              <div
                key={s.tool_name}
                tabIndex={0}
                aria-label={`${s.tool_name}: ${s.ok_count} of ${s.count} calls ok, p50 ${s.latency_p50_ms}ms, p95 ${s.latency_p95_ms}ms`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1.2fr) 64px minmax(100px, 1fr) 64px 64px 64px 78px 40px',
                  gap: 8, alignItems: 'center',
                  padding: '6px 10px',
                  border: '1px solid var(--line-soft)',
                  borderLeft: `2px solid var(--${tone})`,
                  outlineOffset: 2,
                }}
                onFocus={e => { e.currentTarget.style.outline = '1px solid var(--cyan)'; }}
                onBlur={e => { e.currentTarget.style.outline = 'none'; }}
              >
                <span
                  title={`${s.tool_name}${s.last_at != null ? ` · last use ${relTime(s.last_at)}` : ''}`}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {s.tool_name}
                </span>
                <ToolSparkline points={sparkPts} tone={tone} />
                <MetricBar label="ok" value={`${s.ok_count}/${s.count}`} pct={rate} tone={tone} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)' }}>
                  p50 {s.latency_p50_ms}ms
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)' }}>
                  p95 {s.latency_p95_ms}ms
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
                  {s.count} calls
                </span>
                <Chip tone={s.last_ok === false ? 'red' : tone}>
                  {s.last_ok === false ? 'LAST ERR' : 'OK'}
                </Chip>
                <ToolbarButton
                  tone="violet"
                  title="Copy this row"
                  onClick={async () => {
                    const line = [s.tool_name, s.count, s.ok_count, s.err_count, s.latency_p50_ms, s.latency_p95_ms].join('\t');
                    const ok = await copyToClipboard(line);
                    flash(ok ? 'Row copied' : 'Copy failed');
                  }}
                >
                  ROW
                </ToolbarButton>
              </div>
            );
          })}
        </ScrollList>
      )}
    </Section>
  );
}
