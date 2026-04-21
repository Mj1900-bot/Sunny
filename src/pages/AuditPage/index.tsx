/**
 * AUDIT — privacy & tool-usage audit surface.
 *
 * R12-J / Cyber-Premium additions:
 *  - Interactive expandable telemetry rows.
 *  - MetricBar integration for grouped tool views.
 *  - "Error Diagnostics" profile module for aggregating common failures.
 *  - Split-layout Command Center (Span 7 / Span 5).
 */

import { useMemo, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, EmptyState, StatBlock, ScrollList, Chip,
  Toolbar, ToolbarButton, TabBar, PageLead, FilterInput, useFlashMessage, usePoll, relTime,
  Card, MetricBar, Row,
} from '../_shared';
import {
  auditTimelineCsv, auditTimelineNdjson, downloadTextFile,
  toolStatsTsv,
} from '../_shared/snapshots';
import { copyToClipboard } from '../../lib/clipboard';
import { useView } from '../../store/view';
import { DANGEROUS_TOOLS, recent, stats } from './api';
import { getBuckets } from '../BrainPage/api';
import type { DailyBucket } from '../BrainPage/api';

type Tab = 'all' | 'dangerous' | 'errors';

// ---------------------------------------------------------------------------
// DayChart — smaller inline day-distribution histogram
// ---------------------------------------------------------------------------

function DayChart({ buckets }: { buckets: ReadonlyArray<DailyBucket> }) {
  if (buckets.length === 0) return <div style={{ height: 32, opacity: 0.3 }} />;
  const max = Math.max(...buckets.map(b => b.count), 1);
  return (
    <div
      title="Tool calls per day (14d)"
      style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 32 }}
    >
      {buckets.map(b => {
        const h = Math.max(2, (b.count / max) * 28);
        const rate = b.count > 0 ? b.ok_count / b.count : 0;
        const tone = rate >= 0.9 ? 'var(--green)' : rate >= 0.7 ? 'var(--amber)' : 'var(--red)';
        const day = new Date(b.day_ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return (
          <div
            key={b.day_ts}
            title={`${day}: ${b.count} calls · ${b.ok_count} ok`}
            style={{
              flex: 1, height: h,
              background: tone,
              opacity: 0.7,
            }}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

type GroupedEntry = {
  tool_name: string;
  total: number;
  errors: number;
  dangerous: boolean;
  successRate: number;
};

export function AuditPage() {
  const auditOnlyErrors = useView(s => s.settings.auditOnlyErrors);
  const liveRefresh = useView(s => s.settings.liveRefresh);
  const toggleLiveRefresh = useView(s => s.patchSettings);

  const [tab, setTab] = useState<Tab>(() => (auditOnlyErrors ? 'errors' : 'all'));
  const [filter, setFilter] = useState('');
  const [grouped, setGrouped] = useState(false);
  const [maxSuccessRate, setMaxSuccessRate] = useState(100);
  const [expandedEventId, setExpandedEventId] = useState<number | null>(null);

  const { message: actionHint, flash } = useFlashMessage();

  const { data: rows,    reload: reloadRows    } = usePoll(() => recent(400, false), 20_000);
  const { data: aggr,    reload: reloadAggr    } = usePoll(() => stats(7), 60_000);
  const { data: buckets, reload: reloadBuckets } = usePoll(() => getBuckets(14), 60_000);

  const refreshAll = () => {
    reloadRows();
    reloadAggr();
    reloadBuckets();
    flash('Audit data refreshed');
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (rows ?? []).filter(r => {
      if (tab === 'errors' && r.ok) return false;
      if (tab === 'dangerous' && !DANGEROUS_TOOLS.has(r.tool_name)) return false;
      if (q && !r.tool_name.toLowerCase().includes(q) &&
          !(r.error_msg ?? '').toLowerCase().includes(q) &&
          !(r.reason ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, tab, filter]);

  // Grouped view — collapse filtered rows by tool name.
  const groupedEntries = useMemo<GroupedEntry[]>(() => {
    const map = new Map<string, GroupedEntry>();
    for (const r of filtered) {
      const existing = map.get(r.tool_name);
      if (existing) {
        map.set(r.tool_name, {
          ...existing,
          total: existing.total + 1,
          errors: existing.errors + (r.ok ? 0 : 1),
          successRate: 0,
        });
      } else {
        map.set(r.tool_name, {
          tool_name: r.tool_name,
          total: 1,
          errors: r.ok ? 0 : 1,
          dangerous: DANGEROUS_TOOLS.has(r.tool_name),
          successRate: 0,
        });
      }
    }
    // Calculate rate and apply threshold filter.
    return Array.from(map.values())
      .map(e => ({
        ...e,
        successRate: e.total > 0 ? ((e.total - e.errors) / e.total) * 100 : 100,
      }))
      .filter(e => e.successRate <= maxSuccessRate)
      .sort((a, b) => b.total - a.total);
  }, [filtered, maxSuccessRate]);

  // Error Diagnostics — compute the most common fail strings across ALL loaded rows
  const errorBreakdown = useMemo(() => {
    const map = new Map<string, { count: number; tools: Set<string> }>();
    for (const r of (rows ?? [])) {
      if (r.ok || !r.error_msg) continue;
      const msg = r.error_msg.trim();
      const existing = map.get(msg);
      if (existing) {
        existing.count++;
        existing.tools.add(r.tool_name);
      } else {
        map.set(msg, { count: 1, tools: new Set([r.tool_name]) });
      }
    }
    return Array.from(map.entries())
      .map(([msg, entry]) => ({ msg, count: entry.count, tools: Array.from(entry.tools) }))
      .sort((a, b) => b.count - a.count);
  }, [rows]);

  const counts = {
    all:       (rows ?? []).length,
    errors:    (rows ?? []).filter(r => !r.ok).length,
    dangerous: (rows ?? []).filter(r => DANGEROUS_TOOLS.has(r.tool_name)).length,
  };

  const uniqueTools = new Set((rows ?? []).map(r => r.tool_name)).size;
  const filteredTotalCalls = groupedEntries.reduce((sum, e) => sum + e.total, 0) || 1;

  return (
    <ModuleView title="AUDIT · COMMAND CENTER">
      <PageGrid>
        <PageCell span={12}>
          <PageLead>
            Privacy and reliability surface: recent telemetry, dangerous operations, errors, and live insights.
          </PageLead>
          <Toolbar>
            <TabBar<Tab>
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'all',       label: 'ALL',       count: counts.all },
                { id: 'errors',    label: 'ERRORS',    count: counts.errors },
                { id: 'dangerous', label: 'DANGEROUS', count: counts.dangerous },
              ]}
            />
            <FilterInput
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter by tool or error pattern…"
              aria-label="Filter audit events"
              spellCheck={false}
              style={{ marginLeft: 12, minWidth: 200 }}
            />
            <ToolbarButton active={grouped} tone="violet" onClick={() => setGrouped(g => !g)}>
              GROUP BY TOOL
            </ToolbarButton>
            <ToolbarButton 
              tone={liveRefresh ? 'green' : 'amber'} 
              active={liveRefresh} 
              onClick={() => toggleLiveRefresh({ liveRefresh: !liveRefresh })}
              title="Toggle automatic background data polling (20s)"
            >
              {liveRefresh ? 'LIVE' : 'PAUSED'}
            </ToolbarButton>
            <ToolbarButton onClick={refreshAll} title="Force-reload timeline & aggregates">
              SYNC
            </ToolbarButton>
            <div style={{ flex: 1 }} />
            {actionHint && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)', marginRight: 8 }}>
                {actionHint}
              </span>
            )}
            <ToolbarButton
              tone="violet"
              title="Download visible timeline as CSV"
              onClick={() => {
                downloadTextFile(`sunny-audit-${Date.now()}.csv`, auditTimelineCsv(filtered), 'text/csv;charset=utf-8');
                flash('CSV EXPORTED');
              }}
            >
              CSV
            </ToolbarButton>
            <ToolbarButton
              tone="cyan"
              title="Download visible timeline as newline-delimited JSON"
              onClick={() => {
                downloadTextFile(`sunny-audit-${Date.now()}.ndjson`, auditTimelineNdjson(filtered), 'application/x-ndjson');
                flash('NDJSON EXPORTED');
              }}
            >
              NDJSON
            </ToolbarButton>
          </Toolbar>

          {grouped && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, marginTop: 4,
              padding: '6px 12px', border: '1px solid var(--line-soft)',
              background: 'rgba(6, 14, 22, 0.45)',
            }}>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.2em',
                color: 'var(--ink-2)', fontWeight: 700, flexShrink: 0,
              }}>SHOW TOOLS WITH SUCCESS RATE ≤</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={maxSuccessRate}
                onChange={e => setMaxSuccessRate(Number(e.target.value))}
                style={{ flex: 1, accentColor: 'var(--cyan)' }}
              />
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--cyan)', minWidth: 36, textAlign: 'right',
              }}>{maxSuccessRate}%</span>
            </div>
          )}
        </PageCell>

        {/* LEFT COLUMN: LIVE TELEMETRY */}
        <PageCell span={7}>
          <Section
            title={grouped ? 'GROUPED BY TOOL' : 'TELEMETRY STREAM'}
            right={grouped ? `${groupedEntries.length} tools` : `${filtered.length} events`}
          >
            {grouped ? (
              groupedEntries.length === 0 ? (
                <EmptyState title="No tools match filter/threshold" icon="🔍" />
              ) : (
                <ScrollList maxHeight={620}>
                  {groupedEntries.map(e => {
                    const rate = Math.round(e.successRate);
                    const tone = rate >= 95 ? 'green' : rate >= 80 ? 'amber' : 'red';
                    const pctVol = (e.total / filteredTotalCalls) * 100;
                    return (
                      <Card key={e.tool_name} accent={tone} style={{ padding: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          {e.dangerous && <Chip tone="amber">DANGER</Chip>}
                          <button
                            type="button"
                            title="Filter timeline to this tool"
                            onClick={() => { setFilter(e.tool_name); setGrouped(false); }}
                            style={{
                              all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0,
                              fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--cyan)',
                              textDecoration: 'underline dotted', fontWeight: 600,
                            }}
                          >
                            {e.tool_name}
                          </button>
                          <Chip tone={tone}>{rate}% OK</Chip>
                        </div>
                        <MetricBar 
                          label={`VOLUME (${e.total} call${e.total === 1 ? '' : 's'}) — ${e.errors} err`} 
                          pct={pctVol} 
                          tone="cyan" 
                        />
                      </Card>
                    );
                  })}
                </ScrollList>
              )
            ) : (
              filtered.length === 0 ? (
                <EmptyState title="No audit rows match the current filter" icon="📂" />
              ) : (
                <ScrollList maxHeight={620}>
                  {filtered.slice(0, 150).map(r => {
                    const isExpanded = expandedEventId === r.id;
                    const tone = r.ok ? 'green' : 'red';
                    return (
                      <Card 
                        key={r.id} 
                        accent={tone}
                        interactive
                        onClick={() => setExpandedEventId(isExpanded ? null : r.id)}
                        style={{ padding: '8px 10px', gap: 6, display: 'flex', flexDirection: 'column' }}
                      >
                         <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                           <Chip tone={tone}>{r.ok ? 'OK' : 'ERR'}</Chip>
                           {DANGEROUS_TOOLS.has(r.tool_name) && <Chip tone="amber">DNG</Chip>}
                           <span style={{
                             fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)', minWidth: 120,
                             fontWeight: 600,
                           }}>
                             {r.tool_name}
                           </span>

                           {r.error_msg ? (
                             <span style={{
                               flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                               fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
                             }}>{r.error_msg}</span>
                           ) : r.reason ? (
                             <span style={{
                               flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                               fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)', fontStyle: 'italic',
                             }}>{r.reason}</span>
                           ) : (
                             <span style={{ flex: 1 }} />
                           )}

                           <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)', minWidth: 40, textAlign: 'right' }}>
                             {r.latency_ms}ms
                           </span>
                           <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', minWidth: 50, textAlign: 'right' }}>
                             {relTime(r.created_at)}
                           </span>
                         </div>
                         
                         {isExpanded && (
                           <div style={{ 
                             marginTop: 6, paddingTop: 8, 
                             borderTop: '1px dashed var(--line-soft)', 
                             display: 'flex', flexDirection: 'column', gap: 8 
                           }} onClick={(e) => e.stopPropagation()}>
                             {r.reason && (
                               <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                 <span style={{ fontFamily: 'var(--display)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.1em' }}>REASONING</span>
                                 <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
                                   {r.reason}
                                 </span>
                               </div>
                             )}
                             {r.error_msg && (
                               <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                 <span style={{ fontFamily: 'var(--display)', fontSize: 9, color: 'var(--red)', letterSpacing: '0.1em' }}>ERROR TRACE</span>
                                 <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--red)', lineHeight: 1.4, background: 'rgba(255,50,50,0.05)', padding: '6px', borderRadius: 4 }}>
                                   {r.error_msg}
                                 </span>
                               </div>
                             )}
                             <Toolbar>
                               <ToolbarButton tone="violet" onClick={() => {
                                 copyToClipboard(JSON.stringify(r, null, 2));
                                 flash('Copied full JSON payload');
                               }}>COPY JSON</ToolbarButton>
                               <ToolbarButton tone="cyan" onClick={() => {
                                  setFilter(r.tool_name);
                                  setGrouped(false);
                                  flash(`Filtered to ${r.tool_name}`);
                               }}>FILTER TO THIS TOOL</ToolbarButton>
                             </Toolbar>
                           </div>
                         )}
                      </Card>
                    );
                  })}
                </ScrollList>
              )
            )}
          </Section>
        </PageCell>

        {/* RIGHT COLUMN: INSIGHTS & STATS */}
        <PageCell span={5}>
          {/* Top Overall Stats Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
            <StatBlock label="TOTAL EVENTS"  value={String(counts.all)}       tone="cyan" />
            <StatBlock label="GLOBAL ERRORS" value={String(counts.errors)}    tone={counts.errors > 0 ? 'red' : 'green'} />
            <StatBlock label="UNIQUE TOOLS"  value={String(uniqueTools)}      tone="violet" />
            <StatBlock
              label="SUCCESS RATE"
              value={counts.all > 0 ? `${Math.round(((counts.all - counts.errors) / counts.all) * 100)}%` : '—'}
              tone={(counts.errors / Math.max(1, counts.all)) < 0.05 ? 'green' : 'red'}
            />
          </div>

          {buckets && buckets.length > 0 && (
            <Section title="CALL VOLUME · 14D" right={`${buckets.reduce((s, b) => s + b.count, 0)} total`} style={{ marginTop: 8 }}>
              <div style={{ padding: '0px 4px 6px', borderBottom: '1px solid var(--line-soft)' }}>
                <DayChart buckets={buckets} />
              </div>
            </Section>
          )}

          {errorBreakdown.length > 0 && (
            <Section title="ERROR DIAGNOSTICS" right={`${errorBreakdown.length} unique`} style={{ marginTop: 8 }}>
              <ScrollList maxHeight={200}>
                {errorBreakdown.slice(0, 10).map((err, i) => (
                  <Row 
                    key={i} 
                    tone="red"
                    label={
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span>{err.count} strikes</span>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {err.tools.slice(0, 2).map(t => <Chip key={t} tone="amber" style={{ fontSize: 8 }}>{t}</Chip>)}
                          {err.tools.length > 2 && <span style={{ color: 'var(--ink-dim)' }}>+{err.tools.length - 2}</span>}
                        </div>
                      </div>
                    }
                    value={err.msg} 
                    title={err.msg}
                  />
                ))}
              </ScrollList>
            </Section>
          )}

          <Section
            title="7-DAY RELIABILITY"
            right={
              <>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{(aggr ?? []).length} items</span>
                <ToolbarButton
                  tone="violet"
                  disabled={!(aggr && aggr.length)}
                  title="Copy reliability table (TSV)"
                  onClick={() => { copyToClipboard(toolStatsTsv(aggr ?? [])); flash('COPIED TSV'); }}
                >
                  COPY
                </ToolbarButton>
              </>
            }
            style={{ marginTop: 8 }}
          >
            <ScrollList maxHeight={280}>
              {(aggr ?? []).slice()
                .sort((a, b) => (a.success_rate < 0 ? 0 : a.success_rate) - (b.success_rate < 0 ? 0 : b.success_rate))
                .map(s => {
                  const rate = s.success_rate < 0 ? 0 : Math.round(s.success_rate * 100);
                  const tone = rate >= 95 ? 'green' : rate >= 80 ? 'amber' : 'red';
                  return (
                    <Row 
                      key={s.tool_name}
                      tone={tone}
                      label={<Chip tone={tone}>{rate}% OK</Chip>}
                      value={s.tool_name}
                      right={`${s.count} · p95 ${s.latency_p95_ms}ms`}
                    />
                  );
                })}
            </ScrollList>
          </Section>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}

