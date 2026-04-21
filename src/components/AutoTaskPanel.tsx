/**
 * AutoTaskPanel — replaces the former CONVERSATION panel. Shows what the
 * scheduler is up to: each automation job's state, next run, and health.
 * Poll-based (every 4 s) because the scheduler runs Rust-side and doesn't
 * emit per-tick events; the poll is cheap (`scheduler_list` reads an
 * in-memory Vec), and pausing polling when the tab is hidden keeps us
 * from burning cycles in the background.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Panel } from './Panel';
import { schedulerList, schedulerRunOnce, schedulerSetEnabled } from '../pages/AutoPage/api';
import type { Job } from '../pages/AutoPage/types';
import { useView } from '../store/view';
import { useSubAgentsLive } from '../store/subAgentsLive';
import { useAgentStore } from '../store/agent';
import { isTauri } from '../lib/tauri';
import { toast } from '../hooks/useToast';

const POLL_MS = 4_000;

type HealthLevel = 'ok' | 'warn' | 'crit' | 'off';

function jobHealth(j: Job): HealthLevel {
  if (!j.enabled) return 'off';
  if (j.last_error) return 'crit';
  // Interval job that's past due (next_run was more than 2 intervals ago)
  if (j.kind === 'Interval' && j.next_run !== null && j.every_sec !== null) {
    const overdueBy = Date.now() - j.next_run;
    if (overdueBy > j.every_sec * 2_000) return 'warn';
  }
  return 'ok';
}

function healthColor(h: HealthLevel): string {
  switch (h) {
    case 'ok':   return 'var(--green)';
    case 'warn': return 'var(--amber)';
    case 'crit': return 'var(--red)';
    case 'off':  return 'var(--ink-dim)';
  }
}

function formatRelative(at: number, now: number): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  const pre = diff < 0 ? '-' : 'in ';
  const suf = diff < 0 ? ' ago' : '';
  if (abs < 60_000) return `${pre}${Math.max(1, Math.round(abs / 1000))}s${suf}`;
  if (abs < 3_600_000) return `${pre}${Math.round(abs / 60_000)}m${suf}`;
  if (abs < 86_400_000) return `${pre}${Math.round(abs / 3_600_000)}h${suf}`;
  return `${pre}${Math.round(abs / 86_400_000)}d${suf}`;
}

function formatInterval(sec: number | null): string {
  if (sec === null || sec <= 0) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function actionLabel(j: Job): string {
  const t = j.action.type;
  if (t === 'Shell') return '$ shell';
  if (t === 'Notify') return '◇ notify';
  if (t === 'Speak') return '♪ speak';
  return t;
}

export function AutoTaskPanel(): ReactElement {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const { setView } = useView();
  const cancelledRef = useRef<boolean>(false);

  // Live agent side of "auto" — sub-agent count + main agent status, so the
  // panel surfaces everything the AutoPage would show without leaving
  // Overview.
  const subAgents = useSubAgentsLive(s => s.subAgents);
  const subOrder = useSubAgentsLive(s => s.order);
  const mainStatus = useAgentStore(s => s.status);
  const mainGoal = useAgentStore(s => s.goal);

  const fetchJobs = useCallback(async () => {
    if (!isTauri) { setJobs([]); setLoaded(true); return; }
    try {
      const list = await schedulerList();
      if (cancelledRef.current) return;
      setJobs(list);
      setError(null);
      setLoaded(true);
    } catch (e) {
      if (cancelledRef.current) return;
      setError(String((e as Error)?.message ?? e));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void fetchJobs();
    const id = window.setInterval(() => void fetchJobs(), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
      window.clearInterval(tick);
    };
  }, [fetchJobs]);

  const sorted = useMemo(() => {
    // Running/enabled jobs with a near-future next_run float to the top.
    return [...jobs].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const an = a.next_run ?? Number.MAX_SAFE_INTEGER;
      const bn = b.next_run ?? Number.MAX_SAFE_INTEGER;
      return an - bn;
    });
  }, [jobs]);

  const stats = useMemo(() => {
    let enabled = 0, errored = 0, dueSoon = 0;
    for (const j of jobs) {
      if (j.enabled) enabled += 1;
      if (j.last_error) errored += 1;
      if (j.enabled && j.next_run !== null && j.next_run - now < 60_000) dueSoon += 1;
    }
    return { enabled, errored, dueSoon, total: jobs.length };
  }, [jobs, now]);

  const runningSubs = useMemo(() => {
    let count = 0;
    for (const id of subOrder) {
      const s = subAgents[id];
      if (s && s.status === 'running') count += 1;
    }
    return count;
  }, [subAgents, subOrder]);

  const badge = useMemo(() => {
    if (!loaded) return '…';
    if (stats.total === 0 && mainStatus === 'idle' && runningSubs === 0) return 'IDLE';
    const parts: string[] = [];
    if (stats.enabled > 0) parts.push(`${stats.enabled}/${stats.total} ON`);
    if (stats.errored > 0) parts.push(`${stats.errored} ERR`);
    return parts.length > 0 ? parts.join(' · ') : `${stats.total} JOBS`;
  }, [loaded, stats, mainStatus, runningSubs]);

  const openAuto = useCallback(() => { setView('auto'); }, [setView]);

  const onToggle = useCallback(async (j: Job) => {
    try {
      await schedulerSetEnabled(j.id, !j.enabled);
      await fetchJobs();
      toast.success(`${j.title} ${!j.enabled ? 'enabled' : 'paused'}`);
    } catch (e) {
      toast.error(`toggle failed: ${String((e as Error).message ?? e)}`);
    }
  }, [fetchJobs]);

  const onRunNow = useCallback(async (j: Job) => {
    try {
      await schedulerRunOnce(j.id);
      toast.info(`Running "${j.title}"`);
      window.setTimeout(() => void fetchJobs(), 600);
    } catch (e) {
      toast.error(`run failed: ${String((e as Error).message ?? e)}`);
    }
  }, [fetchJobs]);

  return (
    <Panel
      id="p-agent"
      title="AUTO TASKS"
      right={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={openAuto}
            className="hdr-chip"
            title="Open Auto page"
          >
            NEW +
          </button>
          <span
            style={{
              color:
                stats.errored > 0 ? 'var(--red)'
                : stats.enabled > 0 ? 'var(--cyan)'
                : 'var(--ink-dim)',
            }}
          >
            {badge}
          </span>
        </span>
      }
    >
      <div
        style={{
          display: 'flex', flexDirection: 'column', gap: 6, height: '100%',
          fontFamily: 'var(--label)', fontSize: 11.5,
        }}
      >
        {/* Live agent strip — always shown so idle state still communicates
            the two signals (main agent, sub-agent count) the user expects. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            padding: '5px 6px',
            border: '1px solid var(--line-soft)',
            background: 'rgba(57,229,255,0.03)',
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            flexShrink: 0,
          }}
        >
          <MiniStat
            k="MAIN"
            v={mainStatus.toUpperCase()}
            dotColor={
              mainStatus === 'running' ? 'var(--amber)'
              : mainStatus === 'done' ? 'var(--green)'
              : mainStatus === 'error' ? 'var(--red)'
              : 'var(--ink-dim)'
            }
            title={mainGoal || '(no active goal)'}
            pulsing={mainStatus === 'running'}
          />
          <MiniStat
            k="SUBS"
            v={`${runningSubs} running`}
            dotColor={runningSubs > 0 ? 'var(--amber)' : 'var(--ink-dim)'}
            pulsing={runningSubs > 0}
          />
        </div>

        {!isTauri ? (
          <EmptyMessage text="DEMO — scheduler unavailable in preview" />
        ) : error ? (
          <EmptyMessage text={`ERR · ${error.slice(0, 60)}`} tone="crit" />
        ) : !loaded ? (
          <EmptyMessage text="loading…" />
        ) : sorted.length === 0 ? (
          <div
            style={{
              flex: '1 1 auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink-dim)',
              padding: '10px 6px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontFamily: 'var(--display)', fontSize: 11, letterSpacing: '0.22em', marginBottom: 4 }}>
              NO AUTO TASKS
            </div>
            <div style={{ fontSize: 10.5, lineHeight: 1.4, color: 'var(--ink-dim)' }}>
              Nothing scheduled.<br />Press <b style={{ color: 'var(--cyan)' }}>NEW +</b> to create one.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, overflow: 'auto', flex: '1 1 auto' }}>
            {sorted.map(j => (
              <JobRow
                key={j.id}
                job={j}
                now={now}
                onToggle={() => void onToggle(j)}
                onRunNow={() => void onRunNow(j)}
              />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Job row
// ---------------------------------------------------------------------------

function JobRow({
  job, now, onToggle, onRunNow,
}: {
  readonly job: Job;
  readonly now: number;
  readonly onToggle: () => void;
  readonly onRunNow: () => void;
}): ReactElement {
  const h = jobHealth(job);
  const color = healthColor(h);
  const nextLabel =
    job.enabled && job.next_run !== null
      ? formatRelative(job.next_run, now)
      : job.enabled ? 'queued' : 'paused';
  const lastLabel =
    job.last_run !== null ? formatRelative(job.last_run, now) : 'never run';

  const borderLeft = `2px solid ${color}`;

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        borderLeft,
        padding: '5px 7px',
        background: h === 'crit' ? 'rgba(255,77,94,0.06)' : 'rgba(57,229,255,0.025)',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
      title={job.last_error ?? job.last_output ?? job.title}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 7, height: 7, borderRadius: '50%',
            background: color,
            boxShadow: h === 'ok' || h === 'warn' || h === 'crit' ? `0 0 5px ${color}` : 'none',
            animation: job.enabled && !job.last_error ? 'autoTaskPulse 2s ease-in-out infinite' : 'none',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            color: 'var(--ink)',
            fontWeight: 600,
            fontSize: 12,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: '1 1 auto',
            minWidth: 0,
          }}
        >
          {job.title}
        </span>
        <button
          type="button"
          onClick={onRunNow}
          title="Run now"
          style={miniBtnStyle}
        >
          ▶
        </button>
        <button
          type="button"
          onClick={onToggle}
          title={job.enabled ? 'Pause' : 'Resume'}
          style={miniBtnStyle}
        >
          {job.enabled ? '❙❙' : '▸'}
        </button>
      </div>
      <div
        style={{
          display: 'flex', justifyContent: 'space-between', gap: 6,
          fontFamily: 'var(--mono)', fontSize: 10,
          color: 'var(--ink-2)',
          letterSpacing: '0.04em',
        }}
      >
        <span title="Action type" style={{ color: 'var(--ink-dim)' }}>
          {actionLabel(job)}
          {job.kind === 'Interval' && (
            <span style={{ opacity: 0.7 }}> · every {formatInterval(job.every_sec)}</span>
          )}
        </span>
        <span style={{ color: job.enabled ? 'var(--cyan)' : 'var(--ink-dim)' }}>{nextLabel}</span>
      </div>
      {(job.last_run !== null || job.last_error) && (
        <div
          style={{
            fontFamily: 'var(--mono)', fontSize: 9.5,
            color: job.last_error ? 'var(--red)' : 'var(--ink-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {job.last_error ? `✗ ${job.last_error}` : `✓ last ${lastLabel}`}
        </div>
      )}
      <style>{`@keyframes autoTaskPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }`}</style>
    </div>
  );
}

const miniBtnStyle: React.CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '0 4px',
  minWidth: 16,
  height: 16,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 9,
  color: 'var(--cyan)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57,229,255,0.04)',
};

// ---------------------------------------------------------------------------
// Mini stat box
// ---------------------------------------------------------------------------

function MiniStat({
  k, v, dotColor, title, pulsing = false,
}: {
  readonly k: string;
  readonly v: string;
  readonly dotColor: string;
  readonly title?: string;
  readonly pulsing?: boolean;
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
      }}
      title={title}
    >
      <div
        style={{
          color: 'var(--ink-dim)',
          letterSpacing: '0.18em',
          fontSize: 9,
          fontFamily: 'var(--display)',
          fontWeight: 700,
        }}
      >
        {k}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: dotColor,
            boxShadow: `0 0 5px ${dotColor}`,
            animation: pulsing ? 'autoTaskPulse 1.2s ease-in-out infinite' : 'none',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            color: 'var(--ink)',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
        >
          {v}
        </span>
      </div>
    </div>
  );
}

function EmptyMessage({ text, tone = 'dim' }: { text: string; tone?: 'dim' | 'crit' }) {
  return (
    <div
      style={{
        flex: '1 1 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: tone === 'crit' ? 'var(--red)' : 'var(--ink-dim)',
        fontSize: 11,
        fontFamily: 'var(--mono)',
        padding: '10px 4px',
        textAlign: 'center',
        letterSpacing: '0.08em',
      }}
    >
      {text}
    </div>
  );
}
