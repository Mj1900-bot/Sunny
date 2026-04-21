/**
 * FleetNode — recursive parent/child card for the agent tree.
 * Extracted from the monolithic index.tsx. Upgraded with:
 *  - Click to open transcript panel
 *  - Visual status indicator with glow
 *  - Staggered entrance animation
 *  - Progress indicator for running agents
 */

import { useState } from 'react';
import {
  Chip, Row, ToolbarButton, relTime,
} from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import type { SubAgent } from '../../store/subAgentsLive';

function durationMs(a: SubAgent): number {
  const end = a.endedAt ?? Date.now();
  return Math.max(0, end - a.startedAt);
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusTone(s: SubAgent['status']): 'green' | 'red' | 'violet' {
  if (s === 'running') return 'green';
  if (s === 'error') return 'red';
  return 'violet';
}

function agentClipText(a: SubAgent): string {
  const lines = [
    `[${a.status}] ${a.role} · ${a.id}`,
    a.model ? `model: ${a.model}` : '',
    a.task,
    `${a.tokenEstimate} tok · ${a.toolCallCount} tool calls · wall ${formatLatency(durationMs(a))}`,
  ];
  if (a.error) lines.push(`error: ${a.error}`);
  return lines.filter(Boolean).join('\n');
}

export function FleetNode({
  agent,
  depth,
  index,
  childrenOf,
  flash,
  onSelect,
}: {
  agent: SubAgent;
  depth: number;
  index: number;
  childrenOf: Map<string, SubAgent[]>;
  flash: (msg: string) => void;
  onSelect: (a: SubAgent) => void;
}) {
  const [taskOpen, setTaskOpen] = useState(false);
  const [errOpen, setErrOpen] = useState(false);
  const kids = childrenOf.get(agent.id) ?? [];
  const tone = statusTone(agent.status);
  const latency = formatLatency(durationMs(agent));
  const taskLong = agent.task.length > 160 || agent.task.split('\n').length > 2;
  const isRunning = agent.status === 'running';

  return (
    <div style={{
      marginLeft: depth > 0 ? 14 : 0,
      borderLeft: depth > 0 ? '1px dashed var(--line-soft)' : 'none',
      paddingLeft: depth > 0 ? 10 : 0,
      animation: `fadeSlideIn 300ms ease ${index * 40}ms both`,
    }}>
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        tabIndex={0}
        role="button"
        aria-label={`${agent.status} sub-agent ${agent.role}: ${agent.task}`}
        onClick={() => onSelect(agent)}
        style={{
          border: '1px solid var(--line-soft)',
          borderLeft: `3px solid var(--${tone})`,
          padding: '10px 14px',
          display: 'flex', flexDirection: 'column', gap: 5,
          outlineOffset: 2,
          cursor: 'pointer',
          position: 'relative',
          overflow: 'hidden',
          background: isRunning
            ? `linear-gradient(135deg, var(--${tone})08, transparent 60%)`
            : 'transparent',
          transition: 'background 180ms ease, border-color 180ms ease',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(57, 229, 255, 0.04)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = isRunning
            ? `linear-gradient(135deg, var(--${tone})08, transparent 60%)`
            : 'transparent';
        }}
        onFocus={e => { e.currentTarget.style.outline = '1px solid var(--cyan)'; }}
        onBlur={e => { e.currentTarget.style.outline = 'none'; }}
      >
        {/* Running indicator bar */}
        {isRunning && (
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: 2,
            background: 'rgba(57, 229, 255, 0.06)',
            overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', left: '-30%', top: 0, bottom: 0,
              width: '30%',
              background: `var(--${tone})`,
              boxShadow: `0 0 8px var(--${tone})`,
              animation: 'runningSlide 1.5s ease-in-out infinite',
            }} />
          </div>
        )}
        <style>{`
          @keyframes runningSlide {
            0%   { left: -30%; }
            100% { left: 100%; }
          }
        `}</style>

        {/* Header chips */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip tone={tone}>
            {isRunning && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: `var(--${tone})`,
                boxShadow: `0 0 4px var(--${tone})`,
                marginRight: 2,
                animation: 'pulseDot 2s ease-in-out infinite',
              }} />
            )}
            {agent.status}
          </Chip>
          <Chip tone="dim">{agent.role}</Chip>
          {agent.model && <Chip tone="dim">{agent.model}</Chip>}
          {depth > 0 && <Chip tone="violet">child</Chip>}
          <span style={{
            marginLeft: 'auto',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
          }}>{relTime(Math.floor(agent.startedAt / 1000))}</span>
          <span onClick={e => e.stopPropagation()}>
            <ToolbarButton
              tone="violet"
              title="Copy this agent block"
              onClick={async () => {
                const ok = await copyToClipboard(agentClipText(agent));
                flash(ok ? 'Agent copied' : 'Copy failed');
              }}
            >
              COPY
            </ToolbarButton>
          </span>
        </div>

        {/* Task */}
        <div
          title={agent.task}
          style={{
            fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink)',
            lineHeight: 1.5,
            ...(taskOpen || !taskLong
              ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' as const }
              : {
                  overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }),
          }}
        >{agent.task}</div>
        {taskLong && (
          <div onClick={e => e.stopPropagation()}>
            <ToolbarButton tone="cyan" onClick={() => setTaskOpen(o => !o)}>
              {taskOpen ? 'COLLAPSE TASK' : 'EXPAND TASK'}
            </ToolbarButton>
          </div>
        )}

        {/* Cost row */}
        <Row
          label="cost"
          value={
            <>
              {agent.tokenEstimate} tok
              <span style={{ color: 'var(--ink-dim)' }}> · {agent.toolCallCount} tool calls</span>
            </>
          }
          right={latency}
        />

        {/* Recent steps */}
        {agent.steps.length > 0 && (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
            lineHeight: 1.45, borderTop: '1px solid var(--line-soft)',
            paddingTop: 4,
          }}>
            {agent.steps.slice(-3).map((s, i) => (
              <div key={`${s.at}-${i}`} title={s.text}>
                <span style={{ color: 'var(--cyan)' }}>{s.kind}</span>
                {s.toolName ? ` · ${s.toolName}` : ''}
                {s.text ? ` — ${s.text.length > 100 ? `${s.text.slice(0, 97)}…` : s.text}` : ''}
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {agent.status === 'error' && agent.error && (
          <>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)',
              ...(errOpen
                ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' as const }
                : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
            }} title={agent.error}>
              {agent.error}
            </div>
            {agent.error.length > 100 && (
              <span onClick={e => e.stopPropagation()}>
                <ToolbarButton tone="red" onClick={() => setErrOpen(o => !o)}>
                  {errOpen ? 'COLLAPSE ERROR' : 'FULL ERROR'}
                </ToolbarButton>
              </span>
            )}
          </>
        )}

        {/* Click hint */}
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--ink-dim)',
          opacity: 0.5, textAlign: 'right',
        }}>
          click to view transcript →
        </div>
      </div>
      {kids.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {kids.map((k, ki) => (
            <FleetNode
              key={k.id}
              agent={k}
              depth={depth + 1}
              index={ki}
              childrenOf={childrenOf}
              flash={flash}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
