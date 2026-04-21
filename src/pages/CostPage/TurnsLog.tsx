/** Last-10 turns log: time | model | tokens_in/out | cost | latency */
import { Section, EmptyState, ScrollList } from '../_shared';
import type { TelemetryEvent } from './types';

type Props = {
  readonly events: ReadonlyArray<TelemetryEvent>;
};

function fmtTime(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtUsd(usd: number): string {
  if (usd === 0) return 'free';
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

const COL: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 10,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

export function TurnsLog({ events }: Props) {
  const last10 = events.slice(-10).reverse();

  return (
    <Section title="RECENT TURNS · LAST 10">
      {last10.length === 0 ? (
        <EmptyState title="No turns yet" hint="Start a conversation to see per-turn telemetry here." />
      ) : (
        <ScrollList maxHeight={240}>
          {/* Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '70px 1fr 72px 60px 52px',
            gap: 6,
            padding: '0 8px 4px',
            fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.2em',
            color: 'var(--ink-dim)',
            borderBottom: '1px solid var(--line-soft)',
          }}>
            <span>TIME</span>
            <span>MODEL</span>
            <span style={{ textAlign: 'right' }}>IN/OUT</span>
            <span style={{ textAlign: 'right' }}>COST</span>
            <span style={{ textAlign: 'right' }}>LATENCY</span>
          </div>
          {last10.map((ev, idx) => (
            <div
              key={idx}
              style={{
                display: 'grid',
                gridTemplateColumns: '70px 1fr 72px 60px 52px',
                gap: 6,
                padding: '5px 8px',
                background: idx % 2 === 0 ? 'rgba(57,229,255,0.02)' : 'transparent',
                borderLeft: '2px solid transparent',
              }}
            >
              <span style={{ ...COL, color: 'var(--ink-dim)' }}>{fmtTime(ev.at)}</span>
              <span style={{ ...COL, color: 'var(--ink)' }} title={ev.model}>{ev.model}</span>
              <span style={{ ...COL, color: 'var(--ink-2)', textAlign: 'right' }}>
                {ev.input}/{ev.output}
              </span>
              <span style={{
                ...COL, textAlign: 'right',
                color: ev.cost_usd === 0 ? 'var(--green)' : 'var(--amber)',
              }}>
                {fmtUsd(ev.cost_usd ?? 0)}
              </span>
              <span style={{ ...COL, color: 'var(--cyan)', textAlign: 'right' }}>
                {fmtMs(ev.duration_ms)}
              </span>
            </div>
          ))}
        </ScrollList>
      )}
    </Section>
  );
}
