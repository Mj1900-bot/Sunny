// ─────────────────────────────────────────────────────────────────
// Job row — single-row view for a scheduled job with inline controls
// ─────────────────────────────────────────────────────────────────

import { useState } from 'react';
import {
  ACTION_COLOR,
  KIND_COLOR,
  ghostBtn,
  metaCell,
  metaLabel,
  staticChip,
} from './styles';
import type { Job } from './types';
import { formatIntervalSec, formatRelative, truncate } from './utils';
import { JobEditForm } from './JobEditForm';

type JobRowProps = {
  job: Job;
  now: number;
  busy: boolean;
  pendingDelete: boolean;
  expanded: boolean;
  onToggleEnabled: () => void;
  onRunNow: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onToggleError: () => void;
  onRefresh: () => Promise<void>;
};

export function JobRow({
  job,
  now,
  busy,
  pendingDelete,
  expanded,
  onToggleEnabled,
  onRunNow,
  onRequestDelete,
  onConfirmDelete,
  onToggleError,
  onRefresh,
}: JobRowProps) {
  const hasError = job.last_error !== null && job.last_error.length > 0;
  const output = job.last_output ?? '';
  const clickable = hasError;

  const [editOpen, setEditOpen] = useState<boolean>(false);

  function handleEditClick(e: React.MouseEvent) {
    e.stopPropagation();
    const opening = !editOpen;
    setEditOpen(opening);
    // Close the error panel when the edit form opens so the two panels
    // don't stack visibly below the row at the same time.
    if (opening && expanded) {
      onToggleError();
    }
  }

  async function handleSaved() {
    setEditOpen(false);
    await onRefresh();
  }

  return (
    <div
      style={{
        border: `1px solid ${hasError ? 'var(--red)' : 'var(--line-soft)'}`,
        background: hasError
          ? 'rgba(255, 77, 94, 0.05)'
          : job.enabled
            ? 'rgba(57, 229, 255, 0.04)'
            : 'rgba(6, 14, 22, 0.5)',
        opacity: job.enabled ? 1 : 0.7,
        transition: 'all 0.15s ease',
      }}
    >
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-expanded={clickable ? expanded : undefined}
        aria-label={clickable ? `${job.title}: show error details` : undefined}
        onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleError(); } } : undefined}
        onClick={clickable ? onToggleError : undefined}
        style={{
          display: 'grid',
          gridTemplateColumns:
            '20px minmax(140px, 1.4fr) auto auto minmax(80px, 0.9fr) minmax(80px, 0.9fr) minmax(140px, 1.6fr) auto auto auto',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          cursor: clickable ? 'pointer' : 'default',
        }}
      >
        {/* enabled toggle */}
        <button
          onClick={e => {
            e.stopPropagation();
            onToggleEnabled();
          }}
          disabled={busy}
          type="button"
          aria-label={job.enabled ? 'Disable job' : 'Enable job'}
          title={job.enabled ? 'ENABLED' : 'DISABLED'}
          style={{
            all: 'unset',
            cursor: busy ? 'wait' : 'pointer',
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: job.enabled ? 'var(--cyan)' : 'var(--ink-dim)',
            boxShadow: job.enabled ? '0 0 8px var(--cyan)' : 'none',
            border: '1px solid var(--line-soft)',
            justifySelf: 'center',
          }}
        />

        {/* title */}
        <div
          style={{
            fontFamily: 'var(--display)',
            fontSize: 12,
            letterSpacing: '0.14em',
            color: 'var(--ink)',
            fontWeight: 700,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={job.title}
        >
          {job.title}
        </div>

        {/* kind chip */}
        <span style={staticChip(KIND_COLOR[job.kind])}>
          {job.kind === 'Once'
            ? 'ONCE'
            : `EVERY ${formatIntervalSec(job.every_sec ?? 0)}`}
        </span>

        {/* action chip */}
        <span style={staticChip(ACTION_COLOR[job.action.type])}>
          {job.action.type.toUpperCase()}
        </span>

        {/* next run */}
        <div style={metaCell('NEXT', job.next_run === null ? 'var(--ink-dim)' : 'var(--cyan)')}>
          <div style={metaLabel}>NEXT</div>
          <div>{formatRelative(job.next_run, now)}</div>
        </div>

        {/* last run */}
        <div style={metaCell('LAST', job.last_run === null ? 'var(--ink-dim)' : 'var(--amber)')}>
          <div style={metaLabel}>LAST</div>
          <div>{formatRelative(job.last_run, now)}</div>
        </div>

        {/* last output (truncated with tooltip) */}
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            color: 'var(--ink-dim)',
            letterSpacing: '0.04em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={output.length > 0 ? output : undefined}
        >
          {output.length > 0 ? truncate(output, 60) : '—'}
        </div>

        {/* run now */}
        <button
          type="button"
          aria-label={busy ? `${job.title}: running…` : `Run ${job.title} now`}
          onClick={e => {
            e.stopPropagation();
            onRunNow();
          }}
          disabled={busy}
          style={{
            ...ghostBtn,
            fontSize: 10,
            letterSpacing: '0.2em',
            borderColor: busy ? 'var(--amber)' : 'var(--cyan)',
            color: busy ? 'var(--amber)' : '#fff',
            background: busy ? 'rgba(255, 179, 71, 0.08)' : 'rgba(57, 229, 255, 0.18)',
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? '…' : 'RUN NOW'}
        </button>

        {/* delete (2-click confirm) */}
        <button
          type="button"
          aria-label={pendingDelete ? `Confirm delete ${job.title}` : `Delete ${job.title}`}
          onClick={e => {
            e.stopPropagation();
            if (pendingDelete) onConfirmDelete();
            else onRequestDelete();
          }}
          style={{
            ...ghostBtn,
            fontSize: 10,
            letterSpacing: '0.2em',
            borderColor: pendingDelete ? 'var(--red)' : 'rgba(255, 77, 94, 0.35)',
            color: 'var(--red)',
            background: pendingDelete
              ? 'rgba(255, 77, 94, 0.18)'
              : 'rgba(255, 77, 94, 0.05)',
          }}
        >
          {pendingDelete ? 'CONFIRM?' : 'DELETE'}
        </button>

        {/* edit — toggles inline JobEditForm below the row */}
        <button
          type="button"
          aria-label={editOpen ? `Close edit form for ${job.title}` : `Edit ${job.title}`}
          aria-expanded={editOpen}
          onClick={handleEditClick}
          style={{
            ...ghostBtn,
            fontSize: 10,
            letterSpacing: '0.2em',
            borderColor: editOpen ? 'var(--cyan)' : 'var(--line-soft)',
            color: editOpen ? 'var(--cyan)' : 'var(--ink-dim)',
            background: editOpen ? 'rgba(57, 229, 255, 0.12)' : 'transparent',
          }}
        >
          EDIT
        </button>
      </div>

      {/* inline edit form */}
      {editOpen && (
        <JobEditForm
          job={job}
          onSaved={handleSaved}
          onCancel={() => setEditOpen(false)}
        />
      )}

      {hasError && expanded && job.last_error !== null && (
        <div
          aria-live="polite"
          aria-atomic="true"
          role="region"
          aria-label={`Error details for ${job.title}`}
          style={{
            padding: '8px 14px 12px',
            borderTop: '1px solid var(--line-soft)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--red)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'rgba(255, 77, 94, 0.04)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 9,
              letterSpacing: '0.22em',
              color: 'var(--red)',
              fontWeight: 700,
              marginBottom: 4,
            }}
          >
            LAST ERROR
          </div>
          {job.last_error}
        </div>
      )}
    </div>
  );
}
