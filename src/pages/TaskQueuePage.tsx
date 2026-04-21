import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { ModuleView } from '../components/ModuleView';
import {
  useSubAgents,
  type SubAgentRun,
  type SubAgentStatus,
  type SubAgentStep,
} from '../store/subAgents';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIRM_RESET_MS = 3000;
const GOAL_TRUNCATE = 100;
const STEP_TEXT_TRUNCATE = 180;
const CONCURRENCY_CHOICES: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8];

type Filter = 'all' | 'queued' | 'running' | 'done' | 'error';

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'ALL' },
  { id: 'queued', label: 'QUEUED' },
  { id: 'running', label: 'RUNNING' },
  { id: 'done', label: 'DONE' },
  { id: 'error', label: 'ERROR' },
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}MS`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}S`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs - mins * 60);
  return `${mins}M ${rem.toString().padStart(2, '0')}S`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<SubAgentStatus, string> = {
  queued: 'var(--ink-dim)',
  running: '#ffb347',
  done: 'var(--cyan)',
  error: '#ff6a6a',
  aborted: '#ffb347',
  max_steps: '#ffb347',
};

const statusChipStyle = (status: SubAgentStatus): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  border: `1px solid ${STATUS_COLOR[status]}`,
  color: STATUS_COLOR[status],
  background: 'rgba(6, 14, 22, 0.4)',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  minWidth: 78,
  justifyContent: 'center',
  animation: status === 'running' ? 'taskqPulse 1.4s infinite' : undefined,
});

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const baseButtonStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 10px',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink-dim)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  whiteSpace: 'nowrap',
};

const primaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  color: 'var(--cyan)',
  borderColor: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.08)',
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  color: '#ff6a6a',
  borderColor: '#ff6a6a',
};

const amberButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  color: '#ffb347',
  borderColor: '#ffb347',
};

const chipBaseStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 12px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.04)',
  color: 'var(--ink-dim)',
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  letterSpacing: '0.12em',
};

const chipActiveStyle: CSSProperties = {
  ...chipBaseStyle,
  color: 'var(--cyan)',
  borderColor: 'var(--cyan)',
  background: 'rgba(57, 229, 255, 0.14)',
};

const emptyStateStyle: CSSProperties = {
  border: '1px dashed var(--line-soft)',
  padding: '48px 16px',
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.2em',
  color: 'var(--ink-dim)',
  lineHeight: 1.7,
};

const rowShellStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.4)',
  marginBottom: 8,
};

const rowHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '88px 1fr auto auto auto auto',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
};

const metaBitStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.12em',
  color: 'var(--ink-dim)',
  whiteSpace: 'nowrap',
};

// ---------------------------------------------------------------------------
// Step row (expanded view)
// ---------------------------------------------------------------------------

const STEP_KIND_ICON: Record<string, string> = {
  plan: '◆',
  tool_call: '▸',
  tool_result: '✓',
  message: '›',
  error: '✕',
};

const STEP_KIND_COLOR: Record<string, string> = {
  plan: 'var(--cyan)',
  tool_call: '#8ec9ff',
  tool_result: 'var(--cyan)',
  message: 'var(--ink)',
  error: '#ff6a6a',
};

function StepRow({ step }: { step: SubAgentStep }) {
  const icon = STEP_KIND_ICON[step.kind] ?? '·';
  const color = STEP_KIND_COLOR[step.kind] ?? 'var(--ink)';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 80px 1fr',
        gap: 10,
        padding: '5px 0',
        borderBottom: '1px dashed rgba(57, 229, 255, 0.08)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        lineHeight: 1.45,
        alignItems: 'start',
      }}
    >
      <span style={{ color, fontSize: 12, textAlign: 'center' }}>{icon}</span>
      <span
        style={{
          color: 'var(--ink-dim)',
          letterSpacing: '0.1em',
          fontSize: 9.5,
          textTransform: 'uppercase',
          paddingTop: 2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {step.kind.replace('_', ' ')}
      </span>
      <span style={{ color: 'var(--ink)', wordBreak: 'break-word' }}>
        {step.toolName !== undefined && step.toolName.length > 0 && (
          <span
            style={{
              display: 'inline-block',
              color: '#8ec9ff',
              marginRight: 8,
              padding: '1px 6px',
              border: '1px solid rgba(142, 201, 255, 0.3)',
              fontSize: 9.5,
              letterSpacing: '0.08em',
              verticalAlign: 'middle',
            }}
          >
            {step.toolName}
          </span>
        )}
        <span title={step.text}>{truncate(step.text, STEP_TEXT_TRUNCATE)}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run row
// ---------------------------------------------------------------------------

type RunRowProps = {
  readonly run: SubAgentRun;
  readonly now: number;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  readonly onAbort: () => void;
};

function RunRow({ run, now, isExpanded, onToggle, onAbort }: RunRowProps) {
  const canAbort = run.status === 'running' || run.status === 'queued';

  const elapsedMs = useMemo(() => {
    if (run.startedAt === null) return 0;
    if (run.endedAt !== null) return run.endedAt - run.startedAt;
    if (run.status === 'running') return now - run.startedAt;
    return 0;
  }, [run.startedAt, run.endedAt, run.status, now]);

  const goalDisplay = run.goal.length > 0 ? run.goal : '(no goal)';

  return (
    <div style={rowShellStyle}>
      <div style={rowHeaderStyle}>
        <span style={statusChipStyle(run.status)}>
          {run.status.replace('_', ' ')}
        </span>
        <span
          title={run.goal}
          style={{
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {truncate(goalDisplay, GOAL_TRUNCATE)}
        </span>
        <span style={metaBitStyle}>
          {run.status === 'queued' ? '—' : fmtElapsed(elapsedMs)}
        </span>
        <span style={metaBitStyle}>
          {run.steps.length} STEP{run.steps.length === 1 ? '' : 'S'}
        </span>
        {canAbort ? (
          <button
            onClick={onAbort}
            aria-label="Abort run"
            style={amberButtonStyle}
          >
            ABORT
          </button>
        ) : (
          <span style={{ width: 1 }} />
        )}
        <button
          onClick={onToggle}
          aria-label={isExpanded ? 'Collapse run' : 'Expand run'}
          aria-expanded={isExpanded}
          style={baseButtonStyle}
        >
          {isExpanded ? 'COLLAPSE' : 'EXPAND'}
        </button>
      </div>

      {isExpanded && (
        <div
          style={{
            borderTop: '1px solid var(--line-soft)',
            padding: '10px 14px 12px',
            background: 'rgba(6, 14, 22, 0.25)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 9.5,
              letterSpacing: '0.22em',
              color: 'var(--cyan)',
              fontWeight: 700,
              padding: '0 0 6px',
            }}
          >
            STEPS · {run.steps.length}
          </div>
          {run.steps.length === 0 ? (
            <div
              style={{
                color: 'var(--ink-dim)',
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                padding: '8px 0',
              }}
            >
              NO STEPS YET
            </div>
          ) : (
            run.steps.map((s, i) => <StepRow key={`${run.id}-${i}-${s.at}`} step={s} />)
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concurrency picker (popover)
// ---------------------------------------------------------------------------

type ConcurrencyPickerProps = {
  readonly value: number;
  readonly onChange: (n: number) => void;
};

function ConcurrencyPicker({ value, onChange }: ConcurrencyPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside click / Escape — keeps the popover unobtrusive.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        style={primaryButtonStyle}
      >
        MAX {value}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 10,
            display: 'flex',
            gap: 4,
            padding: 6,
            border: '1px solid var(--cyan)',
            background: 'rgba(6, 14, 22, 0.96)',
            boxShadow: '0 0 14px rgba(57, 229, 255, 0.25)',
          }}
        >
          {CONCURRENCY_CHOICES.map(n => {
            const active = n === value;
            return (
              <button
                key={n}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(n);
                  setOpen(false);
                }}
                style={{
                  ...(active ? chipActiveStyle : chipBaseStyle),
                  padding: '3px 9px',
                  minWidth: 26,
                  justifyContent: 'center',
                }}
              >
                {n}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TaskQueuePage() {
  // Granular selectors — each hook subscribes only to the slice it needs, so
  // unrelated state changes (e.g. expand toggle) don't re-render the list.
  const runs = useSubAgents(s => s.runs);
  const concurrency = useSubAgents(s => s.maxConcurrent);
  const spawn = useSubAgents(s => s.spawn);
  const abort = useSubAgents(s => s.abort);
  const abortAll = useSubAgents(s => s.abortAll);
  const clearFinished = useSubAgents(s => s.clearFinished);
  const setConcurrency = useSubAgents(s => s.setMaxConcurrent);

  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const [abortAllArmed, setAbortAllArmed] = useState(false);
  const abortAllTimer = useRef<number | null>(null);

  // Live ticker for elapsed-time display on running runs. A single interval
  // updates one scalar that RunRow consumes — avoids per-row timers and keeps
  // the list stable (no flicker from remounting).
  const [nowTick, setNowTick] = useState(() => Date.now());
  const hasRunning = useMemo(
    () => runs.some(r => r.status === 'running'),
    [runs],
  );

  useEffect(() => {
    if (!hasRunning) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  useEffect(() => () => {
    if (abortAllTimer.current !== null) {
      window.clearTimeout(abortAllTimer.current);
    }
  }, []);

  // Counts for header badge + filter chips.
  const { runningCount, queuedCount, doneCount, errorCount, finishedCount } =
    useMemo(() => {
      let running = 0;
      let queued = 0;
      let done = 0;
      let errored = 0;
      let finished = 0;
      for (const r of runs) {
        if (r.status === 'running') running += 1;
        else if (r.status === 'queued') queued += 1;
        else if (r.status === 'done') {
          done += 1;
          finished += 1;
        } else if (r.status === 'error') {
          errored += 1;
          finished += 1;
        } else if (r.status === 'aborted' || r.status === 'max_steps') {
          finished += 1;
        }
      }
      return {
        runningCount: running,
        queuedCount: queued,
        doneCount: done,
        errorCount: errored,
        finishedCount: finished,
      };
    }, [runs]);

  // Sorted (newest first) + filtered view of the runs.
  const visible = useMemo(() => {
    const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);
    if (filter === 'all') return sorted;
    if (filter === 'done') {
      return sorted.filter(
        r => r.status === 'done' || r.status === 'aborted' || r.status === 'max_steps',
      );
    }
    return sorted.filter(r => r.status === filter);
  }, [runs, filter]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    spawn(text);
    setDraft('');
  }, [draft, spawn]);

  const onInputKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const toggleExpand = useCallback((id: string) => {
    setExpanded(curr => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAbortAll = useCallback(() => {
    if (abortAllArmed) {
      if (abortAllTimer.current !== null) {
        window.clearTimeout(abortAllTimer.current);
        abortAllTimer.current = null;
      }
      setAbortAllArmed(false);
      abortAll();
      return;
    }
    setAbortAllArmed(true);
    if (abortAllTimer.current !== null) {
      window.clearTimeout(abortAllTimer.current);
    }
    abortAllTimer.current = window.setTimeout(() => {
      setAbortAllArmed(false);
      abortAllTimer.current = null;
    }, CONFIRM_RESET_MS);
  }, [abortAllArmed, abortAll]);

  const filterCount = (id: Filter): number => {
    switch (id) {
      case 'all':
        return runs.length;
      case 'queued':
        return queuedCount;
      case 'running':
        return runningCount;
      case 'done':
        return doneCount;
      case 'error':
        return errorCount;
      default:
        return 0;
    }
  };

  const badge = `${runningCount}/${runs.length} ACTIVE`;
  const activeAbortable = runningCount + queuedCount;

  return (
    <ModuleView title="TASK QUEUE" badge={badge}>
      {/* Pulse keyframes (scoped inline; avoids touching global CSS). */}
      <style>{`
        @keyframes taskqPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
      `}</style>

      {/* Spawn row */}
      <div className="section">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto auto',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="GOAL FOR NEW SUB-AGENT… (Enter to spawn)"
            aria-label="New sub-agent goal"
          />
          <button
            onClick={submit}
            disabled={draft.trim().length === 0}
            style={
              draft.trim().length === 0
                ? { ...primaryButtonStyle, opacity: 0.4, pointerEvents: 'none' }
                : primaryButtonStyle
            }
          >
            SPAWN
          </button>
          <ConcurrencyPicker value={concurrency} onChange={setConcurrency} />
        </div>
      </div>

      {/* Filter chips */}
      <div
        className="section"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
      >
        {FILTERS.map(f => {
          const active = f.id === filter;
          const count = filterCount(f.id);
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              aria-pressed={active}
              style={active ? chipActiveStyle : chipBaseStyle}
            >
              {f.label} {count.toString().padStart(2, '0')}
            </button>
          );
        })}
      </div>

      {/* Run list */}
      <div className="section" style={{ padding: 0 }}>
        <div style={{ padding: '0 12px' }}>
          {runs.length === 0 ? (
            <div style={emptyStateStyle}>
              NO SUB-AGENTS — SPAWN ONE ABOVE OR FROM A TOOL
            </div>
          ) : visible.length === 0 ? (
            <div style={emptyStateStyle}>NO RUNS MATCH FILTER</div>
          ) : (
            visible.map(run => (
              <RunRow
                key={run.id}
                run={run}
                now={nowTick}
                isExpanded={expanded.has(run.id)}
                onToggle={() => toggleExpand(run.id)}
                onAbort={() => abort(run.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Footer actions */}
      {runs.length > 0 && (
        <div
          className="section"
          style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}
        >
          <button
            onClick={clearFinished}
            disabled={finishedCount === 0}
            aria-label="Clear finished runs"
            style={
              finishedCount === 0
                ? { ...baseButtonStyle, opacity: 0.4, pointerEvents: 'none' }
                : baseButtonStyle
            }
          >
            CLEAR FINISHED ({finishedCount})
          </button>
          <button
            onClick={handleAbortAll}
            disabled={activeAbortable === 0 && !abortAllArmed}
            aria-label={abortAllArmed ? 'Confirm abort all' : 'Abort all'}
            style={
              abortAllArmed
                ? dangerButtonStyle
                : activeAbortable === 0
                  ? { ...baseButtonStyle, opacity: 0.4, pointerEvents: 'none' }
                  : amberButtonStyle
            }
          >
            {abortAllArmed ? 'CONFIRM · ABORT ALL' : `ABORT ALL (${activeAbortable})`}
          </button>
        </div>
      )}
    </ModuleView>
  );
}
