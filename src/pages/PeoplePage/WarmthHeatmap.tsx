/**
 * WarmthHeatmap — horizontal recency strip per contact.
 *
 * For each of the top-N active people we render a bar that fades from
 * full-brightness at the moment of last contact back to "cold" the farther
 * the contact is in the past. This gives an immediate visual sort of the
 * relationship graph by how recently the person was in the user's life.
 */

import { Avatar } from '../_shared';
import type { MessageContact } from './api';

type Props = {
  readonly chats: ReadonlyArray<MessageContact>;
  readonly maxPeople?: number;
  readonly days?: number;
};

function warmthTone(days: number): 'green' | 'amber' | 'red' {
  if (days < 7) return 'green';
  if (days < 30) return 'amber';
  return 'red';
}

function toneToColor(t: 'green' | 'amber' | 'red'): string {
  if (t === 'green') return 'var(--green)';
  if (t === 'amber') return 'var(--amber)';
  return 'var(--red)';
}

export function WarmthHeatmap({ chats, maxPeople = 10, days = 30 }: Props) {
  const now = Date.now() / 1000;

  const people = [...chats]
    .sort((a, b) => b.last_ts - a.last_ts)
    .slice(0, maxPeople);

  if (people.length === 0) return null;

  // Build day-tick labels across the `days` window.
  const ticks = [0, 7, 14, 21, days].filter((v, i, arr) => arr.indexOf(v) === i);

  return (
    <div style={{
      border: '1px solid var(--line-soft)',
      background: 'rgba(6, 14, 22, 0.55)',
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.28em',
        color: 'var(--cyan)', fontWeight: 700,
        borderBottom: '1px solid var(--line-soft)', paddingBottom: 6,
      }}>
        <span>WARMTH · LAST {days} DAYS</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', letterSpacing: '0.08em' }}>
          {people.length} contacts
        </span>
      </div>

      {/* Day axis ticks */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '132px 1fr 56px',
        gap: 8, alignItems: 'center',
        fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--ink-dim)',
        letterSpacing: '0.08em',
      }}>
        <div />
        <div style={{ position: 'relative', height: 10 }}>
          {ticks.map(t => {
            const pct = 1 - t / days;
            return (
              <span key={t} style={{
                position: 'absolute',
                left: `${pct * 100}%`,
                transform: pct === 1 ? 'translateX(-100%)' : pct === 0 ? 'none' : 'translateX(-50%)',
                top: 0,
                whiteSpace: 'nowrap',
              }}>
                {t === 0 ? 'today' : `-${t}d`}
              </span>
            );
          })}
        </div>
        <div style={{ textAlign: 'right' }}>AGO</div>
      </div>

      {/* Rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {people.map(p => {
          const daysAgo = Math.max(0, Math.floor((now - p.last_ts) / 86_400));
          const clamped = Math.min(days, daysAgo);
          const widthPct = 1 - clamped / days;
          const tone = warmthTone(daysAgo);
          const color = toneToColor(tone);
          const name = p.display.split(' ')[0] ?? p.display;

          return (
            <div
              key={p.handle}
              title={`${p.display} — last contact ${daysAgo}d ago`}
              style={{
                display: 'grid',
                gridTemplateColumns: '132px 1fr 56px',
                gap: 8,
                alignItems: 'center',
                padding: '3px 0',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Avatar name={p.display} size={20} ring={tone} />
                <span style={{
                  fontFamily: 'var(--label)', fontSize: 11.5, color: 'var(--ink-2)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{name}</span>
              </div>
              <div style={{
                position: 'relative',
                height: 10,
                background: 'rgba(57, 229, 255, 0.05)',
                border: '1px solid var(--line-soft)',
              }}>
                <div style={{
                  position: 'absolute', inset: 0,
                  width: `${Math.max(4, widthPct * 100)}%`,
                  background: `linear-gradient(90deg, ${color}22, ${color})`,
                  boxShadow: `0 0 6px ${color}44`,
                }} />
                {/* "Last contact" tip */}
                <div style={{
                  position: 'absolute',
                  right: 0,
                  top: -1, bottom: -1,
                  width: 2,
                  background: color,
                  boxShadow: `0 0 6px ${color}`,
                  opacity: widthPct > 0.02 ? 1 : 0,
                }} />
              </div>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                color: tone === 'red' ? 'var(--red)' : 'var(--ink-2)',
                textAlign: 'right',
                fontWeight: 600,
              }}>
                {daysAgo === 0 ? 'today' : `${daysAgo}d`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
