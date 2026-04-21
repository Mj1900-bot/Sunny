/** p50/p95 latency table per model from perf_profile_snapshot. */
import { Section, EmptyState, Row } from '../_shared';
import type { PerfSnapshot } from './types';

type Props = {
  readonly snapshot: PerfSnapshot | null;
  readonly loading:  boolean;
};

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

export function LatencyTable({ snapshot, loading }: Props) {
  const rows = snapshot?.rows ?? [];

  return (
    <Section title="LATENCY · p50 / p95" right="per model">
      {loading && rows.length === 0 ? (
        <EmptyState title="Loading latency data…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No latency data"
          hint="perf_profile_snapshot not available yet — install the I6 module."
        />
      ) : (
        <div>
          {/* Header */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 80px 80px 60px',
            padding: '3px 8px',
            fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.2em',
            color: 'var(--ink-dim)',
          }}>
            <span>MODEL</span>
            <span style={{ textAlign: 'right' }}>P50</span>
            <span style={{ textAlign: 'right' }}>P95</span>
            <span style={{ textAlign: 'right' }}>N</span>
          </div>
          {rows.map(r => (
            <Row
              key={r.model}
              label={r.model}
              value={
                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--cyan)', minWidth: 52, textAlign: 'right' }}>
                    {fmtMs(r.p50_ms)}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', minWidth: 52, textAlign: 'right' }}>
                    {fmtMs(r.p95_ms)}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', minWidth: 38, textAlign: 'right' }}>
                    {r.sample_n}
                  </span>
                </div>
              }
            />
          ))}
        </div>
      )}
    </Section>
  );
}
