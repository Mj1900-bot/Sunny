/**
 * Prohibitions — upgraded editor for constitution red lines.
 *
 * Improvements:
 *  - Time-aware active indicator (highlights rules active right now)
 *  - Severity visual (red glow for always-active rules)
 *  - Better input layout with placeholders
 *  - Staggered animations
 */

import { useState } from 'react';
import { Section, Chip, Toolbar, ToolbarButton, Card } from '../_shared';
import type { Prohibition } from './api';

function isActiveNow(p: Prohibition): boolean {
  const hour = new Date().getHours();
  if (p.after_local_hour != null && hour < p.after_local_hour) return false;
  if (p.before_local_hour != null && hour >= p.before_local_hour) return false;
  return true;
}

export function Prohibitions({
  items, onChange, onCommit,
}: {
  items: ReadonlyArray<Prohibition>;
  onChange: (v: ReadonlyArray<Prohibition>) => void;
  onCommit?: (v: ReadonlyArray<Prohibition>) => void;
}) {
  const [desc, setDesc] = useState('');
  const [tools, setTools] = useState('');
  const [after, setAfter] = useState('');
  const [contains, setContains] = useState('');

  const add = () => {
    if (!desc.trim()) return;
    const parsedAfter = after ? Number.parseInt(after, 10) : Number.NaN;
    const hourOk = Number.isFinite(parsedAfter) && parsedAfter >= 0 && parsedAfter <= 23;
    const p: Prohibition = {
      description: desc.trim(),
      tools: tools.split(',').map(s => s.trim()).filter(Boolean),
      after_local_hour: hourOk ? parsedAfter : null,
      before_local_hour: null,
      match_input_contains: contains.split(',').map(s => s.trim()).filter(Boolean),
    };
    const next = [...items, p];
    onChange(next);
    onCommit?.(next);
    setDesc(''); setTools(''); setAfter(''); setContains('');
  };
  const remove = (i: number) => {
    const next = items.filter((_, idx) => idx !== i);
    onChange(next);
    onCommit?.(next);
  };

  const activeCount = items.filter(isActiveNow).length;

  return (
    <Section
      title="PROHIBITIONS"
      right={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
            {items.length} rule{items.length !== 1 ? 's' : ''}
          </span>
          {activeCount > 0 && (
            <Chip tone="red">
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: 'var(--red)',
                boxShadow: '0 0 4px var(--red)',
                animation: 'pulseDot 2s ease-in-out infinite',
              }} />
              {activeCount} active now
            </Chip>
          )}
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.length === 0 && (
          <div style={{
            padding: '16px 12px',
            border: '1px dashed var(--red)44',
            background: 'rgba(255, 77, 94, 0.03)',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
            textAlign: 'center',
          }}>
            No prohibitions set — Sunny will only surface ConfirmGate for dangerous tools.<br />
            <span style={{ color: 'var(--red)', fontWeight: 600 }}>
              Add red lines below to enforce hard boundaries.
            </span>
          </div>
        )}
        {items.map((p, i) => {
          const active = isActiveNow(p);
          const isAlwaysOn = p.after_local_hour == null && p.before_local_hour == null;
          return (
            <Card
              key={`${p.description}-${i}`}
              accent="red"
              style={{
                animation: `fadeSlideIn 200ms ease ${i * 40}ms both`,
                boxShadow: active && isAlwaysOn
                  ? '0 0 8px rgba(255, 77, 94, 0.12), inset 0 0 16px rgba(255, 77, 94, 0.04)'
                  : 'none',
                transition: 'box-shadow 300ms ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Chip tone="red">DENY</Chip>
                {active ? (
                  <Chip tone="red">
                    <span style={{
                      width: 5, height: 5, borderRadius: '50%',
                      background: 'var(--red)',
                      boxShadow: '0 0 3px var(--red)',
                    }} />
                    ACTIVE
                  </Chip>
                ) : (
                  <Chip tone="dim">INACTIVE</Chip>
                )}
                <span style={{
                  flex: 1, fontFamily: 'var(--label)', fontSize: 13,
                  color: 'var(--ink)', fontWeight: 600,
                }}>
                  {p.description}
                </span>
                <button
                  onClick={() => remove(i)}
                  aria-label={`Remove prohibition ${i + 1}`}
                  style={{
                    all: 'unset', cursor: 'pointer', padding: '2px 6px',
                    fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-dim)',
                    transition: 'color 120ms ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-dim)'; }}
                >×</button>
              </div>
              <div style={{
                display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6,
              }}>
                {p.tools.length > 0
                  ? p.tools.map(t => <Chip key={t} tone="cyan">{t}</Chip>)
                  : <Chip tone="dim">ALL TOOLS</Chip>}
                {p.after_local_hour != null && (
                  <Chip tone="amber">after {p.after_local_hour}:00</Chip>
                )}
                {p.match_input_contains.map(m => (
                  <Chip key={m} tone="violet">contains &quot;{m}&quot;</Chip>
                ))}
              </div>
            </Card>
          );
        })}

        {/* Add form */}
        <Card>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 8, letterSpacing: '0.22em',
            color: 'var(--red)', fontWeight: 700, marginBottom: 8,
          }}>NEW PROHIBITION</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input
              value={desc}
              onChange={e => setDesc(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }}
              placeholder="description (e.g. 'no messages past 10 PM')"
              aria-label="Prohibition description"
              style={inputStyle}
            />
            <input
              value={tools}
              onChange={e => setTools(e.target.value)}
              placeholder="tool names (comma-separated) — blank = all"
              aria-label="Tools covered"
              style={inputStyle}
            />
            <input
              value={after}
              onChange={e => setAfter(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="only after hour (0-23)"
              aria-label="Active after hour"
              inputMode="numeric"
              style={inputStyle}
            />
            <input
              value={contains}
              onChange={e => setContains(e.target.value)}
              placeholder="input contains (comma-separated)"
              aria-label="Input match substrings"
              style={inputStyle}
            />
          </div>
          <Toolbar style={{ marginTop: 10 }}>
            <ToolbarButton tone="red" onClick={add} disabled={!desc.trim()}>
              ADD PROHIBITION
            </ToolbarButton>
          </Toolbar>
        </Card>
      </div>
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Section>
  );
}

const inputStyle: React.CSSProperties = {
  all: 'unset', boxSizing: 'border-box', width: '100%',
  padding: '8px 12px',
  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(0, 0, 0, 0.3)',
  transition: 'border-color 150ms ease',
};
