/**
 * ValuesEditor — add/remove/reorder constitution values.
 *
 * Upgraded with:
 *  - Move up/down buttons for reordering
 *  - Staggered entrance animations
 *  - Visual rank emphasis (first values are visually bolder)
 *  - Inline edit on click
 *  - Better empty state
 */

import { useState } from 'react';
import { Section, Chip, Toolbar, ToolbarButton } from '../_shared';
import { MarkdownPreview } from './MarkdownPreview';

export function ValuesEditor({
  values, onChange, onCommit,
}: {
  values: ReadonlyArray<string>;
  onChange: (v: ReadonlyArray<string>) => void;
  onCommit?: (v: ReadonlyArray<string>) => void;
}) {
  const [draft, setDraft] = useState('');
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    const next = [...values, t];
    onChange(next);
    onCommit?.(next);
    setDraft('');
  };
  const remove = (i: number) => {
    const next = values.filter((_, idx) => idx !== i);
    onChange(next);
    onCommit?.(next);
  };
  const moveUp = (i: number) => {
    if (i <= 0) return;
    const arr = [...values];
    [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    onChange(arr);
    onCommit?.(arr);
  };
  const moveDown = (i: number) => {
    if (i >= values.length - 1) return;
    const arr = [...values];
    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    onChange(arr);
    onCommit?.(arr);
  };
  const startEdit = (i: number) => {
    setEditIdx(i);
    setEditText(values[i]);
  };
  const commitEdit = () => {
    if (editIdx === null) return;
    const t = editText.trim();
    if (!t) { setEditIdx(null); return; }
    const arr = [...values];
    arr[editIdx] = t;
    onChange(arr);
    onCommit?.(arr);
    setEditIdx(null);
  };

  return (
    <Section
      title="VALUES"
      right={`${values.length} principle${values.length !== 1 ? 's' : ''}`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {values.length === 0 && (
          <div style={{
            padding: '16px 12px',
            border: '1px dashed var(--gold)44',
            background: 'rgba(255, 215, 0, 0.03)',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
            textAlign: 'center',
          }}>
            No guiding principles set yet.<br />
            <span style={{ color: 'var(--gold)', fontWeight: 600 }}>
              Add values below to shape how Sunny makes decisions.
            </span>
          </div>
        )}
        {values.map((v, i) => {
          const isEditing = editIdx === i;
          // Visual emphasis fades: first values are bolder
          const emphasis = Math.max(0.5, 1 - (i * 0.08));

          return (
            <div
              key={`${v}-${i}`}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '8px 10px',
                border: '1px solid var(--line-soft)',
                borderLeft: `2px solid var(--gold)`,
                background: isEditing ? 'rgba(255, 215, 0, 0.04)' : 'transparent',
                transition: 'background 150ms ease, opacity 150ms ease',
                opacity: emphasis,
                animation: `fadeSlideIn 200ms ease ${i * 30}ms both`,
              }}
            >
              {/* Rank chip */}
              <Chip tone="gold" style={{ flexShrink: 0, marginTop: 2, minWidth: 28, textAlign: 'center' }}>
                #{i + 1}
              </Chip>

              {/* Content or inline edit */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {isEditing ? (
                  <input
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                      if (e.key === 'Escape') setEditIdx(null);
                    }}
                    autoFocus
                    style={{
                      all: 'unset', width: '100%', boxSizing: 'border-box',
                      padding: '4px 8px',
                      fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink)',
                      border: '1px solid var(--gold)',
                      background: 'rgba(0, 0, 0, 0.3)',
                    }}
                  />
                ) : (
                  <div
                    onClick={() => startEdit(i)}
                    title="Click to edit"
                    style={{ cursor: 'text' }}
                  >
                    <MarkdownPreview
                      text={v}
                      style={{ border: 'none', padding: '0', background: 'transparent', borderLeft: 'none' }}
                    />
                  </div>
                )}
              </div>

              {/* Reorder + delete */}
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0,
              }}>
                <button
                  onClick={() => moveUp(i)}
                  disabled={i === 0}
                  title="Move up"
                  aria-label={`Move value ${i + 1} up`}
                  style={{
                    all: 'unset', cursor: i === 0 ? 'default' : 'pointer',
                    padding: '0 4px',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    color: i === 0 ? 'var(--line-soft)' : 'var(--ink-dim)',
                    transition: 'color 120ms ease',
                  }}
                >▲</button>
                <button
                  onClick={() => moveDown(i)}
                  disabled={i === values.length - 1}
                  title="Move down"
                  aria-label={`Move value ${i + 1} down`}
                  style={{
                    all: 'unset', cursor: i === values.length - 1 ? 'default' : 'pointer',
                    padding: '0 4px',
                    fontFamily: 'var(--mono)', fontSize: 10,
                    color: i === values.length - 1 ? 'var(--line-soft)' : 'var(--ink-dim)',
                    transition: 'color 120ms ease',
                  }}
                >▼</button>
              </div>
              <button
                onClick={() => remove(i)}
                aria-label={`Remove value ${i + 1}`}
                style={{
                  all: 'unset', cursor: 'pointer', flexShrink: 0,
                  padding: '2px 6px',
                  fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-dim)',
                  transition: 'color 120ms ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-dim)'; }}
              >×</button>
            </div>
          );
        })}
      </div>
      <Toolbar style={{ marginTop: 8 }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="add a value…  e.g. 'always ask before sending'"
          aria-label="Add a new value"
          style={{
            all: 'unset', flex: 1,
            padding: '8px 12px',
            fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink)',
            border: '1px solid var(--line-soft)',
            background: 'rgba(0, 0, 0, 0.3)',
            transition: 'border-color 150ms ease',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = 'var(--gold)'; }}
          onBlur={e => { e.currentTarget.style.borderColor = 'var(--line-soft)'; }}
        />
        <ToolbarButton tone="amber" onClick={add} disabled={!draft.trim()}>ADD VALUE</ToolbarButton>
      </Toolbar>
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Section>
  );
}
