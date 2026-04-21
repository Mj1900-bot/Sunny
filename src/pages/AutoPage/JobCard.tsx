// ─────────────────────────────────────────────────────────────────
// JobCard — single scheduled-job card for the Auto page.
//
// Shows status dot, title, kind badge, next-run, action preview,
// last-10-run history list, duration sparkline, and controls.
// ─────────────────────────────────────────────────────────────────

import { useMemo, useState, type CSSProperties } from 'react';
import type { Job } from './types';
import { jobStatus, kindTagOf } from './types';
import { formatIntervalSec, formatRelative, truncate } from './utils';
import { getJobHistory, durationSeries } from './jobHistory';
import { Sparkline } from '../_shared';

type Props = {
  readonly job: Job;
  readonly now: number;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onRunNow: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
};

const STATUS_COLOR = {
  ok: 'var(--green)',
  error: 'var(--red)',
  never: 'var(--ink-dim)',
} as const;

const STATUS_LABEL = {
  ok: 'OK',
  error: 'ERR',
  never: '—',
} as const;

const KIND_COLOR = {
  Once: 'var(--cyan)',
  Interval: 'var(--amber)',
} as const;

const cardStyle = (enabled: boolean, hasError: boolean): CSSProperties => ({
  border: `1px solid ${hasError ? 'var(--red)' : 'var(--line-soft)'}`,
  background: hasError
    ? 'rgba(255, 77, 94, 0.05)'
    : enabled
      ? 'rgba(57, 229, 255, 0.04)'
      : 'rgba(6, 14, 22, 0.5)',
  opacity: enabled ? 1 : 0.72,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  transition: 'opacity 0.15s ease, border-color 0.15s ease',
});

const topRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const titleStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 12,
  letterSpacing: '0.14em',
  color: 'var(--ink)',
  fontWeight: 700,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  minWidth: 0,
};

const chipStyle = (color: string): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 7px',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.16em',
  fontWeight: 700,
  border: `1px solid ${color}`,
  color,
  background: 'rgba(6, 14, 22, 0.6)',
  whiteSpace: 'nowrap',
});

const nextRunStyle = (color: string): CSSProperties => ({
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color,
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
});

const previewStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  letterSpacing: '0.04em',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.45,
};

const bottomRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const buttonStyle = (color: string, disabled: boolean): CSSProperties => ({
  all: 'unset',
  cursor: disabled ? 'wait' : 'pointer',
  padding: '4px 10px',
  border: `1px solid ${color}`,
  color,
  background: 'rgba(6, 14, 22, 0.55)',
  fontFamily: 'var(--display)',
  fontSize: 10,
  letterSpacing: '0.2em',
  fontWeight: 700,
  opacity: disabled ? 0.5 : 1,
});

function actionPreview(job: Job): string {
  switch (job.action.type) {
    case 'Shell':   return `Shell: ${job.action.data.cmd}`;
    case 'Notify':  return `Notify: ${job.action.data.title} — ${job.action.data.body}`;
    case 'Speak':   return `Speak: ${job.action.data.text}`;
    case 'AgentGoal': return `AgentGoal: ${job.action.data.goal}`;
  }
}

function nextRunLabel(job: Job, now: number): string {
  if (!job.enabled) return 'never';
  if (job.next_run === null) return 'never';
  return formatRelative(job.next_run, now);
}

function nextRunColor(job: Job): string {
  if (!job.enabled) return 'var(--ink-dim)';
  if (job.next_run === null) return 'var(--ink-dim)';
  return 'var(--cyan)';
}

function kindLabel(job: Job): string {
  const tag = kindTagOf(job);
  if (tag.type === 'Once') return 'ONCE';
  const every = job.every_sec ?? 0;
  return `INTERVAL ${formatIntervalSec(every)}`;
}

export function JobCard({ job, now, busy, onToggle, onRunNow, onEdit, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
  const [showHistory, setShowHistory] = useState(false);

  const status = jobStatus(job);
  const hasError = status === 'error';
  const tag = kindTagOf(job);
  const kindColor = KIND_COLOR[tag.type];
  const preview = truncate(actionPreview(job), 80);
  const runHistory = useMemo(() => getJobHistory(job.id), [job.id]);
  const sparkData = useMemo(() => durationSeries(runHistory), [runHistory]);

  const handleDeleteClick = () => {
    if (confirmDelete) { onDelete(); setConfirmDelete(false); return; }
    setConfirmDelete(true);
    window.setTimeout(() => setConfirmDelete(false), 3_000);
  };

  return (
    <div style={cardStyle(job.enabled, hasError)}>
      <div style={topRowStyle}>
        <button
          onClick={onToggle}
          disabled={busy}
          aria-label={job.enabled ? 'Disable job' : 'Enable job'}
          title={job.enabled ? 'ENABLED (click to disable)' : 'DISABLED (click to enable)'}
          style={{
            all: 'unset',
            cursor: busy ? 'wait' : 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 16,
            lineHeight: 1,
            color: job.enabled ? 'var(--cyan)' : 'var(--ink-dim)',
            textShadow: job.enabled ? '0 0 6px var(--cyan)' : 'none',
            width: 16,
            textAlign: 'center',
          }}
        >
          {job.enabled ? '\u25CF' : '\u25CB'}
        </button>

        <div style={titleStyle} title={job.title}>{job.title}</div>
        <span style={chipStyle(kindColor)}>{kindLabel(job)}</span>
        <span style={chipStyle(STATUS_COLOR[status])} title="Last run status">
          {STATUS_LABEL[status]}
        </span>
        <div style={nextRunStyle(nextRunColor(job))} title="Next scheduled run">
          {nextRunLabel(job, now)}
        </div>
      </div>

      <div style={previewStyle} title={actionPreview(job)}>{preview}</div>

      {/* Duration sparkline + run count */}
      {sparkData.length >= 2 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sparkline
            values={sparkData}
            width={80}
            height={18}
            tone="amber"
            filled
          />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
            {runHistory.length} local run{runHistory.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => setShowHistory(h => !h)}
            style={{
              all: 'unset', cursor: 'pointer', fontFamily: 'var(--mono)',
              fontSize: 10, color: 'var(--cyan)', letterSpacing: '0.1em',
            }}
          >{showHistory ? 'HIDE HISTORY' : 'HISTORY'}</button>
        </div>
      )}

      {/* Run history list */}
      {showHistory && runHistory.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 120, overflow: 'auto' }}>
          {[...runHistory].reverse().map((r, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 60px 40px', gap: 8,
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '2px 6px', borderLeft: `2px solid ${r.ok ? 'var(--green)' : 'var(--red)'}`,
            }}>
              <span style={{ color: 'var(--ink-dim)' }}>
                {new Date(r.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span style={{ color: 'var(--amber)' }}>{r.duration_ms > 0 ? `${r.duration_ms}ms` : '—'}</span>
              <span style={{ color: r.ok ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                {r.ok ? 'OK' : 'ERR'}
              </span>
            </div>
          ))}
        </div>
      )}

      {hasError && job.last_error !== null && (
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--red)',
          letterSpacing: '0.04em', padding: '4px 8px',
          border: '1px solid rgba(255, 77, 94, 0.35)',
          background: 'rgba(255, 77, 94, 0.05)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{truncate(job.last_error, 180)}</div>
      )}

      <div style={bottomRowStyle}>
        <button onClick={onRunNow} disabled={busy} style={buttonStyle('var(--cyan)', busy)} title="Run this job now">
          {'\u25B6'} RUN NOW
        </button>
        <button onClick={onEdit} disabled={busy} style={buttonStyle('var(--ink-2)', busy)} title="Edit job">
          {'\u270E'} EDIT
        </button>
        <button
          onClick={handleDeleteClick}
          disabled={busy}
          style={{
            ...buttonStyle(confirmDelete ? 'var(--red)' : 'rgba(255, 77, 94, 0.55)', busy),
            background: confirmDelete ? 'rgba(255, 77, 94, 0.18)' : 'rgba(6, 14, 22, 0.55)',
            color: 'var(--red)',
          }}
          title={confirmDelete ? 'Click again to confirm' : 'Delete job'}
        >
          {confirmDelete ? 'SURE? Y/N' : `${'\u2715'} DELETE`}
        </button>
      </div>
    </div>
  );
}
