import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  useAgentHistory,
  type HistoryRun,
  type HistoryRunStatus,
  type HistoryStep,
} from '../../store/agentHistory';

// ---------------------------------------------------------------------------
// HistoryTab — formerly the standalone HISTORY module, now a tab of
// MEMORY. Shows every completed agent run with expandable step timeline.
// Consolidated because agent runs are just episodic memory with richer
// structure — the user thinks of both as "what's happened in SUNNY".
// ---------------------------------------------------------------------------

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'JUST NOW';
  if (mins < 60) return `${mins}M AGO`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}H AGO`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}D AGO`;
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}MS`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}S`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs - mins * 60);
  return `${mins}M ${rem}S`;
}

function fmtOffset(ms: number): string {
  if (ms < 1000) return `+${ms}MS`;
  return `+${(ms / 1000).toFixed(1)}S`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

const STATUS_COLOR: Record<HistoryRunStatus, string> = {
  done: 'var(--cyan)',
  aborted: '#ffb347',
  error: '#ff6a6a',
  max_steps: '#ffb347',
};

const chipStyle = (status: HistoryRunStatus): CSSProperties => ({
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
  minWidth: 72,
  justifyContent: 'center',
});

const baseButtonStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 10px',
  border: '1px solid var(--line-soft)',
  color: 'var(--ink-dim)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  color: '#ff6a6a',
  borderColor: '#ff6a6a',
};

const rowShellStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.4)',
  marginBottom: 8,
};

const rowHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '86px 1fr auto auto auto auto',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  cursor: 'pointer',
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

const emptyStateStyle: CSSProperties = {
  border: '1px dashed var(--line-soft)',
  padding: '48px 16px',
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.18em',
  color: 'var(--ink-dim)',
  lineHeight: 1.7,
};

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

type StepRowProps = {
  readonly step: HistoryStep;
  readonly runStartedAt: number;
};

function StepRow({ step, runStartedAt }: StepRowProps) {
  const icon = STEP_KIND_ICON[step.kind] ?? '·';
  const color = STEP_KIND_COLOR[step.kind] ?? 'var(--ink)';
  const offset = step.at - runStartedAt;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 70px 1fr auto',
        gap: 10,
        padding: '6px 0',
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
        }}
      >
        {step.kind.replace('_', ' ')}
      </span>
      <span style={{ color: 'var(--ink)', wordBreak: 'break-word' }}>
        {step.toolName !== undefined && step.toolName.length > 0 && (
          <span
            style={{
              color: '#8ec9ff',
              marginRight: 6,
              letterSpacing: '0.08em',
            }}
          >
            {step.toolName}
          </span>
        )}
        {step.text}
      </span>
      <span
        style={{
          color: 'var(--ink-dim)',
          fontSize: 9.5,
          letterSpacing: '0.1em',
          whiteSpace: 'nowrap',
          paddingTop: 2,
        }}
      >
        {fmtOffset(offset)}
      </span>
    </div>
  );
}

type RunRowProps = {
  readonly run: HistoryRun;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
  readonly deleteArmed: boolean;
};

function RunRow({
  run,
  isExpanded,
  onToggle,
  onDelete,
  deleteArmed,
}: RunRowProps) {
  const duration = run.endedAt - run.startedAt;

  return (
    <div style={rowShellStyle}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={rowHeaderStyle}
      >
        <span style={chipStyle(run.status)}>
          {run.status.replace('_', ' ')}
        </span>
        <span
          style={{
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={run.goal}
        >
          {run.goal.length > 0 ? truncate(run.goal, 90) : '(no goal)'}
        </span>
        <span style={metaBitStyle}>{fmtDuration(duration)}</span>
        <span style={metaBitStyle}>
          {run.steps.length} STEP{run.steps.length === 1 ? '' : 'S'}
        </span>
        <span style={metaBitStyle}>{fmtRelative(run.startedAt)}</span>
        <button
          onClick={e => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={deleteArmed ? 'Confirm delete run' : 'Delete run'}
          style={deleteArmed ? dangerButtonStyle : baseButtonStyle}
        >
          {deleteArmed ? 'CONFIRM' : 'DELETE'}
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
          {run.finalAnswer.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div
                style={{
                  fontFamily: 'var(--display)',
                  fontSize: 9.5,
                  letterSpacing: '0.22em',
                  color: 'var(--cyan)',
                  fontWeight: 700,
                  padding: '0 0 4px',
                }}
              >
                FINAL ANSWER
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: 'var(--ink)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {run.finalAnswer}
              </div>
            </div>
          )}

          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 9.5,
              letterSpacing: '0.22em',
              color: 'var(--cyan)',
              fontWeight: 700,
              padding: '6px 0 4px',
              borderTop: run.finalAnswer.length > 0
                ? '1px dashed rgba(57, 229, 255, 0.12)'
                : 'none',
              marginTop: run.finalAnswer.length > 0 ? 4 : 0,
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
              NO STEPS RECORDED
            </div>
          ) : (
            run.steps.map((s, idx) => (
              <StepRow
                key={`${run.id}-${idx}`}
                step={s}
                runStartedAt={run.startedAt}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

const CONFIRM_RESET_MS = 3000;

export function HistoryTab() {
  const runs = useAgentHistory(s => s.runs);
  const deleteRun = useAgentHistory(s => s.delete);
  const clearAll = useAgentHistory(s => s.clear);

  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const deleteTimer = useRef<number | null>(null);
  const clearTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return runs;
    return runs.filter(
      r =>
        r.goal.toLowerCase().includes(q) ||
        r.finalAnswer.toLowerCase().includes(q),
    );
  }, [runs, query]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(curr => (curr === id ? null : id));
  }, []);

  const handleDeleteRun = useCallback(
    (id: string) => {
      if (armedDeleteId === id) {
        if (deleteTimer.current !== null) {
          window.clearTimeout(deleteTimer.current);
          deleteTimer.current = null;
        }
        setArmedDeleteId(null);
        deleteRun(id);
        if (expandedId === id) setExpandedId(null);
        return;
      }
      setArmedDeleteId(id);
      if (deleteTimer.current !== null) {
        window.clearTimeout(deleteTimer.current);
      }
      deleteTimer.current = window.setTimeout(() => {
        setArmedDeleteId(null);
        deleteTimer.current = null;
      }, CONFIRM_RESET_MS);
    },
    [armedDeleteId, deleteRun, expandedId],
  );

  const handleClearAll = useCallback(() => {
    if (clearArmed) {
      if (clearTimer.current !== null) {
        window.clearTimeout(clearTimer.current);
        clearTimer.current = null;
      }
      setClearArmed(false);
      clearAll();
      setExpandedId(null);
      return;
    }
    setClearArmed(true);
    if (clearTimer.current !== null) {
      window.clearTimeout(clearTimer.current);
    }
    clearTimer.current = window.setTimeout(() => {
      setClearArmed(false);
      clearTimer.current = null;
    }, CONFIRM_RESET_MS);
  }, [clearArmed, clearAll]);

  if (runs.length === 0) {
    return (
      <div className="section">
        <div style={emptyStateStyle}>
          NO AGENT RUNS YET — ASK SUNNY SOMETHING USING ⌘K OR THE COMMAND BAR
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="section" style={{ paddingBottom: 4 }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="FILTER BY GOAL OR FINAL ANSWER…"
          aria-label="Filter agent runs"
          style={{ width: '100%' }}
        />
        <div
          style={{
            marginTop: 6,
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            color: 'var(--ink-dim)',
          }}
        >
          SHOWING {filtered.length} OF {runs.length}
        </div>
      </div>

      <div className="section" style={{ padding: 0 }}>
        <div style={{ padding: '0 12px' }}>
          {filtered.length === 0 ? (
            <div style={emptyStateStyle}>NO MATCHES FOR "{query}"</div>
          ) : (
            filtered.map(run => (
              <RunRow
                key={run.id}
                run={run}
                isExpanded={expandedId === run.id}
                onToggle={() => toggleExpand(run.id)}
                onDelete={() => handleDeleteRun(run.id)}
                deleteArmed={armedDeleteId === run.id}
              />
            ))
          )}
        </div>
      </div>

      <div
        className="section"
        style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}
      >
        <button
          onClick={handleClearAll}
          aria-label={clearArmed ? 'Confirm clear all runs' : 'Clear all runs'}
          style={clearArmed ? dangerButtonStyle : baseButtonStyle}
        >
          {clearArmed ? 'CONFIRM · CLEAR ALL' : 'CLEAR ALL'}
        </button>
      </div>
    </>
  );
}
