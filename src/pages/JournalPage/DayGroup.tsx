import { useState } from 'react';
import { Chip, clockTime } from '../_shared';
import type { EpisodicItem, EpisodicKind } from './api';
import { MOOD_OPTIONS } from './moods';

const KIND_TONE: Record<EpisodicKind, 'cyan' | 'amber' | 'violet' | 'green' | 'red' | 'pink' | 'gold' | 'teal'> = {
  user: 'cyan',
  agent_step: 'teal',
  perception: 'violet',
  reflection: 'pink',
  note: 'gold',
  correction: 'red',
  goal: 'amber',
  tool_call: 'amber',
  tool_result: 'green',
  answer: 'gold',
};

/** Kinds that get a richer, highlighted treatment (longer clamp, glow border). */
const HIGHLIGHT_KINDS = new Set<EpisodicKind>(['note', 'reflection', 'goal', 'answer']);

/** Pick the highest-priority mood tag present in today's items for the section glyph. */
function dominantMoodGlyph(items: ReadonlyArray<EpisodicItem>): string | null {
  for (const mood of MOOD_OPTIONS) {
    if (items.some(it => it.tags.includes(`mood:${mood.id}`))) return mood.glyph;
  }
  return null;
}

/** Split the raw label ("TODAY" / "MON" / "MAR 14, 2026") into a primary + secondary part. */
function splitDayLabel(label: string, items: ReadonlyArray<EpisodicItem>): { primary: string; secondary: string | null } {
  if (label === 'TODAY' || label === 'YESTERDAY') {
    const d = items[0] ? new Date(items[0].created_at * 1000) : new Date();
    const secondary = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
    return { primary: label, secondary };
  }
  return { primary: label, secondary: null };
}

export function DayGroup({ label, items }: { label: string; items: ReadonlyArray<EpisodicItem> }) {
  const glyph = dominantMoodGlyph(items);
  const { primary, secondary } = splitDayLabel(label, items);
  const noteCount = items.filter(i => i.kind === 'note').length;
  const reflectCount = items.filter(i => i.kind === 'reflection').length;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
      {/* Day header — primary + secondary line with mood + stats */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 12px',
        borderBottom: '1px solid var(--line-soft)',
        borderLeft: '2px solid var(--cyan)',
        background: 'linear-gradient(90deg, rgba(57, 229, 255, 0.04), transparent 70%)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{
            fontFamily: 'var(--display)', fontSize: 11, letterSpacing: '0.28em',
            color: 'var(--cyan)', fontWeight: 800,
          }}>{primary}</span>
          {secondary && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em',
              color: 'var(--ink-dim)',
            }}>{secondary}</span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {glyph && (
          <span
            title="mood logged"
            style={{ fontSize: 18, lineHeight: 1, filter: 'saturate(1.1)' }}
          >{glyph}</span>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          {noteCount > 0 && <Chip tone="gold" style={{ fontSize: 8 }}>{noteCount} NOTE{noteCount === 1 ? '' : 'S'}</Chip>}
          {reflectCount > 0 && <Chip tone="pink" style={{ fontSize: 8 }}>{reflectCount} REFLECT</Chip>}
          <Chip tone="dim" style={{ fontSize: 8 }}>{items.length} TOTAL</Chip>
        </div>
      </header>

      {/* Entries */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(it => <EntryRow key={it.id} item={it} />)}
      </div>
    </section>
  );
}

function EntryRow({ item }: { item: EpisodicItem }) {
  const [expanded, setExpanded] = useState(false);
  const kind = item.kind;
  const tone = KIND_TONE[kind] ?? 'cyan';
  const highlight = HIGHLIGHT_KINDS.has(kind);
  const moodTag = item.tags.find(t => t.startsWith('mood:'));
  const moodGlyph = moodTag
    ? (MOOD_OPTIONS.find(m => `mood:${m.id}` === moodTag)?.glyph ?? null)
    : null;
  const otherTags = item.tags.filter(t => !t.startsWith('mood:'));
  const longText = item.text.length > 140;

  return (
    <div
      onClick={() => { if (longText) setExpanded(v => !v); }}
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '9px 12px',
        borderLeft: `2px solid var(--${tone})`,
        background: highlight ? 'rgba(6, 14, 22, 0.68)' : 'rgba(6, 14, 22, 0.45)',
        border: highlight ? `1px solid rgba(57, 229, 255, 0.18)` : '1px solid var(--line-soft)',
        cursor: longText ? 'pointer' : 'default',
        transition: 'background 140ms ease',
      }}
      onMouseEnter={e => { if (longText) e.currentTarget.style.background = 'rgba(57, 229, 255, 0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = highlight ? 'rgba(6, 14, 22, 0.68)' : 'rgba(6, 14, 22, 0.45)'; }}
    >
      <Chip tone={tone}>{kind.replace('_', ' ')}</Chip>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{
          fontFamily: 'var(--label)',
          fontSize: highlight ? 13.5 : 12.5,
          color: 'var(--ink)',
          lineHeight: 1.55,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: expanded ? 20 : (highlight ? 4 : 2),
          WebkitBoxOrient: 'vertical',
          whiteSpace: 'pre-wrap',
        }}>{item.text}</div>
        {(otherTags.length > 0 || moodGlyph) && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {otherTags.slice(0, 5).map(t => (
              <span key={t} style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                color: 'var(--ink-dim)', padding: '1px 5px',
                border: '1px solid var(--line-soft)',
                letterSpacing: '0.04em',
              }}>#{t}</span>
            ))}
            {otherTags.length > 5 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)' }}>
                +{otherTags.length - 5}
              </span>
            )}
            {moodGlyph && (
              <span style={{ fontSize: 12, lineHeight: 1, marginLeft: 'auto' }}>{moodGlyph}</span>
            )}
          </div>
        )}
      </div>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        flexShrink: 0, letterSpacing: '0.06em',
      }}>{clockTime(item.created_at)}</span>
    </div>
  );
}
