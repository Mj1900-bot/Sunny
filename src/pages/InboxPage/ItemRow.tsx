import { forwardRef } from 'react';
import { Avatar, Chip, relTime } from '../_shared';
import type { UnifiedItem } from './api';
import { classify, TRIAGE_TONE, type TriageLabel } from './triage';

type Props = {
  item: UnifiedItem;
  selected: boolean;
  onSelect: () => void;
  /** Persisted AI triage label — wins over local heuristic when set. */
  overrideLabel?: TriageLabel;
  starred?: boolean;
  onToggleStar?: () => void;
};

/**
 * Single row in the unified inbox list. Source is colour-coded per spec
 * (mail = cyan/pink, chat = green) and the triage label appears as a chip
 * on the right. When `overrideLabel` is set (written by SUNNY TRIAGE),
 * it takes precedence over the local heuristic.
 */
export const ItemRow = forwardRef<HTMLDivElement, Props>(function ItemRow(
  { item, selected, onSelect, overrideLabel, starred, onToggleStar }, ref,
) {
  const isMail = item.kind === 'mail';
  const unread = isMail ? item.data.unread : (item.data.unread_count ?? 0) > 0;
  const unreadBadge = !isMail ? item.data.unread_count : 0;
  const triage = classify(item);
  const triageLabel: TriageLabel = overrideLabel ?? triage.label;
  const sourceTone = isMail ? 'cyan' : 'green';
  const rgb = isMail ? '57, 229, 255' : '125, 255, 154';
  const selectedBg = `linear-gradient(90deg, rgba(${rgb}, 0.18), transparent 85%)`;
  const unreadBg = `rgba(${rgb}, 0.05)`;

  const displayName = isMail
    ? (item.data.from.split(' <')[0] || item.data.from).trim()
    : item.data.display;

  return (
    <div
      ref={ref}
      onClick={onSelect}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 12px', cursor: 'pointer',
        borderLeft: selected
          ? `2px solid var(--${sourceTone})`
          : unread
            ? `2px solid rgba(${rgb}, 0.5)`
            : '2px solid transparent',
        background: selected ? selectedBg : unread ? unreadBg : 'transparent',
        borderBottom: '1px solid var(--line-soft)',
        transition: 'background 140ms ease, border-color 140ms ease',
        outline: 'none',
      }}
    >
      {/* Unread pulse dot */}
      <div style={{ width: 6, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {unread ? (
          <div
            aria-hidden
            style={{
              width: 6, height: 6, borderRadius: '50%',
              background: `var(--${sourceTone})`,
              boxShadow: `0 0 6px var(--${sourceTone})`,
            }}
          />
        ) : null}
      </div>

      <Avatar name={displayName} size={28} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{
          display: 'flex', gap: 8, alignItems: 'baseline',
          fontFamily: 'var(--label)', fontSize: 12,
          color: unread ? 'var(--ink)' : 'var(--ink-2)',
          fontWeight: unread ? 600 : 400,
        }}>
          <span style={{
            flexShrink: 0, color: unread ? '#fff' : 'var(--ink-2)',
            maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {displayName.slice(0, 30)}
          </span>
          <span style={{
            flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: unread ? 'var(--ink)' : 'var(--ink-2)',
          }}>
            {isMail ? item.data.subject : item.data.last_message}
          </span>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
          overflow: 'hidden',
        }}>
          <span style={{
            display: 'inline-block',
            padding: '0 4px',
            fontSize: 8.5, letterSpacing: '0.18em', fontWeight: 700,
            color: `var(--${sourceTone})`,
            border: `1px solid var(--${sourceTone})`,
            opacity: 0.75,
          }}>{isMail ? 'MAIL' : 'CHAT'}</span>
          {isMail ? (
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flex: 1, minWidth: 0,
            }}>
              {item.data.snippet.slice(0, 90) || '—'}
            </span>
          ) : (
            <span>
              {item.data.is_imessage ? 'iMessage' : 'SMS'} · {item.data.message_count} msgs
            </span>
          )}
        </div>
      </div>

      {unreadBadge > 0 && <Chip tone="pink">{unreadBadge}</Chip>}
      {onToggleStar && (
        <button
          type="button"
          aria-label={starred ? 'Unstar' : 'Star'}
          title={starred ? 'Unstar' : 'Star for follow-up'}
          onClick={e => { e.stopPropagation(); onToggleStar(); }}
          style={{
            all: 'unset', cursor: 'pointer', flexShrink: 0,
            fontSize: 14, lineHeight: 1, padding: '2px 4px',
            color: starred ? 'var(--gold)' : 'var(--ink-dim)',
            opacity: starred ? 1 : 0.45,
          }}
        >{starred ? '★' : '☆'}</button>
      )}
      <Chip
        tone={TRIAGE_TONE[triageLabel]}
        style={{ minWidth: 74, justifyContent: 'center' }}
      >
        {triageLabel}
        {overrideLabel && (
          <span style={{ opacity: 0.6, fontSize: 8, marginLeft: 2 }}>AI</span>
        )}
      </Chip>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        flexShrink: 0, minWidth: 36, textAlign: 'right',
      }}>{relTime(item.when)}</span>
    </div>
  );
});
