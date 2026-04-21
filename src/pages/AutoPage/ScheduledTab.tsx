import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { isTauri } from '../../lib/tauri';
import {
  schedulerAdd,
  schedulerDelete,
  schedulerList,
  schedulerRunOnce,
  schedulerSetEnabled,
} from './api';
import { EmptyState } from './EmptyState';
import { JobRow } from './JobRow';
import { NewJobSection } from './NewJobSection';
import { SectionHeader } from './SectionHeader';
import type { Draft, Job } from './types';
import { EMPTY_DRAFT, buildAddArgs, draftIsValid, formatIntervalSec } from './utils';

// ─────────────────────────────────────────────────────────────────
// ScheduledTab — recurring/scheduled automation jobs with sort,
// bulk actions, and visual timeline indicators.
// ─────────────────────────────────────────────────────────────────

export type SchedulerCounts = { readonly enabled: number; readonly total: number };

type Props = {
  readonly onCountsChange?: (counts: SchedulerCounts) => void;
};

type SortKey = 'title' | 'next' | 'last' | 'created';

const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'title',   label: 'Name A–Z' },
  { key: 'next',    label: 'Next run' },
  { key: 'last',    label: 'Last run' },
  { key: 'created', label: 'Created' },
];

function sortJobs(jobs: ReadonlyArray<Job>, key: SortKey): ReadonlyArray<Job> {
  const list = [...jobs];
  switch (key) {
    case 'title':
      return list.sort((a, b) => a.title.localeCompare(b.title));
    case 'next':
      return list.sort((a, b) => (a.next_run ?? Infinity) - (b.next_run ?? Infinity));
    case 'last':
      return list.sort((a, b) => (b.last_run ?? 0) - (a.last_run ?? 0));
    case 'created':
      return list.sort((a, b) => b.created_at - a.created_at);
    default:
      return list;
  }
}

function BackendOffline() {
  return (
    <div
      style={{
        padding: 24,
        border: '1px dashed rgba(57, 229, 255, 0.25)',
        background: 'rgba(6, 14, 22, 0.5)',
        color: 'var(--ink-dim)',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        letterSpacing: '0.06em',
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--display)',
          fontSize: 13,
          letterSpacing: '0.28em',
          color: 'var(--cyan)',
          fontWeight: 700,
          marginBottom: 10,
        }}
      >
        BACKEND REQUIRED
      </div>
      <div>
        The SCHEDULED tab needs the Tauri scheduler runtime. Launch SUNNY via
        <code
          style={{
            margin: '0 6px',
            color: 'var(--cyan)',
            background: 'rgba(57, 229, 255, 0.08)',
            padding: '2px 6px',
          }}
        >
          pnpm tauri dev
        </code>
        to schedule, run, and manage automation jobs.
      </div>
    </div>
  );
}

export function ScheduledTab({ onCountsChange }: Props) {
  const [jobs, setJobs] = useState<ReadonlyArray<Job>>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [formOpen, setFormOpen] = useState<boolean>(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState<boolean>(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('title');
  const deleteTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try {
      const next = await schedulerList();
      setJobs(next);
      setLoadErr(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadErr(msg);
    }
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
      setNow(Date.now());
    }, 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (deleteTimer.current !== null) {
        window.clearTimeout(deleteTimer.current);
      }
    };
  }, []);

  const enabledCount = useMemo(() => jobs.filter(j => j.enabled).length, [jobs]);
  const sorted = useMemo(() => sortJobs(jobs, sortKey), [jobs, sortKey]);

  useEffect(() => {
    onCountsChange?.({ enabled: enabledCount, total: jobs.length });
  }, [enabledCount, jobs.length, onCountsChange]);

  const resetDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setCreateErr(null);
  }, []);

  const patch = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleCreate = useCallback(async () => {
    if (!draftIsValid(draft) || creating) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const args = buildAddArgs(draft);
      await schedulerAdd(args);
      resetDraft();
      setFormOpen(false);
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCreateErr(msg);
    } finally {
      setCreating(false);
    }
  }, [draft, creating, refresh, resetDraft]);

  const handleToggle = useCallback(
    async (job: Job) => {
      if (busyId !== null) return;
      setBusyId(job.id);
      try {
        await schedulerSetEnabled(job.id, !job.enabled);
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadErr(msg);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh],
  );

  const handleRunNow = useCallback(
    async (job: Job) => {
      if (busyId !== null) return;
      setBusyId(job.id);
      try {
        await schedulerRunOnce(job.id);
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadErr(msg);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh],
  );

  const requestDelete = useCallback((id: string) => {
    if (deleteTimer.current !== null) {
      window.clearTimeout(deleteTimer.current);
      deleteTimer.current = null;
    }
    setPendingDelete(id);
    deleteTimer.current = window.setTimeout(() => {
      setPendingDelete(prev => (prev === id ? null : prev));
      deleteTimer.current = null;
    }, 3_000);
  }, []);

  const confirmDelete = useCallback(
    async (id: string) => {
      if (deleteTimer.current !== null) {
        window.clearTimeout(deleteTimer.current);
        deleteTimer.current = null;
      }
      setPendingDelete(null);
      try {
        await schedulerDelete(id);
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadErr(msg);
      }
    },
    [refresh],
  );

  // Bulk actions
  const handleEnableAll = useCallback(async () => {
    for (const j of jobs) {
      if (!j.enabled) {
        try { await schedulerSetEnabled(j.id, true); } catch { /* continue */ }
      }
    }
    await refresh();
  }, [jobs, refresh]);

  const handleDisableAll = useCallback(async () => {
    for (const j of jobs) {
      if (j.enabled) {
        try { await schedulerSetEnabled(j.id, false); } catch { /* continue */ }
      }
    }
    await refresh();
  }, [jobs, refresh]);

  if (!isTauri) return <BackendOffline />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, animation: 'fadeSlideIn 200ms ease-out' }}>
      {loadErr !== null && (
        <div
          style={{
            border: '1px solid var(--red)',
            background: 'rgba(255, 77, 94, 0.08)',
            color: 'var(--red)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            padding: '8px 12px',
            letterSpacing: '0.06em',
          }}
        >
          {loadErr}
        </div>
      )}

      <NewJobSection
        open={formOpen}
        onToggle={() => setFormOpen(o => !o)}
        draft={draft}
        patch={patch}
        valid={draftIsValid(draft)}
        creating={creating}
        createErr={createErr}
        onCreate={handleCreate}
        onReset={resetDraft}
      />

      {/* Sort + Bulk controls */}
      {jobs.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '6px 0',
          }}
        >
          <span style={controlLabel}>SORT</span>
          <select
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            aria-label="Sort jobs"
            style={selectStyle}
          >
            {SORT_OPTIONS.map(s => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>

          <span style={{ flex: 1 }} />

          <span style={controlLabel}>BULK</span>
          <button
            onClick={() => { void handleEnableAll(); }}
            style={bulkBtnStyle('var(--green)')}
            disabled={enabledCount === jobs.length}
          >
            ✓ ENABLE ALL
          </button>
          <button
            onClick={() => { void handleDisableAll(); }}
            style={bulkBtnStyle('var(--amber)')}
            disabled={enabledCount === 0}
          >
            ⏸ DISABLE ALL
          </button>
        </div>
      )}

      {/* Job timeline strip — visual mini-timeline of upcoming fires */}
      {sorted.length > 0 && sorted.some(j => j.next_run !== null) && (
        <div style={timelineStrip}>
          <div style={controlLabel}>UPCOMING TIMELINE</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 24, marginTop: 4 }}>
            {sorted.filter(j => j.next_run !== null && j.enabled).slice(0, 20).map(j => {
              const diffSec = Math.max(0, (j.next_run ?? 0) - Math.floor(Date.now() / 1000));
              const maxSec = 86400; // 24h
              const pct = Math.min(100, (diffSec / maxSec) * 100);
              const heightPx = Math.max(4, 24 - (pct / 100) * 20);
              return (
                <div
                  key={j.id}
                  title={`${j.title} — in ${formatIntervalSec(diffSec)}`}
                  style={{
                    flex: 1,
                    height: heightPx,
                    background: 'linear-gradient(180deg, var(--cyan), var(--cyan-2))',
                    borderRadius: 1,
                    boxShadow: '0 0 4px var(--cyan)',
                    opacity: 0.8,
                    transition: 'height 500ms ease',
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      <div>
        <SectionHeader label="JOBS" count={jobs.length} />
        {sorted.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sorted.map(job => (
              <JobRow
                key={job.id}
                job={job}
                now={now}
                busy={busyId === job.id}
                pendingDelete={pendingDelete === job.id}
                expanded={expandedError === job.id}
                onToggleEnabled={() => handleToggle(job)}
                onRunNow={() => handleRunNow(job)}
                onRequestDelete={() => requestDelete(job.id)}
                onConfirmDelete={() => confirmDelete(job.id)}
                onRefresh={refresh}
                onToggleError={() =>
                  setExpandedError(prev => (prev === job.id ? null : job.id))
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const selectStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  background: 'rgba(0, 0, 0, 0.35)',
  border: '1px solid var(--line-soft)',
  padding: '5px 10px',
  borderRadius: 2,
  cursor: 'pointer',
  minWidth: 120,
};

const controlLabel: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 8,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
};

const bulkBtnStyle = (color: string): CSSProperties => ({
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 10px',
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.18em',
  fontWeight: 700,
  color,
  border: `1px solid ${color}`,
  background: `${color}11`,
  transition: 'background 150ms ease',
});

const timelineStrip: CSSProperties = {
  padding: '8px 12px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.03)',
};
