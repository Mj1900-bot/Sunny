import { useCallback, useEffect, useState } from 'react';
import { scanList } from './api';
import type { ScanPhase, ScanRecord } from './types';
import {
  chipBaseStyle,
  emptyStateStyle,
  hintStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';
import { formatRelativeSecs, shortPath } from './types';
import { SeveritySparkline } from './SeveritySparkline';

// Scan history refresh — users only glance at this tab, low frequency is fine.
const POLL_MS = 3000;

type Props = {
  readonly activeScanId: string | null;
  readonly onSelect: (scanId: string) => void;
};

export function HistoryTab({ activeScanId, onSelect }: Props) {
  const [records, setRecords] = useState<ReadonlyArray<ScanRecord>>([]);

  const refresh = useCallback(async () => {
    const next = await scanList();
    setRecords(next);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (records.length === 0) {
    return (
      <div style={emptyStateStyle}>NO SCANS YET — START ONE FROM THE SCAN TAB</div>
    );
  }

  return (
    <>
      <section style={{ ...sectionStyle, marginBottom: 10 }}>
        <div style={sectionTitleStyle}>SEVERITY TREND</div>
        <SeveritySparkline records={records} />
      </section>

      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>HISTORY</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {records.length} scan{records.length === 1 ? '' : 's'}
          </span>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
        {records.map(r => (
          <HistoryRow
            key={r.scanId}
            record={r}
            isActive={activeScanId === r.scanId}
            onSelect={() => onSelect(r.scanId)}
          />
        ))}
        </div>
      </section>
    </>
  );
}

function HistoryRow({
  record,
  isActive,
  onSelect,
}: {
  record: ScanRecord;
  isActive: boolean;
  onSelect: () => void;
}) {
  const p = record.progress;
  const phaseColor = phaseColorFor(p.phase);

  const elapsed = (p.finishedAt ?? Math.floor(Date.now() / 1000)) - p.startedAt;
  const elapsedStr =
    elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.round(elapsed / 60)}m` : `${(elapsed / 3600).toFixed(1)}h`;

  // Border color inherits from the worst verdict present so the scanlist
  // reads "these scans turned up real threats" at a glance.
  const severityBorder =
    p.malicious > 0
      ? 'rgba(255, 106, 106, 0.65)'
      : p.suspicious > 0
        ? 'rgba(255, 179, 71, 0.55)'
        : isActive
          ? 'var(--cyan)'
          : 'var(--line-soft)';

  return (
    <button
      onClick={onSelect}
      title={`${record.target} · ${p.phase}`}
      style={{
        ...chipBaseStyle,
        cursor: 'pointer',
        padding: '12px 14px',
        display: 'grid',
        gridTemplateColumns: '90px 1fr auto auto auto auto',
        gap: 12,
        alignItems: 'center',
        borderColor: severityBorder,
        background: isActive ? 'rgba(57, 229, 255, 0.08)' : 'rgba(6, 14, 22, 0.4)',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          justifyContent: 'center',
          padding: '2px 8px',
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          letterSpacing: '0.18em',
          color: phaseColor,
          border: `1px solid ${phaseColor}`,
          background: 'rgba(6, 14, 22, 0.4)',
        }}
      >
        {p.phase.toUpperCase()}
      </span>
      <span
        style={{
          color: 'var(--ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'left',
        }}
        title={record.target}
      >
        {shortPath(record.target, 90)}
      </span>

      {/* Per-scan verdict breakdown — collapses silent counters so clean
          scans stay visually calm. */}
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        {p.malicious > 0 && <VerdictPill count={p.malicious} color="#ff6a6a" />}
        {p.suspicious > 0 && <VerdictPill count={p.suspicious} color="var(--amber)" />}
        {p.info > 0 && <VerdictPill count={p.info} color="var(--cyan)" />}
        {p.malicious + p.suspicious + p.info === 0 && p.phase === 'done' && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.18em',
              color: 'rgb(120, 255, 170)',
              border: '1px solid rgba(120, 255, 170, 0.45)',
              padding: '0 6px',
            }}
          >
            ✓ CLEAN
          </span>
        )}
      </span>

      <span style={{ ...hintStyle, fontSize: 10 }}>{elapsedStr}</span>
      <span style={{ ...hintStyle, fontSize: 10 }}>
        {p.filesInspected} / {p.filesDiscovered}
      </span>
      <span style={{ ...hintStyle, fontSize: 10 }}>
        {formatRelativeSecs(p.startedAt)}
      </span>
    </button>
  );
}

function VerdictPill({ count, color }: { count: number; color: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 9,
        letterSpacing: '0.14em',
        color,
        border: `1px solid ${color}`,
        background: 'rgba(6, 14, 22, 0.55)',
        padding: '0 6px',
        minWidth: 18,
        textAlign: 'center',
      }}
    >
      {count}
    </span>
  );
}

function phaseColorFor(phase: ScanPhase): string {
  if (phase === 'done') return 'rgb(120, 255, 170)';
  if (phase === 'aborted') return 'var(--amber)';
  if (phase === 'errored') return '#ff6a6a';
  return 'var(--cyan)';
}
