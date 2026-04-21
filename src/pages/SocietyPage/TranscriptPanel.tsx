/**
 * TranscriptPanel — slide-in panel showing the full step log for a sub-agent.
 * Opened when the user clicks a FleetNode card. Steps are shown newest-last
 * so the most recent output is always at the bottom (like a terminal).
 */

import { useEffect, useRef } from 'react';
import { Chip, ScrollList as _ScrollList, Section } from '../_shared';
import type { SubAgent, SubAgentStep } from '../../store/subAgentsLive';

const STEP_TONE: Record<SubAgent['steps'][number]['kind'], string> = {
  thinking: 'var(--violet)',
  tool_call: 'var(--cyan)',
  tool_result: 'var(--green)',
  error: 'var(--red)',
};

const STEP_LABEL: Record<SubAgent['steps'][number]['kind'], string> = {
  thinking: 'THINK',
  tool_call: 'CALL',
  tool_result: 'RESULT',
  error: 'ERROR',
};

function StepRow({ step }: { step: SubAgentStep }) {
  const tone = STEP_TONE[step.kind];
  const label = STEP_LABEL[step.kind];
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 3,
      padding: '7px 10px',
      border: '1px solid var(--line-soft)',
      borderLeft: `2px solid ${tone}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.2em',
          color: tone, fontWeight: 700,
        }}>{label}</span>
        {step.toolName && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--cyan)' }}>
            {step.toolName}
          </span>
        )}
        <span style={{
          marginLeft: 'auto',
          fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
        }}>
          {new Date(step.at).toLocaleTimeString(undefined, {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          })}
        </span>
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-2)',
        lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: 120, overflowY: 'auto',
      }}>
        {step.text || '(empty)'}
      </div>
    </div>
  );
}

export function TranscriptPanel({
  agent,
  onClose,
}: {
  agent: SubAgent;
  onClose: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to newest step when panel opens or steps change.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agent.steps.length]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const statusTone = agent.status === 'running' ? 'green' : agent.status === 'error' ? 'red' : 'violet';

  return (
    <div
      role="dialog"
      aria-label={`Transcript for ${agent.role} sub-agent`}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 480, maxWidth: '90vw',
        background: 'var(--bg)',
        borderLeft: '1px solid var(--line-soft)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--line-soft)',
          display: 'flex', alignItems: 'center', gap: 10,
          flexShrink: 0,
        }}>
          <Chip tone={statusTone}>{agent.status}</Chip>
          <Chip tone="dim">{agent.role}</Chip>
          {agent.model && <Chip tone="dim">{agent.model}</Chip>}
          <button
            onClick={onClose}
            aria-label="Close transcript"
            style={{
              all: 'unset', cursor: 'pointer', marginLeft: 'auto',
              fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.2em',
              color: 'var(--ink-dim)', padding: '3px 8px',
              border: '1px solid var(--line-soft)',
            }}
          >ESC / CLOSE</button>
        </div>

        {/* Task description */}
        <div style={{
          padding: '10px 18px',
          borderBottom: '1px solid var(--line-soft)',
          fontFamily: 'var(--label)', fontSize: 12.5, color: 'var(--ink)',
          lineHeight: 1.5, flexShrink: 0,
        }}>
          {agent.task}
        </div>

        {/* Stats bar */}
        <div style={{
          padding: '8px 18px',
          borderBottom: '1px solid var(--line-soft)',
          display: 'flex', gap: 16, flexShrink: 0,
        }}>
          {[
            { label: 'STEPS', value: String(agent.steps.length) },
            { label: 'TOOL CALLS', value: String(agent.toolCallCount) },
            { label: 'TOKENS ~', value: String(agent.tokenEstimate) },
          ].map(({ label, value }) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
                color: 'var(--ink-2)', fontWeight: 700,
              }}>{label}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--cyan)' }}>
                {value}
              </span>
            </div>
          ))}
        </div>

        {/* Steps */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
          <Section title="TRANSCRIPT" right={`${agent.steps.length} steps`}>
            {agent.steps.length === 0 ? (
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', padding: '8px 2px',
              }}>No steps recorded yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {agent.steps.map((s, i) => (
                  <StepRow key={`${s.at}-${i}`} step={s} />
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </Section>

          {/* Answer or error surface */}
          {agent.answer && (
            <Section title="ANSWER" style={{ marginTop: 12 }}>
              <div style={{
                fontFamily: 'var(--label)', fontSize: 12.5, color: 'var(--ink)',
                lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                padding: '8px 10px',
                border: '1px solid var(--line-soft)',
                borderLeft: '2px solid var(--green)',
                background: 'rgba(0, 0, 0, 0.3)',
              }}>
                {agent.answer}
              </div>
            </Section>
          )}
          {agent.error && (
            <Section title="ERROR" style={{ marginTop: 12 }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
                padding: '8px 10px',
                border: '1px solid var(--line-soft)',
                borderLeft: '2px solid var(--red)',
              }}>
                {agent.error}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
