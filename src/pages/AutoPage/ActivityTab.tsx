import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSubAgents, type SubAgentRun, type SubAgentStatus } from '../../store/subAgents';
import { lastRunRelative, useDaemons, type Daemon } from '../../store/daemons';
import { SectionHeader } from './SectionHeader';
import { ghostBtn, staticChip } from './styles';

// ---------------------------------------------------------------------------
// Activity tab — the "AI is doing things right now" view.
//
// Three sections with timeline visualization:
//   1. LIVE RUNS   — active sub-agents with step progress
//   2. RECENT FIRES — daemon fires grouped by time period
//   3. COMPLETED    — finished sub-agent runs
// ---------------------------------------------------------------------------

const POLL_MS = 3000;

/** Group entries by time period. */
function timeGroup(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'JUST NOW';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} MINUTES AGO`;
  if (diff < 86400_000) return 'TODAY';
  if (diff < 172800_000) return 'YESTERDAY';
  return 'EARLIER';
}

export function ActivityTab() {
  const runs = useSubAgents(s => s.runs);
  const daemons = useDaemons(s => s.list);
  const refreshDaemons = useDaemons(s => s.refresh);

  useEffect(() => {
    void refreshDaemons();
    const id = window.setInterval(() => void refreshDaemons(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshDaemons]);

  const activeRuns = useMemo(() => {
    return [...runs]
      .filter(r => r.status === 'queued' || r.status === 'running')
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [runs]);

  const recentRuns = useMemo(() => {
    return [...runs]
      .filter(r => r.status !== 'queued' && r.status !== 'running')
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 12);
  }, [runs]);

  // Daemons sorted by most-recent activity (fire or schedule).
  const fireLog = useMemo(() => {
    return [...daemons]
      .filter(d => d.last_run !== null)
      .sort((a, b) => (b.last_run ?? 0) - (a.last_run ?? 0))
      .slice(0, 10);
  }, [daemons]);

  // Group fires by time period
  const groupedFires = useMemo(() => {
    const groups = new Map<string, Daemon[]>();
    for (const d of fireLog) {
      const group = timeGroup((d.last_run ?? 0) * 1000);
      const existing = groups.get(group) ?? [];
      groups.set(group, [...existing, d]);
    }
    return groups;
  }, [fireLog]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* LIVE section */}
      <section style={{ animation: 'fadeSlideIn 200ms ease-out' }}>
        <SectionHeader
          label="LIVE RUNS"
          count={activeRuns.length}
          tone={activeRuns.length > 0 ? 'cyan' : 'amber'}
          right={
            activeRuns.length > 0 ? (
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '0.2em',
                  color: 'var(--cyan)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--cyan)',
                    boxShadow: '0 0 8px var(--cyan)',
                    animation: 'pulseDot 1.4s infinite',
                  }}
                />
                STREAMING
              </span>
            ) : null
          }
        />
        {activeRuns.length === 0 ? (
          <div style={dimBox}>
            Nothing running right now. Daemons fire on their schedule or events;
            sub-agents spawn from chat or tools.
          </div>
        ) : (
          <div className="timeline-connector" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {activeRuns.map((r, i) => (
              <RunRow
                key={r.id}
                run={r}
                daemon={findDaemonForRun(daemons, r)}
                live
                isLast={i === activeRuns.length - 1}
              />
            ))}
          </div>
        )}
      </section>

      {/* FIRES section with time grouping */}
      <section style={{ animation: 'fadeSlideIn 300ms ease-out' }}>
        <SectionHeader label="RECENT FIRES" count={fireLog.length} tone="amber" />
        {fireLog.length === 0 ? (
          <div style={dimBox}>
            No daemon has fired yet. Install one from the AGENTS tab or give it a few minutes.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
            {[...groupedFires.entries()].map(([group, items]) => (
              <div key={group}>
                <div style={timeGroupLabelStyle}>{group}</div>
                <div className="timeline-connector" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  {items.map((d, i) => (
                    <FireRow key={d.id} daemon={d} isLast={i === items.length - 1} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* HISTORY section */}
      <section style={{ animation: 'fadeSlideIn 400ms ease-out' }}>
        <SectionHeader
          label="COMPLETED SUB-AGENTS"
          count={recentRuns.length}
          tone="green"
          right={
            recentRuns.length > 0 ? (
              <ClearFinishedBtn />
            ) : null
          }
        />
        {recentRuns.length === 0 ? (
          <div style={dimBox}>
            Nothing finished recently. Completed sub-agent runs will accumulate here.
          </div>
        ) : (
          <div className="timeline-connector" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {recentRuns.map((r, i) => (
              <RunRow
                key={r.id}
                run={r}
                daemon={findDaemonForRun(daemons, r)}
                isLast={i === recentRuns.length - 1}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function RunRow({
  run,
  daemon,
  live,
  isLast,
}: {
  run: SubAgentRun;
  daemon: Daemon | null;
  live?: boolean;
  isLast?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = statusColor(run.status);
  const elapsed = elapsedString(run);

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        borderLeft: `3px solid ${color}`,
        background: live
          ? 'linear-gradient(90deg, rgba(57, 229, 255, 0.10), transparent 60%)'
          : 'rgba(6, 14, 22, 0.4)',
        marginLeft: isLast ? 0 : 0,
        animation: 'fadeSlideIn 200ms ease-out',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(x => !x)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(x => !x);
          }
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: '100px 1fr auto auto',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            ...staticChip(color),
            padding: '2px 8px',
            fontSize: 9.5,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            justifySelf: 'start',
          }}
        >
          {live && (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: color,
                boxShadow: `0 0 8px ${color}`,
                animation: 'pulseDot 1.4s infinite',
              }}
            />
          )}
          {run.status.toUpperCase()}
        </span>
        <div style={{ overflow: 'hidden' }}>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--ink)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={run.goal}
          >
            {run.goal || '(no goal)'}
          </div>
          {(() => {
            const depth = depthOf(run);
            const breadcrumbs: string[] = [];
            if (daemon) breadcrumbs.push(`daemon: ${daemon.title}`);
            if (depth > 0) breadcrumbs.push(`sub-agent depth ${depth}`);
            if (breadcrumbs.length === 0) return null;
            return (
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--cyan-3)',
                  letterSpacing: '0.1em',
                  marginTop: 2,
                  display: 'inline-flex',
                  gap: 8,
                }}
              >
                {/* Small indent pin so fan-out children read as a group. */}
                {depth > 0 && (
                  <span aria-hidden style={{ color: 'var(--violet)', opacity: 0.8 }}>
                    {'↳ '.repeat(Math.min(depth, 3))}
                  </span>
                )}
                <span>▸ {breadcrumbs.join(' · ')}</span>
              </div>
            );
          })()}
          {/* Live step progress bar */}
          {live && run.steps.length > 0 && (
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={progressBarTrack}>
                <div
                  style={{
                    ...progressBarFill,
                    width: `${Math.min(100, (run.steps.length / 8) * 100)}%`,
                  }}
                />
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)' }}>
                {run.steps.length}/8 steps
              </span>
            </div>
          )}
        </div>
        <span style={metaBit}>{run.steps.length} STEP{run.steps.length === 1 ? '' : 'S'}</span>
        <span style={metaBit}>{elapsed}</span>
      </div>

      {expanded && run.finalAnswer.length > 0 && (
        <div
          style={{
            borderTop: '1px solid var(--line-soft)',
            padding: '10px 14px',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink-2)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'rgba(2, 6, 10, 0.55)',
            maxHeight: 260,
            overflow: 'auto',
            animation: 'fadeSlideIn 150ms ease-out',
          }}
        >
          {run.finalAnswer}
        </div>
      )}
    </div>
  );
}

function FireRow({ daemon, isLast: _isLast }: { daemon: Daemon; isLast?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const color =
    daemon.last_status === 'done' ? 'var(--green)' :
    daemon.last_status === 'aborted' ? 'var(--amber)' :
    daemon.last_status === 'error' ? 'var(--red)' :
    'var(--cyan)';
  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        borderLeft: `3px solid ${color}`,
        background: 'rgba(6, 14, 22, 0.4)',
        animation: 'fadeSlideIn 200ms ease-out',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(x => !x)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(x => !x);
          }
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: '90px 1fr auto auto',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          cursor: 'pointer',
        }}
      >
        <span style={{ ...staticChip(color), padding: '2px 8px', fontSize: 9.5 }}>
          {(daemon.last_status ?? '—').toUpperCase()}
        </span>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--ink)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={daemon.title}
        >
          {daemon.title}
        </div>
        <span style={metaBit}>
          {daemon.runs_count} run{daemon.runs_count === 1 ? '' : 's'}
        </span>
        <span style={metaBit}>{lastRunRelative(daemon.last_run)}</span>
      </div>
      {expanded && daemon.last_output && (
        <div
          style={{
            borderTop: '1px solid var(--line-soft)',
            padding: '10px 14px',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink-2)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'rgba(2, 6, 10, 0.55)',
            maxHeight: 220,
            overflow: 'auto',
            animation: 'fadeSlideIn 150ms ease-out',
          }}
        >
          {daemon.last_output}
        </div>
      )}
    </div>
  );
}

function ClearFinishedBtn() {
  const clearFinished = useSubAgents(s => s.clearFinished);
  return (
    <button
      onClick={clearFinished}
      style={{ ...ghostBtn, fontSize: 10, padding: '4px 10px' }}
    >
      CLEAR FINISHED
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusColor(status: SubAgentStatus): string {
  switch (status) {
    case 'queued': return 'var(--ink-dim)';
    case 'running': return 'var(--cyan)';
    case 'done': return 'var(--green)';
    case 'aborted': return 'var(--amber)';
    case 'error': return 'var(--red)';
    case 'max_steps': return 'var(--amber)';
  }
}

function elapsedString(run: SubAgentRun): string {
  if (run.status === 'queued') return 'queued';
  const start = run.startedAt ?? run.createdAt;
  const end = run.endedAt ?? Date.now();
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

/**
 * Extract a daemon id from a parent label.
 */
function findDaemonForRun(daemons: ReadonlyArray<Daemon>, run: SubAgentRun): Daemon | null {
  if (!run.parent) return null;
  const match = run.parent.match(/^daemon:([^@]+)/);
  if (!match) return null;
  const id = match[1];
  return daemons.find(d => d.id === id) ?? null;
}

/**
 * Delegation depth of this run (0 = root).
 */
function depthOf(run: SubAgentRun): number {
  if (!run.parent) return 0;
  let max = 0;
  for (const m of run.parent.matchAll(/@depth:(\d+)/g)) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const dimBox: CSSProperties = {
  border: '1px dashed var(--line-soft)',
  padding: '20px 14px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
  letterSpacing: '0.08em',
  lineHeight: 1.6,
  marginTop: 8,
};

const metaBit: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  letterSpacing: '0.1em',
  whiteSpace: 'nowrap',
};

const timeGroupLabelStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 8,
  letterSpacing: '0.28em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
  padding: '2px 8px',
  background: 'rgba(57, 229, 255, 0.04)',
  border: '1px solid var(--line-soft)',
  display: 'inline-block',
};

const progressBarTrack: CSSProperties = {
  flex: 1,
  maxWidth: 100,
  height: 3,
  background: 'rgba(57, 229, 255, 0.12)',
  borderRadius: 2,
  overflow: 'hidden',
};

const progressBarFill: CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg, var(--cyan), var(--cyan-2))',
  borderRadius: 2,
  boxShadow: '0 0 6px var(--cyan)',
  transition: 'width 500ms ease',
};
