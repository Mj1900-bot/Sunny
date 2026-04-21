/**
 * SwitchesList — visual timeline of recent focus changes. Each switch
 * shows a colour-coded dot on a vertical rail with animated card
 * entrance.
 */

import { useState } from 'react';
import { Section, EmptyState, Toolbar, ToolbarButton, relTime } from '../_shared';
import type { AppSwitch } from './types';

const DEFAULT_VISIBLE = 10;

// Deterministic hue from app name for dot colour
function appHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function SwitchEvent({ s, index }: { s: AppSwitch; index: number }) {
  const hue = appHue(s.to_app);
  const dotColor = `hsl(${hue}, 65%, 55%)`;

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12,
        position: 'relative',
        paddingLeft: 24,
        paddingBottom: 4,
        animation: `fadeSlideIn 300ms ease ${index * 30}ms both`,
      }}
    >
      {/* Timeline rail */}
      <div style={{
        position: 'absolute', left: 8, top: 0, bottom: 0,
        width: 1,
        background: 'var(--line-soft)',
      }} />
      {/* Dot */}
      <div style={{
        position: 'absolute', left: 4, top: 6,
        width: 9, height: 9, borderRadius: '50%',
        background: dotColor,
        boxShadow: `0 0 6px ${dotColor}77`,
        border: '1.5px solid rgba(6, 14, 22, 0.8)',
        zIndex: 1,
        flexShrink: 0,
      }} />
      {/* Content */}
      <div style={{
        flex: 1, minWidth: 0,
        padding: '4px 8px',
        background: 'rgba(57, 229, 255, 0.02)',
        border: '1px solid var(--line-soft)',
        borderLeft: `2px solid ${dotColor}55`,
        transition: 'background 120ms ease',
        cursor: 'default',
      }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(57, 229, 255, 0.05)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'rgba(57, 229, 255, 0.02)';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
            flexShrink: 0, minWidth: 42,
          }}>
            {relTime(s.at_secs)}
          </span>
          <span style={{
            fontFamily: 'var(--label)', fontSize: 11, color: 'var(--ink-dim)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {s.from_app}
          </span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
            flexShrink: 0, opacity: 0.5,
          }}>→</span>
          <span style={{
            fontFamily: 'var(--label)', fontSize: 11, fontWeight: 600,
            color: 'var(--ink)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {s.to_app}
          </span>
        </div>
      </div>
    </div>
  );
}

export function SwitchesList({ items }: { items: ReadonlyArray<AppSwitch> }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, DEFAULT_VISIBLE);
  const hidden = Math.max(0, items.length - DEFAULT_VISIBLE);

  return (
    <Section
      title="FOCUS TIMELINE"
      right={items.length > 0 ? `${items.length}${hidden > 0 && !showAll ? ` · +${hidden} more` : ''}` : '0'}
    >
      {/* Inject keyframes for the slide-in animation */}
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateX(-8px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      {items.length === 0 ? (
        <EmptyState title="No focus changes" hint="Sunny's classifier hasn't seen a switch yet this session." />
      ) : (
        <>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 2,
            position: 'relative',
          }}>
            {visible.map((s, i) => (
              <SwitchEvent key={`${s.at_secs}-${i}`} s={s} index={i} />
            ))}
          </div>
          {hidden > 0 && (
            <Toolbar style={{ paddingTop: 4, paddingLeft: 24 }}>
              <ToolbarButton
                tone="cyan"
                onClick={() => setShowAll(s => !s)}
              >
                {showAll ? 'SHOW FEWER' : `SHOW ALL ${items.length}`}
              </ToolbarButton>
            </Toolbar>
          )}
        </>
      )}
    </Section>
  );
}
