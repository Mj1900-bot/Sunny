import { Avatar, Card, Chip, Toolbar, ToolbarButton, relTime } from '../_shared';
import { askSunny } from '../../lib/askSunny';
import type { ContactBookEntry, MessageContact } from './api';

export type Person = {
  readonly key: string;
  readonly handle: string;
  readonly display: string;
  readonly lastChat: MessageContact | null;
  readonly book: ContactBookEntry | null;
};

export type Warmth = 'warm' | 'cooling' | 'cold' | 'unknown';

export type WarmthThresholds = Readonly<{ warmDays: number; coldDays: number }>;

export const DEFAULT_WARMTH_THRESHOLDS: WarmthThresholds = { warmDays: 7, coldDays: 30 };

export function warmth(
  lastTs: number | null | undefined,
  t: WarmthThresholds = DEFAULT_WARMTH_THRESHOLDS,
): Warmth {
  if (!lastTs) return 'unknown';
  const days = (Date.now() / 1000 - lastTs) / 86_400;
  if (days < t.warmDays) return 'warm';
  if (days < t.coldDays) return 'cooling';
  return 'cold';
}

export const TRIAGE_TONE_FOR_WARMTH: Record<Warmth, 'green' | 'amber' | 'red' | 'dim'> = {
  warm: 'green',
  cooling: 'amber',
  cold: 'red',
  unknown: 'dim',
};

const ACCENT: Record<Warmth, 'green' | 'amber' | 'red' | undefined> = {
  warm: 'green',
  cooling: 'amber',
  cold: 'red',
  unknown: undefined,
};

const AVATAR_RING: Record<Warmth, 'green' | 'amber' | 'red' | 'dim'> = {
  warm: 'green',
  cooling: 'amber',
  cold: 'red',
  unknown: 'dim',
};

function daysSinceStr(ts: number): string {
  const d = Math.floor((Date.now() / 1000 - ts) / 86_400);
  if (d <= 0) return 'today';
  if (d === 1) return '1 day';
  return `${d} days`;
}

export function PersonCard({
  p,
  thresholds = DEFAULT_WARMTH_THRESHOLDS,
  selected = false,
  onSelect,
}: {
  p: Person;
  thresholds?: WarmthThresholds;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const w = warmth(p.lastChat?.last_ts, thresholds);
  const openChat = () => askSunny(
    `Open the iMessage / SMS thread with ${p.display} (handle ${p.handle}). Show me recent context and stand by to draft a reply.`,
    'people',
  );

  return (
    <Card
      accent={ACCENT[w]}
      onClick={onSelect}
      interactive={Boolean(onSelect)}
      style={selected
        ? { outline: '1px solid var(--cyan)', outlineOffset: 2, background: 'rgba(57, 229, 255, 0.08)' }
        : undefined}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Avatar name={p.display} size={36} ring={AVATAR_RING[w]} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--label)', fontSize: 13.5, fontWeight: 600,
            color: 'var(--ink)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{p.display}</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
            display: 'flex', gap: 6, alignItems: 'center', marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: 140,
            }}>{p.handle}</span>
            {p.lastChat && <span>· {p.lastChat.message_count} msgs</span>}
          </div>
        </div>
        <Chip tone={TRIAGE_TONE_FOR_WARMTH[w]}>{w}</Chip>
      </div>

      {/* Last contact line */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginTop: 8,
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
      }}>
        {p.lastChat ? (
          <>
            <span style={{ color: w === 'cold' ? 'var(--red)' : 'var(--ink-2)' }}>
              {daysSinceStr(p.lastChat.last_ts)}
            </span>
            <span>·</span>
            <span>{relTime(p.lastChat.last_ts)}</span>
            {p.lastChat.unread_count > 0 && (
              <span style={{
                marginLeft: 'auto',
                color: 'var(--pink)', fontWeight: 700,
              }}>{p.lastChat.unread_count} unread</span>
            )}
          </>
        ) : (
          <span>no thread on record</span>
        )}
      </div>

      {p.lastChat && (
        <div style={{
          fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink-2)',
          marginTop: 6,
          fontStyle: 'italic',
          lineHeight: 1.4,
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical' as const,
          WebkitLineClamp: 2,
          overflow: 'hidden',
        }}>
          "{p.lastChat.last_message}"
        </div>
      )}

      <div
        onMouseDownCapture={(e: React.MouseEvent) => e.stopPropagation()}
        onClickCapture={(e: React.MouseEvent) => e.stopPropagation()}
        style={{ marginTop: 10 }}
      >
        <Toolbar>
          {p.lastChat && (
            <ToolbarButton tone="green" onClick={openChat}>OPEN</ToolbarButton>
          )}
          <ToolbarButton
            tone="cyan"
            onClick={() => askSunny(`Summarize everything you remember about ${p.display} (handle ${p.handle}) — recent topics, preferences, outstanding threads.`, 'people')}
          >BRIEF</ToolbarButton>
          <ToolbarButton
            tone="violet"
            onClick={() => askSunny(`Draft a warm check-in message to ${p.display}. Reference our last exchange if I have one.`, 'people')}
          >CHECK IN</ToolbarButton>
          <ToolbarButton
            tone="amber"
            onClick={() => askSunny(`Save three durable facts about ${p.display} to semantic memory based on our recent conversations.`, 'people')}
          >LEARN</ToolbarButton>
        </Toolbar>
      </div>
    </Card>
  );
}
