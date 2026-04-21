/**
 * LlmTelemetrySection — LLM token/cache telemetry rollup with sparkline
 * and recent turns log.
 *
 * Upgraded with:
 *  - Recent turns mini table (last 5 turns with model, tokens, latency)
 *  - Token I/O ratio indicator
 *  - Cache efficiency visual bar
 *  - Better visual hierarchy
 */

import { useMemo } from 'react';
import {
  Section, StatBlock, Row, Sparkline, Chip, ScrollList,
  ToolbarButton, useFlashMessage,
} from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import type { LlmStats, TelemetryEvent } from './api';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function LlmTelemetrySection({
  llmStats,
  llmRecent,
}: {
  llmStats: LlmStats | null;
  llmRecent: ReadonlyArray<TelemetryEvent> | null;
}) {
  const { message: copyHint, flash } = useFlashMessage();

  const llmHitSeries = useMemo<number[]>(() => {
    if (!llmRecent || llmRecent.length === 0) return [];
    return llmRecent
      .slice()
      .reverse()
      .map(ev => {
        const denom = ev.input + ev.cache_read + ev.cache_create;
        return denom > 0 ? (ev.cache_read / denom) * 100 : 0;
      });
  }, [llmRecent]);

  // Latency series for sparkline
  const latencySeries = useMemo<number[]>(() => {
    if (!llmRecent || llmRecent.length === 0) return [];
    return llmRecent.slice().reverse().map(ev => ev.duration_ms);
  }, [llmRecent]);

  // Last 5 turns for the mini table
  const recentTurns = useMemo(() => {
    if (!llmRecent) return [];
    return llmRecent.slice(0, 5);
  }, [llmRecent]);

  const cacheHitPct = llmStats && llmStats.turns_count > 0 ? llmStats.cache_hit_rate : 0;

  return (
    <Section
      title="LLM TELEMETRY · LIVE"
      right={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
            {llmStats ? `${llmStats.turns_count} turn${llmStats.turns_count === 1 ? '' : 's'} tracked` : '—'}
          </span>
          {llmStats && (
            <ToolbarButton
              tone="violet"
              title="Copy aggregate telemetry JSON"
              onClick={async () => {
                const ok = await copyToClipboard(JSON.stringify(llmStats, null, 2));
                flash(ok ? 'LLM stats JSON copied' : 'Copy failed');
              }}
            >
              COPY JSON
            </ToolbarButton>
          )}
          {copyHint && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
          )}
        </span>
      }
    >
      {/* Stat cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 8, marginBottom: 10,
      }}>
        <StatBlock
          label="TOTAL TURNS"
          value={llmStats ? llmStats.turns_count.toLocaleString() : '—'}
          sub="rolling ring · cap 500"
          tone="cyan"
        />
        <StatBlock
          label="CACHE HIT"
          value={llmStats && llmStats.turns_count > 0 ? `${cacheHitPct.toFixed(1)}%` : '—'}
          sub={llmStats ? `save ~${llmStats.cache_savings_pct.toFixed(1)}%` : 'no turns yet'}
          tone={cacheHitPct >= 60 ? 'green' : cacheHitPct >= 30 ? 'amber' : 'red'}
        />
        <StatBlock
          label="INPUT"
          value={llmStats ? formatTokens(llmStats.total_input_tokens) : '—'}
          sub="tokens consumed"
          tone="violet"
        />
        <StatBlock
          label="OUTPUT"
          value={llmStats ? formatTokens(llmStats.total_output_tokens) : '—'}
          sub="tokens generated"
          tone="amber"
        />
        <StatBlock
          label="I/O RATIO"
          value={llmStats && llmStats.total_output_tokens > 0
            ? `${(llmStats.total_input_tokens / llmStats.total_output_tokens).toFixed(1)}:1`
            : '—'}
          sub="input per output"
          tone="cyan"
        />
      </div>

      {/* Cache efficiency bar */}
      {llmStats && llmStats.turns_count > 0 && (
        <div style={{
          padding: '8px 10px', marginBottom: 8,
          border: '1px solid var(--line-soft)',
          background: 'rgba(0, 0, 0, 0.2)',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 4,
          }}>
            <span style={{
              fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
              color: 'var(--ink-2)', fontWeight: 700,
            }}>CACHE EFFICIENCY</span>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10,
              color: cacheHitPct >= 60 ? 'var(--green)' : cacheHitPct >= 30 ? 'var(--amber)' : 'var(--red)',
            }}>
              {cacheHitPct.toFixed(1)}% hit · {llmStats.cache_savings_pct.toFixed(1)}% savings
            </span>
          </div>
          <div style={{
            height: 6, background: 'rgba(255,255,255,0.04)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${Math.min(100, cacheHitPct)}%`,
              background: cacheHitPct >= 60
                ? 'linear-gradient(90deg, var(--green), var(--cyan))'
                : cacheHitPct >= 30
                  ? 'linear-gradient(90deg, var(--amber), var(--gold))'
                  : 'linear-gradient(90deg, var(--red), var(--amber))',
              boxShadow: `0 0 8px ${cacheHitPct >= 60 ? 'var(--green)' : 'var(--amber)'}44`,
              transition: 'width 500ms ease',
            }} />
          </div>
        </div>
      )}

      {/* Sparkline rows */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Row
          label="cache hit % · last 20"
          value={
            llmHitSeries.length >= 2
              ? <Sparkline values={llmHitSeries} width={120} height={24} tone="cyan" filled />
              : <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>collecting…</span>
          }
          right={
            llmHitSeries.length > 0
              ? `${llmHitSeries[llmHitSeries.length - 1].toFixed(0)}% latest`
              : undefined
          }
        />
        <Row
          label="latency · last 20"
          value={
            latencySeries.length >= 2
              ? <Sparkline values={latencySeries} width={120} height={24} tone="amber" filled />
              : <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>collecting…</span>
          }
          right={
            latencySeries.length > 0
              ? formatDuration(latencySeries[latencySeries.length - 1])
              : undefined
          }
        />
      </div>

      {/* Recent turns mini table */}
      {recentTurns.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
            color: 'var(--ink-2)', fontWeight: 700, marginBottom: 4,
          }}>RECENT TURNS</div>
          <ScrollList maxHeight={130}>
            {recentTurns.map((ev, i) => {
              const total = ev.input + ev.cache_read + ev.cache_create;
              const hitPct = total > 0 ? (ev.cache_read / total) * 100 : 0;
              return (
                <div
                  key={i}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 60px 60px 54px 44px',
                    gap: 6, alignItems: 'center',
                    padding: '4px 8px',
                    borderBottom: '1px dashed var(--line-soft)',
                    fontSize: 10, fontFamily: 'var(--mono)',
                    animation: `fadeSlideIn 150ms ease ${i * 40}ms both`,
                  }}
                >
                  <span style={{
                    color: 'var(--ink)', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{ev.model}</span>
                  <span style={{ color: 'var(--violet)' }}>
                    {formatTokens(ev.input)} in
                  </span>
                  <span style={{ color: 'var(--amber)' }}>
                    {formatTokens(ev.output)} out
                  </span>
                  <span style={{ color: 'var(--ink-dim)' }}>
                    {formatDuration(ev.duration_ms)}
                  </span>
                  <Chip tone={hitPct >= 50 ? 'green' : hitPct > 0 ? 'amber' : 'dim'}>
                    {hitPct.toFixed(0)}%
                  </Chip>
                </div>
              );
            })}
          </ScrollList>
        </div>
      )}
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(3px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Section>
  );
}
