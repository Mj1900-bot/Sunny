/**
 * AgentsPanel — live view of the main agent plus all sub-agents Rust has
 * spawned on `sunny://agent.sub`. Subscribes to `useSubAgentsLive` for the
 * fan-out and `useAgentStore` for the main run. Newest agents render at the
 * top; running agents get an amber pulsing dot and a live duration counter.
 *
 * The panel is rendered in the Overview grid slot previously occupied by
 * CalendarPanel. `id="p-cal"` is preserved so the CSS layout rules for that
 * slot (position, width, height, responsive hide on module pages) continue
 * to apply without touching sunny.css.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Panel } from './Panel';
import { useAgentStore, type AgentRunStatus } from '../store/agent';
import {
  useSubAgentsLive,
  type SubAgent,
  type SubAgentRole,
  type SubAgentStatus,
  type SubAgentStep,
} from '../store/subAgentsLive';
import { useView } from '../store/view';
import { toast } from '../hooks/useToast';

type FilterMode = 'all' | 'running' | 'done' | 'error';

// ---------------------------------------------------------------------------
// Card row model — unifies the main agent and sub-agents under one shape so
// the render path doesn't need two code paths.
// ---------------------------------------------------------------------------

type CardRow = {
  readonly id: string;
  readonly role: string;
  readonly task: string;
  readonly model: string;
  readonly status: SubAgentStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly toolCallCount: number;
  readonly tokenEstimate: number;
  readonly steps: ReadonlyArray<SubAgentStep>;
  readonly isMain: boolean;
  readonly errorText?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEP_LINE_MAX = 80;
const MAX_TAIL_STEPS = 3;

const ROLE_ICON: Readonly<Record<SubAgentRole | 'main', string>> = {
  main: '◆',
  researcher: '⌕',
  coder: '⟨⟩',
  writer: '✎',
  browser_driver: '◎',
  planner: '◇',
  summarizer: '≡',
  critic: '!',
  unknown: '·',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLine(text: string, max: number = STEP_LINE_MAX): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}\u2026`;
}

function mapMainStatus(status: AgentRunStatus): SubAgentStatus {
  if (status === 'running') return 'running';
  if (status === 'done') return 'done';
  if (status === 'error' || status === 'aborted') return 'error';
  // 'idle' has no card of its own — filtered out before this maps.
  return 'done';
}

/**
 * Reuse the main agent's `PlanStep[]` as a `SubAgentStep[]` tail. The kinds
 * match up for our four visible categories; `plan` and `message` both
 * collapse to `thinking` for presentation.
 */
function mainStepsAsTail(
  steps: ReadonlyArray<{
    readonly kind: string;
    readonly text: string;
    readonly toolName?: string;
    readonly at: number;
  }>,
): ReadonlyArray<SubAgentStep> {
  return steps.map(s => {
    const k = s.kind;
    if (k === 'tool_call' || k === 'tool_result' || k === 'error') {
      return { at: s.at, kind: k, text: s.text, toolName: s.toolName };
    }
    return { at: s.at, kind: 'thinking', text: s.text };
  });
}

function formatDuration(ms: number): string {
  if (ms < 0) return '0.0s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs.toString().padStart(2, '0')}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function stepColor(kind: SubAgentStep['kind'], newest: boolean): string {
  if (kind === 'error') return 'var(--red)';
  if (newest) return 'var(--cyan-2)';
  return 'var(--ink-dim)';
}

function stepPrefix(step: SubAgentStep): string {
  if (step.kind === 'tool_call') {
    return step.toolName ? `→ ${step.toolName}(` : '→ ';
  }
  if (step.kind === 'tool_result') {
    return step.toolName ? `← ${step.toolName}: ` : '← ';
  }
  if (step.kind === 'error') return '✗ ';
  return '· ';
}

function roleIcon(role: string): string {
  if (role === 'main') return ROLE_ICON.main;
  const r = role as SubAgentRole;
  return ROLE_ICON[r] ?? ROLE_ICON.unknown;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { readonly status: SubAgentStatus }): ReactElement {
  if (status === 'running') {
    return (
      <span style={badgeStyle('var(--amber)')}>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--amber)',
            boxShadow: '0 0 6px var(--amber)',
            animation: 'sunny-pulse 1.2s ease-in-out infinite',
          }}
        />
        RUNNING
      </span>
    );
  }
  if (status === 'done') {
    return <span style={badgeStyle('var(--green)')}>DONE</span>;
  }
  return <span style={badgeStyle('var(--red)')}>ERROR</span>;
}

function badgeStyle(color: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontFamily: 'var(--display)',
    fontSize: 9.5,
    letterSpacing: '0.18em',
    fontWeight: 700,
    color,
    textTransform: 'uppercase',
  };
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

function AgentCard({
  row,
  now,
}: {
  readonly row: CardRow;
  readonly now: number;
}): ReactElement {
  const elapsedMs =
    row.status === 'running' ? now - row.startedAt : (row.endedAt ?? row.startedAt) - row.startedAt;
  const duration = formatDuration(elapsedMs);

  // Most-recent first; cap at MAX_TAIL_STEPS.
  const tail = useMemo(() => {
    const all = row.steps;
    const slice = all.slice(Math.max(0, all.length - MAX_TAIL_STEPS));
    return [...slice].reverse();
  }, [row.steps]);

  return (
    <div
      style={{
        border: '1px solid var(--line-soft, rgba(57, 229, 255, 0.18))',
        borderLeft: `2px ${row.status === 'running' ? 'dashed' : row.status === 'error' ? 'double' : 'solid'} ${row.isMain ? 'var(--cyan)' : row.status === 'running' ? 'var(--amber)' : row.status === 'error' ? 'var(--red)' : 'var(--green)'}`,
        padding: '6px 8px 8px',
        background: 'rgba(57, 229, 255, 0.035)',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      {/* Header: role + task + status + duration */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          <span
            aria-hidden
            style={{
              fontFamily: 'var(--display)',
              color: 'var(--cyan)',
              fontSize: 11,
              width: 14,
              textAlign: 'center',
            }}
          >
            {roleIcon(row.isMain ? 'main' : row.role)}
          </span>
          <span
            style={{
              fontFamily: 'var(--display)',
              fontSize: 10.5,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'var(--cyan)',
              fontWeight: 700,
            }}
          >
            {row.isMain ? 'MAIN' : row.role.replace(/_/g, ' ')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: row.status === 'running' ? 'var(--amber)' : row.status === 'error' ? 'var(--red)' : 'var(--green)',
            }}
          >
            {row.status === 'running' ? '◎' : row.status === 'error' ? '✕' : '✓'}
          </span>
          <StatusBadge status={row.status} />
          <span
            style={{
              color: 'var(--ink-2)',
              fontSize: 10.5,
              fontFamily: 'var(--display)',
              letterSpacing: '0.08em',
              minWidth: 36,
              textAlign: 'right',
            }}
          >
            {duration}
          </span>
        </div>
      </div>

      {/* Task line */}
      <div
        style={{
          color: 'var(--ink-1, #cde7f1)',
          fontSize: 11.5,
          lineHeight: 1.35,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={row.task}
      >
        “{row.task || '(no task)'}”
      </div>

      {/* Meta row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          color: 'var(--ink-dim)',
          fontSize: 10,
          letterSpacing: '0.04em',
        }}
      >
        <span>model: <span style={{ color: 'var(--ink-2)' }}>{row.model || 'unknown'}</span></span>
        <span>tools: <span style={{ color: 'var(--ink-2)' }}>{row.toolCallCount}</span></span>
        <span>≈<span style={{ color: 'var(--ink-2)' }}>{formatTokens(row.tokenEstimate)}</span> tok</span>
      </div>

      {/* Divider */}
      <div
        style={{
          height: 1,
          background: 'rgba(57, 229, 255, 0.12)',
          margin: '2px 0',
        }}
      />

      {/* Step tail */}
      {tail.length === 0 ? (
        <div style={{ color: 'var(--ink-dim)', fontSize: 10.5, fontStyle: 'italic' }}>
          {row.status === 'running' ? 'awaiting first step…' : 'no steps recorded'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tail.map((s, idx) => {
            const newest = idx === 0;
            return (
              <div
                key={`${s.at}-${idx}`}
                style={{
                  color: stepColor(s.kind, newest && row.status === 'running'),
                  fontSize: 10.5,
                  lineHeight: 1.35,
                  fontFamily: 'var(--mono, monospace)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  opacity: newest ? 1 : 0.75,
                }}
                title={`${stepPrefix(s)}${s.text}`}
              >
                {clampLine(`${stepPrefix(s)}${s.text}`)}
              </div>
            );
          })}
        </div>
      )}

      {/* Error/answer tail for finished agents */}
      {row.status === 'error' && row.errorText && (
        <div
          style={{
            color: 'var(--red)',
            fontSize: 10.5,
            marginTop: 2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={row.errorText}
        >
          error: {row.errorText}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Idle state
// ---------------------------------------------------------------------------

function IdleState({ recent }: { readonly recent: RecentEcho | null }): ReactElement {
  return (
    <div
      style={{
        margin: 'auto',
        textAlign: 'center',
        padding: '16px 8px',
        color: 'var(--ink-dim)',
        fontSize: 11.5,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--display)',
          letterSpacing: '0.3em',
          color: 'var(--ink-dim)',
          fontSize: 12,
          fontWeight: 700,
          marginBottom: 6,
        }}
      >
        NO AGENTS ACTIVE
      </div>
      {recent ? (
        <div
          style={{
            color: 'var(--cyan-2, var(--ink-2))',
            fontFamily: 'var(--mono, monospace)',
            fontSize: 10.5,
            marginBottom: 6,
            opacity: 0.85,
          }}
        >
          last: {recent.role.replace(/_/g, ' ')} · {recent.secondsAgo}s ago
        </div>
      ) : null}
      <div style={{ color: 'var(--ink-dim)', fontSize: 10.5 }}>
        Ask SUNNY to “research X” or “draft an email about Y” to spawn one.
      </div>
    </div>
  );
}

type RecentEcho = {
  readonly role: string;
  readonly secondsAgo: number;
};

const RECENT_WINDOW_MS = 30_000;

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AgentsPanel(): ReactElement {
  const mainStatus = useAgentStore(s => s.status);
  const mainGoal = useAgentStore(s => s.goal);
  const mainSteps = useAgentStore(s => s.steps);
  const mainStartedAt = useAgentStore(s => s.startedAt);
  const mainAnswer = useAgentStore(s => s.finalAnswer);
  const abortMain = useAgentStore(s => s.requestAbort);

  const subAgents = useSubAgentsLive(s => s.subAgents);
  const order = useSubAgentsLive(s => s.order);
  const clearSubAgents = useSubAgentsLive(s => s.clear);

  const { dockHidden } = useView();
  const [filter, setFilter] = useState<FilterMode>('all');

  // Keep-alive tick for the running-duration counter. Runs only when at
  // least one agent is live so an idle panel costs zero CPU.
  const [now, setNow] = useState<number>(() => Date.now());
  const anyRunning = useMemo(() => {
    if (mainStatus === 'running') return true;
    for (const id of order) {
      const r = subAgents[id];
      if (r && r.status === 'running') return true;
    }
    return false;
  }, [mainStatus, order, subAgents]);

  useEffect(() => {
    if (!anyRunning) return undefined;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [anyRunning]);

  // Track most-recently-terminated sub-agent so the idle state can show
  // "last: <role> · <Ns> ago" for RECENT_WINDOW_MS after the last completion.
  const lastFinishedRef = useRef<{ readonly role: string; readonly at: number } | null>(null);
  useEffect(() => {
    let latestRole: string | null = null;
    let latestAt = 0;
    for (const id of order) {
      const a = subAgents[id];
      if (!a) continue;
      if (a.status !== 'done' && a.status !== 'error') continue;
      const endedAt = a.endedAt ?? a.startedAt;
      if (endedAt > latestAt) {
        latestAt = endedAt;
        latestRole = a.role;
      }
    }
    if (latestRole && latestAt > 0) {
      const prev = lastFinishedRef.current;
      if (!prev || latestAt > prev.at) {
        lastFinishedRef.current = { role: latestRole, at: latestAt };
      }
    }
  }, [subAgents, order]);

  // Keep ticking during the recent-window so seconds-ago updates every second.
  const recentActive =
    lastFinishedRef.current !== null &&
    now - lastFinishedRef.current.at < RECENT_WINDOW_MS;
  useEffect(() => {
    if (!recentActive || anyRunning) return undefined;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [recentActive, anyRunning]);

  const recentEcho: RecentEcho | null = useMemo(() => {
    const ref = lastFinishedRef.current;
    if (!ref) return null;
    const age = now - ref.at;
    if (age >= RECENT_WINDOW_MS) return null;
    return { role: ref.role, secondsAgo: Math.max(0, Math.floor(age / 1000)) };
  }, [now]);

  // Build rows — main first if present, then sub-agents newest-first.
  const rows = useMemo<ReadonlyArray<CardRow>>(() => {
    const out: CardRow[] = [];
    if (mainStatus !== 'idle' && mainStartedAt !== null) {
      const tail = mainStepsAsTail(mainSteps);
      const toolCalls = mainSteps.reduce(
        (acc, s) => (s.kind === 'tool_call' ? acc + 1 : acc),
        0,
      );
      const chars = mainSteps.reduce((acc, s) => acc + s.text.length, 0);
      out.push({
        id: '__main__',
        role: 'main',
        task: mainGoal,
        model: 'sunny.main',
        status: mapMainStatus(mainStatus),
        startedAt: mainStartedAt,
        endedAt: mainStatus === 'running' ? null : mainStartedAt + (now - mainStartedAt),
        toolCallCount: toolCalls,
        tokenEstimate: Math.max(0, Math.round(chars / 4)),
        steps: tail,
        isMain: true,
        errorText: mainStatus === 'error' ? mainAnswer || undefined : undefined,
      });
    }
    // Sub-agents newest first (order is insertion; reverse for display).
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const id = order[i];
      if (!id) continue;
      const a = subAgents[id];
      if (!a) continue;
      out.push(subAgentToRow(a));
    }
    return out;
  }, [mainStatus, mainStartedAt, mainGoal, mainSteps, mainAnswer, order, subAgents, now]);

  const stats = useMemo(() => {
    let running = 0, done = 0, error = 0, tools = 0, tokens = 0;
    for (const r of rows) {
      if (r.status === 'running') running += 1;
      else if (r.status === 'done') done += 1;
      else if (r.status === 'error') error += 1;
      tools += r.toolCallCount;
      tokens += r.tokenEstimate;
    }
    return { running, done, error, tools, tokens };
  }, [rows]);

  const visibleRows = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter(r => r.status === filter);
  }, [rows, filter]);

  const badge = useMemo(() => {
    if (stats.running > 0) return `${stats.running} RUNNING · ${rows.length} TOTAL`;
    return `${rows.length} TOTAL`;
  }, [stats.running, rows.length]);

  const onClearDone = () => {
    const terminal = rows.filter(r => !r.isMain && (r.status === 'done' || r.status === 'error')).length;
    if (terminal === 0) {
      toast.info('No completed sub-agents to clear');
      return;
    }
    clearSubAgents(0);
    toast.success(`Cleared ${terminal} sub-agent${terminal === 1 ? '' : 's'}`);
  };

  const onAbortMain = () => {
    if (mainStatus !== 'running') { toast.info('Main agent is not running'); return; }
    abortMain();
    toast.info('Main agent abort requested');
  };

  return (
    <Panel
      id="p-cal"
      title="AGENTS · LIVE"
      right={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: anyRunning ? 'var(--amber)' : undefined,
            transition: 'color 0.3s ease',
          }}
        >
          {anyRunning && (
            <span
              aria-hidden
              title="Agents running"
              style={{
                display: 'inline-block',
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: 'var(--amber)',
                boxShadow: '0 0 8px var(--amber)',
                animation: 'sunny-pulse 1.2s ease-in-out infinite',
              }}
            />
          )}
          {mainStatus === 'running' && (
            <button
              type="button"
              onClick={onAbortMain}
              className="hdr-chip"
              style={{ color: 'var(--red)' }}
              aria-label="Abort main agent"
              title="Abort main agent"
            >
              ABORT
            </button>
          )}
          {rows.some(r => !r.isMain && (r.status === 'done' || r.status === 'error')) && (
            <button
              type="button"
              onClick={onClearDone}
              className="hdr-chip"
              title="Clear completed sub-agents"
            >
              CLEAR
            </button>
          )}
          <span>{badge}</span>
        </span>
      }
    >
      {/* Scoped keyframes for the running dot. */}
      <style>{pulseKeyframes}</style>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          height: '100%',
        }}
      >
        {rows.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
              paddingBottom: 6,
              borderBottom: '1px solid var(--line-soft)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', gap: 4 }}>
              <FilterChip label="ALL" count={rows.length} active={filter === 'all'} onClick={() => setFilter('all')} />
              <FilterChip label="RUN" count={stats.running} active={filter === 'running'} onClick={() => setFilter('running')} color="var(--amber)" />
              <FilterChip label="DONE" count={stats.done} active={filter === 'done'} onClick={() => setFilter('done')} color="var(--green)" />
              {stats.error > 0 && (
                <FilterChip label="ERR" count={stats.error} active={filter === 'error'} onClick={() => setFilter('error')} color="var(--red)" />
              )}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 8,
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                color: 'var(--ink-dim)',
                letterSpacing: '0.06em',
              }}
              title={`${stats.tools} tool calls · ~${stats.tokens} tokens`}
            >
              <span>{stats.tools}<span style={{ opacity: 0.6 }}>t</span></span>
              <span>≈{formatTokens(stats.tokens)}<span style={{ opacity: 0.6 }}>tok</span></span>
            </div>
          </div>
        )}

        {/* aria-live polite: announces new agent cards and status changes to screen readers */}
        <div aria-live="polite" aria-atomic="false" style={{ position: 'absolute', left: -9999, top: -9999, width: 1, height: 1, overflow: 'hidden' }}>
          {anyRunning ? 'Agents running' : 'No agents active'}
        </div>
        {rows.length === 0 ? (
          <IdleState recent={recentEcho} />
        ) : visibleRows.length === 0 ? (
          <div style={{ padding: '12px 8px', color: 'var(--ink-dim)', fontSize: 11, textAlign: 'center' }}>
            no agents match filter
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflow: dockHidden ? 'auto' : 'hidden', flex: '1 1 auto' }}>
            {visibleRows.map(row => <AgentCard key={row.id} row={row} now={now} />)}
          </div>
        )}
      </div>
    </Panel>
  );
}

function FilterChip({
  label, count, active, onClick, color,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly color?: string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="agents-filter-chip"
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '2px 6px',
        fontFamily: 'var(--display)',
        fontSize: 9,
        letterSpacing: '0.2em',
        fontWeight: 700,
        color: active ? (color ?? 'var(--cyan)') : 'var(--ink-dim)',
        border: `1px solid ${active ? (color ?? 'var(--cyan)') : 'var(--line-soft)'}`,
        background: active ? 'rgba(57,229,255,0.12)' : 'transparent',
      }}
    >
      {label}
      <span style={{ opacity: 0.7, marginLeft: 4 }}>{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subAgentToRow(a: SubAgent): CardRow {
  return {
    id: a.id,
    role: a.role,
    task: a.task,
    model: a.model,
    status: a.status,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    toolCallCount: a.toolCallCount,
    tokenEstimate: a.tokenEstimate,
    steps: a.steps,
    isMain: false,
    errorText: a.error,
  };
}

// Injected once per mount — cheap enough, keyframes merge on re-render.
const pulseKeyframes = `
@keyframes sunny-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(0.82); }
}
`;
