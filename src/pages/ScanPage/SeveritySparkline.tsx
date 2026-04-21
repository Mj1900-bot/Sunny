/**
 * SeveritySparkline — 30-scan sparkline strip shown at the top of ScanPage.
 *
 * Displays three overlapping sparklines (malicious = red, suspicious = amber,
 * info = cyan) from the last 30 scan records. Empty or single-scan states
 * render a dashed placeholder so the slot never collapses.
 */
import { useMemo, type CSSProperties } from 'react';
import type { ScanRecord } from './types';
import { Sparkline } from '../../components/Sparkline';

type Props = {
  readonly records: ReadonlyArray<ScanRecord>;
};

const wrapStyle: CSSProperties = {
  padding: '8px 0 4px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.18em',
  color: 'var(--ink-dim)',
  marginBottom: 2,
};

const legendDot = (color: string): CSSProperties => ({
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: color,
  display: 'inline-block',
  marginRight: 4,
  boxShadow: `0 0 5px ${color}`,
});

const chartWrap: CSSProperties = {
  position: 'relative',
  height: 32,
  overflow: 'visible',
};

export function SeveritySparkline({ records }: Props) {
  const last30 = useMemo(() => [...records].slice(-30), [records]);

  const maliciousData = useMemo(() => last30.map(r => r.progress.malicious), [last30]);
  const suspiciousData = useMemo(() => last30.map(r => r.progress.suspicious), [last30]);
  const infoData = useMemo(() => last30.map(r => r.progress.info), [last30]);

  const peak = useMemo(
    () => Math.max(1, ...maliciousData, ...suspiciousData, ...infoData),
    [maliciousData, suspiciousData, infoData],
  );

  if (records.length === 0) {
    return (
      <div
        style={{
          height: 32,
          border: '1px dashed var(--line-soft)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.16em',
          color: 'var(--ink-dim)',
        }}
      >
        NO SCAN HISTORY — SEVERITY SPARKLINE APPEARS AFTER FIRST SCAN
      </div>
    );
  }

  const total = last30.reduce(
    (acc, r) => ({
      m: acc.m + r.progress.malicious,
      s: acc.s + r.progress.suspicious,
      i: acc.i + r.progress.info,
    }),
    { m: 0, s: 0, i: 0 },
  );

  return (
    <div style={wrapStyle}>
      <div style={headerStyle}>
        <span>SEVERITY · LAST {last30.length} SCANS</span>
        <span style={{ marginLeft: 'auto' }}>
          <span style={legendDot('#ff6a6a')} />
          MAL {total.m}
        </span>
        <span>
          <span style={legendDot('var(--amber)')} />
          SUSP {total.s}
        </span>
        <span>
          <span style={legendDot('var(--cyan)')} />
          INFO {total.i}
        </span>
      </div>
      <div style={chartWrap}>
        {infoData.length >= 2 && (
          <Sparkline
            data={infoData}
            max={peak}
            height={32}
            color="var(--cyan)"
            fill="rgba(57, 229, 255, 0.06)"
            strokeWidth={1}
            style={{ position: 'absolute', inset: 0 }}
          />
        )}
        {suspiciousData.length >= 2 && (
          <Sparkline
            data={suspiciousData}
            max={peak}
            height={32}
            color="var(--amber)"
            fill="rgba(255, 179, 71, 0.08)"
            strokeWidth={1.2}
            style={{ position: 'absolute', inset: 0 }}
          />
        )}
        {maliciousData.length >= 2 && (
          <Sparkline
            data={maliciousData}
            max={peak}
            height={32}
            color="#ff6a6a"
            fill="rgba(255, 106, 106, 0.10)"
            strokeWidth={1.5}
            style={{ position: 'absolute', inset: 0 }}
          />
        )}
      </div>
    </div>
  );
}
