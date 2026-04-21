/**
 * MemorySection — memory footprint with composition ring, store cards,
 * metric bars, and export actions.
 *
 * Upgraded with:
 *  - Memory composition donut (SVG)
 *  - Store-specific capacity thresholds with warnings
 *  - Per-store "records per MB" efficiency stat
 *  - Better visual cards
 */

import { useMemo } from 'react';
import {
  Section, MetricBar, Row, EmptyState, Chip,
  ToolbarButton, useFlashMessage,
} from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import { brainMemoryJson, downloadTextFile } from '../_shared/snapshots';
import type { MemoryStats } from './api';

const STORES = [
  { key: 'episodic'   as const, label: 'EPISODIC',   tone: 'cyan'   as const, cap: 5000, icon: '◈' },
  { key: 'semantic'   as const, label: 'SEMANTIC',    tone: 'violet' as const, cap: 1000, icon: '◇' },
  { key: 'procedural' as const, label: 'PROCEDURAL',  tone: 'green'  as const, cap: 200,  icon: '▸' },
];

function DonutChart({ slices, size = 64 }: { slices: { pct: number; color: string }[]; size?: number }) {
  const r = (size - 8) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={7} />
      {slices.map((s, i) => {
        const seg = (s.pct / 100) * circ;
        const el = (
          <circle
            key={i}
            cx={c} cy={c} r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={7}
            strokeDasharray={`${seg} ${circ - seg}`}
            strokeDashoffset={-offset}
            strokeLinecap="butt"
            style={{ transition: 'stroke-dasharray 500ms ease, stroke-dashoffset 500ms ease' }}
          />
        );
        offset += seg;
        return el;
      })}
    </svg>
  );
}

export function MemorySection({
  mem,
  memError,
}: {
  mem: MemoryStats | null;
  memError: string | undefined;
}) {
  const { message: copyHint, flash } = useFlashMessage();

  const total = mem ? mem.episodic_count + mem.semantic_count + mem.procedural_count : 0;
  const donutSlices = useMemo(() => {
    if (!mem || total === 0) return [];
    return [
      { pct: (mem.episodic_count / total) * 100,   color: 'var(--cyan)'   },
      { pct: (mem.semantic_count / total) * 100,    color: 'var(--violet)' },
      { pct: (mem.procedural_count / total) * 100,  color: 'var(--green)'  },
    ];
  }, [mem, total]);

  const counts: Record<string, number> = mem
    ? { episodic: mem.episodic_count, semantic: mem.semantic_count, procedural: mem.procedural_count }
    : {};

  return (
    <Section
      title="MEMORY FOOTPRINT"
      right={mem ? (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <ToolbarButton
            tone="violet"
            title="Copy memory_stats JSON"
            onClick={async () => {
              const ok = await copyToClipboard(brainMemoryJson(mem));
              flash(ok ? 'Memory stats copied' : 'Copy failed');
            }}
          >
            COPY
          </ToolbarButton>
          <ToolbarButton
            tone="cyan"
            title="Download memory_stats JSON"
            onClick={() => {
              downloadTextFile(`sunny-memory-stats-${Date.now()}.json`, brainMemoryJson(mem), 'application/json');
              flash('Download started');
            }}
          >
            JSON
          </ToolbarButton>
          {copyHint && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
          )}
        </span>
      ) : 'three stores'}
    >
      {memError && !mem ? (
        <EmptyState title="Memory store unreachable" hint={memError} />
      ) : mem ? (
        <>
          {/* Donut + summary */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10,
            padding: '10px 12px',
            border: '1px solid var(--line-soft)',
            background: 'linear-gradient(135deg, rgba(57, 229, 255, 0.04), transparent 60%)',
          }}>
            <DonutChart slices={donutSlices} size={64} />
            <div style={{ flex: 1 }}>
              <div style={{
                fontFamily: 'var(--display)', fontSize: 20, fontWeight: 800,
                color: 'var(--ink)', letterSpacing: '0.04em',
              }}>
                {total.toLocaleString()} <span style={{ fontSize: 11, color: 'var(--ink-dim)', fontWeight: 500 }}>rows total</span>
              </div>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', marginTop: 2,
              }}>
                {(mem.total_bytes / 1_048_576).toFixed(1)} MB on disk
              </div>
              {total > 0 && (
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', marginTop: 2,
                }}>
                  ~{(total / Math.max(0.01, mem.total_bytes / 1_048_576)).toFixed(0)} records/MB
                </div>
              )}
            </div>
          </div>

          {/* Store cards */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 6, marginBottom: 6,
          }}>
            {STORES.map(({ key, label, tone, cap, icon }) => {
              const count = counts[key] ?? 0;
              const pct = Math.min(100, (count / cap) * 100);
              const nearCap = pct >= 80;
              return (
                <div
                  key={key}
                  style={{
                    border: `1px solid ${nearCap ? `var(--${tone})44` : 'var(--line-soft)'}`,
                    borderLeft: `2px solid var(--${tone})`,
                    padding: '8px 10px',
                    display: 'flex', flexDirection: 'column', gap: 3,
                    background: nearCap ? `rgba(57, 229, 255, 0.02)` : 'transparent',
                    transition: 'border-color 200ms ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{
                      fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
                      color: 'var(--ink-2)', fontWeight: 700,
                    }}>{icon} {label}</span>
                    {nearCap && <Chip tone={tone}>NEAR CAP</Chip>}
                  </div>
                  <span style={{
                    fontFamily: 'var(--display)', fontSize: 18, fontWeight: 800,
                    color: `var(--${tone})`, letterSpacing: '0.04em',
                  }}>{count.toLocaleString()}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)' }}>
                    / {cap.toLocaleString()} cap
                  </span>
                </div>
              );
            })}
          </div>

          {/* Metric bars */}
          {STORES.map(({ key, label, tone, cap }) => (
            <MetricBar
              key={key}
              label={label}
              value={String(counts[key] ?? 0)}
              pct={Math.min(100, ((counts[key] ?? 0) / cap) * 100)}
              tone={tone}
            />
          ))}

          <Row
            label="total on disk"
            value={<b>{(mem.total_bytes / 1_048_576).toFixed(1)} MB</b>}
            right={`${total} rows across 3 stores`}
          />
        </>
      ) : (
        <EmptyState title="Reading memory stats…" />
      )}
    </Section>
  );
}
