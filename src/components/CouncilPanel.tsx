/**
 * CouncilPanel — N streaming columns, one per council member.
 *
 * Each card shows:
 *   - agent name
 *   - model badge (glm-5.1 / qwen3:30b / qwen3.5:9b)
 *   - scrolling token stream
 *
 * A "synthesis" box appears below after all members finish.
 * The panel is dismissible. No layout shift on stream (fixed-height
 * scroll containers, no reflow).
 *
 * Immutable state: all handlers return new objects / arrays.
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { MemberState, CouncilStatus } from '../hooks/useCouncil';

interface CouncilPanelProps {
  readonly status: CouncilStatus;
  readonly members: readonly MemberState[];
  readonly synthesis: string | null;
  readonly error: string | null;
  readonly onDismiss: () => void;
}

const MODEL_BADGE_COLORS: Record<string, string> = {
  'glm-5.1': 'var(--cyan)',
  'qwen3:30b': 'var(--amber)',
  'qwen3.5:9b': 'var(--violet)',
};

function modelBadgeColor(model: string): string {
  return MODEL_BADGE_COLORS[model] ?? 'var(--ink-dim)';
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 14px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.72)',
  position: 'relative',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.28em',
  color: 'var(--amber)',
  fontWeight: 700,
  borderBottom: '1px solid var(--line-soft)',
  paddingBottom: 8,
};

const columnsStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  overflowX: 'auto',
  alignItems: 'flex-start',
};

function MemberCard({ member }: { readonly member: MemberState }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new tokens — no layout shift because the container
  // has a fixed height.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [member.tokens]);

  const cardStyle: CSSProperties = {
    flex: '0 0 220px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    border: '1px solid var(--line-soft)',
    borderTop: `2px solid ${member.done ? 'var(--green)' : 'var(--amber)'}`,
    background: 'rgba(6, 14, 22, 0.55)',
    padding: '8px 10px',
  };

  const nameBadgeStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'space-between',
  };

  const nameStyle: CSSProperties = {
    fontFamily: 'var(--display)',
    fontSize: 9,
    letterSpacing: '0.22em',
    color: member.done ? 'var(--green)' : 'var(--ink)',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
  };

  const modelBadgeStyle: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 8.5,
    letterSpacing: '0.06em',
    color: modelBadgeColor(member.model),
    border: `1px solid ${modelBadgeColor(member.model)}`,
    padding: '1px 5px',
    opacity: 0.85,
  };

  const tokensStyle: CSSProperties = {
    height: 160,
    overflowY: 'auto' as const,
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    color: 'var(--ink-2)',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  const statusDotStyle: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: member.done ? 'var(--green)' : 'var(--amber)',
    flexShrink: 0,
  };

  return (
    <div style={cardStyle} aria-label={`Council member ${member.name}`}>
      <div style={nameBadgeStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={statusDotStyle} aria-hidden />
          <span style={nameStyle}>{member.name}</span>
        </div>
        <span style={modelBadgeStyle}>{member.model}</span>
      </div>
      <div
        ref={scrollRef}
        style={tokensStyle}
        aria-live="polite"
        aria-label={`${member.name} output`}
      >
        {member.tokens || (
          <span style={{ opacity: 0.4 }}>waiting…</span>
        )}
      </div>
    </div>
  );
}

function SynthesisBox({ text }: { readonly text: string }) {
  const boxStyle: CSSProperties = {
    border: '1px solid var(--cyan)',
    borderLeft: '2px solid var(--cyan)',
    background: 'rgba(57, 229, 255, 0.05)',
    padding: '10px 14px',
    fontFamily: 'var(--label)',
    fontSize: 12,
    color: 'var(--ink)',
    lineHeight: 1.65,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  const labelStyle: CSSProperties = {
    fontFamily: 'var(--display)',
    fontSize: 8,
    letterSpacing: '0.28em',
    color: 'var(--cyan)',
    fontWeight: 700,
    marginBottom: 8,
    display: 'block',
  };

  return (
    <div style={boxStyle} aria-label="Council synthesis">
      <span style={labelStyle}>SYNTHESIS</span>
      {text}
    </div>
  );
}

export function CouncilPanel({
  status,
  members,
  synthesis,
  error,
  onDismiss,
}: CouncilPanelProps) {
  if (status === 'idle') return null;

  return (
    <div style={panelStyle} role="region" aria-label="Council deliberation">
      <div style={headerStyle}>
        <span>COUNCIL · {members.length} AGENTS</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {status === 'running' && (
            <span style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              color: 'var(--amber)',
              letterSpacing: '0.12em',
              animation: 'pulse 1.6s ease-in-out infinite',
            }}>
              DELIBERATING
            </span>
          )}
          {status === 'complete' && (
            <span style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              color: 'var(--green)',
              letterSpacing: '0.12em',
            }}>
              COMPLETE
            </span>
          )}
          {status === 'error' && (
            <span style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              color: 'var(--red)',
              letterSpacing: '0.12em',
            }}>
              ERROR
            </span>
          )}
          <button
            onClick={onDismiss}
            aria-label="Dismiss council panel"
            style={{
              all: 'unset',
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
              fontSize: 9,
              color: 'var(--ink-dim)',
              letterSpacing: '0.16em',
              padding: '2px 6px',
              border: '1px solid var(--line-soft)',
              transition: 'color 120ms, border-color 120ms',
            }}
          >
            DISMISS
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          color: 'var(--red)',
          padding: '6px 10px',
          border: '1px solid var(--red)',
          background: 'rgba(255, 77, 94, 0.08)',
        }}>
          {error}
        </div>
      )}

      <div style={columnsStyle} role="list" aria-label="Council members">
        {members.map(m => (
          <div key={m.name} role="listitem">
            <MemberCard member={m} />
          </div>
        ))}
      </div>

      {synthesis !== null && <SynthesisBox text={synthesis} />}
    </div>
  );
}
