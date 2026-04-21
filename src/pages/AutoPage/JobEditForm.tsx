// ─────────────────────────────────────────────────────────────────
// JobEditForm — inline slide-down edit form for a scheduled job.
// Fields: title (all kinds) + every_sec (Interval only).
// Mounts beneath the JobRow when EDIT is clicked.
// ─────────────────────────────────────────────────────────────────

import { useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { schedulerUpdate } from './api';
import { ghostBtn, inputStyle, labelStyle, primaryBtn } from './styles';
import type { Job } from './types';

type Props = {
  job: Job;
  onSaved: () => Promise<void>;
  onCancel: () => void;
};

export function JobEditForm({ job, onSaved, onCancel }: Props) {
  const isInterval = job.kind === 'Interval';

  const [title, setTitle] = useState<string>(job.title);
  const [everySec, setEverySec] = useState<string>(
    isInterval && job.every_sec !== null ? String(job.every_sec) : '',
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const formRef = useRef<HTMLFormElement>(null);

  const titleId = `job-edit-title-${job.id}`;
  const everySecId = `job-edit-every-sec-${job.id}`;

  const canSave =
    title.trim().length > 0 &&
    (!isInterval || (everySec.trim().length > 0 && Number(everySec) > 0));

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSave || saving) return;

    setSaving(true);
    setError(null);

    try {
      const patch = isInterval
        ? { title: title.trim(), every_sec: Number(everySec) }
        : { title: title.trim() };

      await schedulerUpdate(job.id, patch);
      await onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setSaving(false);
    }
  }

  // Esc anywhere in the form cancels (form-level handler keeps it DRY).
  // Enter in the title input submits via the browser's native form submission.
  function handleKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === 'Escape' && !saving) {
      e.preventDefault();
      onCancel();
    }
  }

  // Title input: Enter triggers native form submit (requestSubmit respects
  // validation and fires the onSubmit handler).
  function handleTitleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => { void handleSubmit(e); }}
      onKeyDown={handleKeyDown}
      aria-label={`Edit job: ${job.title}`}
      style={formWrap}
    >
      <div style={row}>
        {/* Title field */}
        <div style={fieldWrap}>
          <label htmlFor={titleId} style={labelStyle}>
            TITLE
          </label>
          <input
            id={titleId}
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            disabled={saving}
            maxLength={120}
            style={{ ...inputStyle, opacity: saving ? 0.6 : 1 }}
          />
        </div>

        {/* every_sec — Interval only */}
        {isInterval && (
          <div style={{ ...fieldWrap, maxWidth: 140 }}>
            <label htmlFor={everySecId} style={labelStyle}>
              EVERY (SEC)
            </label>
            <input
              id={everySecId}
              type="number"
              min={1}
              step={1}
              value={everySec}
              onChange={e => setEverySec(e.target.value)}
              disabled={saving}
              style={{ ...inputStyle, opacity: saving ? 0.6 : 1 }}
            />
          </div>
        )}

        {/* Actions */}
        <div style={actionGroup}>
          <button
            type="submit"
            disabled={!canSave || saving}
            style={{
              ...primaryBtn,
              opacity: !canSave || saving ? 0.5 : 1,
              cursor: !canSave || saving ? 'not-allowed' : 'pointer',
              fontSize: 10,
              letterSpacing: '0.2em',
            }}
          >
            {saving ? 'SAVING…' : 'SAVE'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            style={{
              ...ghostBtn,
              fontSize: 10,
              letterSpacing: '0.2em',
              opacity: saving ? 0.5 : 1,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            CANCEL
          </button>
        </div>
      </div>

      {error !== null && (
        <div aria-live="polite" style={errorMsg}>
          {error}
        </div>
      )}
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const formWrap: CSSProperties = {
  padding: '10px 14px 12px',
  borderTop: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.03)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 12,
  flexWrap: 'wrap',
};

const fieldWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 140,
};

const actionGroup: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  paddingBottom: 1,
};

const errorMsg: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--red)',
  letterSpacing: '0.05em',
  border: '1px solid rgba(255,77,94,0.3)',
  background: 'rgba(255,77,94,0.06)',
  padding: '5px 10px',
};
