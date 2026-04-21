import { Card, Chip, EmptyState, Toolbar, ToolbarButton } from '../_shared';
import type { UnifiedItem } from './api';

export function PreviewPane({
  item, onAskSunny,
}: {
  item: UnifiedItem | null;
  onAskSunny: (prompt: string) => void;
}) {
  if (!item) {
    return <EmptyState title="Select a message" hint="Pick any item on the left to preview and action it." />;
  }

  if (item.kind === 'mail') {
    const m = item.data;
    return (
      <Card accent="pink" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Chip tone="pink">MAIL</Chip>
          <Chip tone="dim">{m.account}</Chip>
          <Chip tone="dim">{m.mailbox}</Chip>
          {m.unread && <Chip tone="gold">UNREAD</Chip>}
        </div>
        <div style={{ fontFamily: 'var(--label)', fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>
          {m.subject}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
          from <b style={{ color: 'var(--ink)' }}>{m.from}</b>
          {' · '}
          {new Date(m.received).toLocaleString()}
        </div>
        <div style={{
          fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink-2)',
          lineHeight: 1.55, maxHeight: 280, overflowY: 'auto',
          padding: '8px 0', borderTop: '1px solid var(--line-soft)',
        }}>
          {m.snippet || <span style={{ color: 'var(--ink-dim)' }}>(no preview available)</span>}
        </div>
        <Toolbar>
          <ToolbarButton onClick={() => onAskSunny(`Draft a concise reply to this email from ${m.from}: "${m.subject}". Snippet: ${m.snippet}`)} tone="cyan">DRAFT REPLY</ToolbarButton>
          <ToolbarButton onClick={() => onAskSunny(`Summarize this email in one line and tell me if it needs action: from ${m.from} · ${m.subject} · ${m.snippet}`)} tone="violet">SUMMARIZE</ToolbarButton>
          <ToolbarButton onClick={() => onAskSunny(`Extract any action items from this email: ${m.snippet}`)} tone="amber">EXTRACT TODOS</ToolbarButton>
        </Toolbar>
      </Card>
    );
  }

  const c = item.data;
  return (
    <Card accent="violet" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Chip tone="violet">CHAT</Chip>
        <Chip tone="dim">{c.is_imessage ? 'iMessage' : 'SMS'}</Chip>
        {c.unread_count > 0 && <Chip tone="pink">{c.unread_count} unread</Chip>}
      </div>
      <div style={{ fontFamily: 'var(--label)', fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>
        {c.display}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
        {c.handle} · {c.message_count} messages
      </div>
      <div style={{
        fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink-2)',
        lineHeight: 1.55, padding: '8px 0', borderTop: '1px solid var(--line-soft)',
      }}>
        Last message: <i>"{c.last_message}"</i>
      </div>
      <Toolbar>
        <ToolbarButton onClick={() => onAskSunny(`Open the full thread with ${c.display} (${c.handle}) and draft an appropriate reply.`)} tone="cyan">DRAFT REPLY</ToolbarButton>
        <ToolbarButton onClick={() => onAskSunny(`Show me context on ${c.display} — recent conversations, past topics, things they said.`)} tone="violet">CONTEXT</ToolbarButton>
      </Toolbar>
    </Card>
  );
}
