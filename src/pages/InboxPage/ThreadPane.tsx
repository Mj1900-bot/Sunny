/**
 * ThreadPane — right-side detail panel for the unified Inbox.
 *
 * For MAIL items: shows full thread metadata + body snippet with DRAFT REPLY /
 * SUMMARIZE / EXTRACT TODOS + an inline quick-reply composer with DRAFT WITH SUNNY.
 *
 * For CHAT items: fetches the last N messages from `messaging_fetch_conversation`
 * and renders them as bubbles + inline composer.
 *
 * Replaces PreviewPane — same props shape, richer content.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Card, Chip, EmptyState, Toolbar, ToolbarButton } from '../_shared';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { copyToClipboard } from '../../lib/clipboard';
import type { UnifiedItem } from './api';

type ConversationMessage = {
  readonly rowid: number;
  readonly text: string;
  readonly ts: number;
  readonly from_me: boolean;
  readonly sender: string | null;
  readonly has_attachment: boolean;
};

const THREAD_LIMIT = 30;
const POLL_MS = 8_000;

function relFmt(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Chat bubble ────────────────────────────────────────────────────────────

function Bubble({ msg }: { readonly msg: ConversationMessage }) {
  const body = msg.text || (msg.has_attachment ? '[attachment]' : '—');
  const mine = msg.from_me;
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: mine ? 'flex-end' : 'flex-start',
      gap: 2,
    }}>
      <div style={{
        maxWidth: '82%',
        padding: '6px 10px',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        lineHeight: 1.45,
        border: '1px solid',
        borderColor: mine ? 'var(--cyan)' : 'var(--line-soft)',
        background: mine ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.85)',
        color: 'var(--ink)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {body}
      </div>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.1em',
      }}>{relFmt(msg.ts)}</span>
    </div>
  );
}

// ─── Inline composer ─────────────────────────────────────────────────────────

type ComposerProps = {
  readonly contactDisplay: string;
  readonly onSend?: (body: string) => Promise<boolean>;
  readonly onAskSunny: (prompt: string) => void;
  readonly draftPrompt: string;
};

function InlineComposer({ contactDisplay, onSend, onAskSunny, draftPrompt }: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleSend = useCallback(async () => {
    if (!onSend || text.trim().length === 0 || sending) return;
    setSending(true);
    setErr(null);
    try {
      const ok = await onSend(text.trim());
      if (ok) setText('');
      else setErr('Send declined.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [onSend, text, sending]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      borderTop: '1px solid var(--line-soft)', paddingTop: 10,
    }}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void handleSend();
          }
        }}
        placeholder={`Reply to ${contactDisplay}… (⌘↩ to send)`}
        rows={2}
        style={{
          width: '100%', boxSizing: 'border-box',
          fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
          background: 'rgba(6, 14, 22, 0.7)',
          border: '1px solid var(--line-soft)',
          padding: 10, resize: 'vertical', minHeight: 44, maxHeight: 140,
        }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {onSend && (
          <ToolbarButton
            tone="cyan"
            disabled={sending || text.trim().length === 0}
            onClick={() => void handleSend()}
          >
            {sending ? 'SENDING…' : 'SEND'}
          </ToolbarButton>
        )}
        <ToolbarButton
          tone="violet"
          onClick={() => onAskSunny(draftPrompt)}
        >
          DRAFT WITH SUNNY
        </ToolbarButton>
        {err && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: '#ff6b6b', letterSpacing: '0.05em',
          }} role="alert">{err}</span>
        )}
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
          letterSpacing: '0.15em', marginLeft: 'auto',
        }}>{text.length} CHARS</span>
      </div>
    </div>
  );
}

// ─── Chat thread panel ───────────────────────────────────────────────────────

function ChatThreadPanel({
  item, onAskSunny,
}: {
  readonly item: Extract<UnifiedItem, { kind: 'chat' }>;
  readonly onAskSunny: (prompt: string) => void;
}) {
  const c = item.data;
  const [messages, setMessages] = useState<ReadonlyArray<ConversationMessage>>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    if (!isTauri) return;
    const rows = await invokeSafe<ConversationMessage[]>(
      'messaging_fetch_conversation',
      { chatIdentifier: c.handle, limit: THREAD_LIMIT },
      [],
    );
    setMessages(rows ?? []);
  }, [c.handle]);

  useEffect(() => {
    setMessages([]);
    void reload();
    const h = window.setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(h);
  }, [c.handle, reload]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const draftPrompt = `Draft a reply to ${c.display} (${c.handle}). Their last message: "${c.last_message}". Keep it warm and concise.`;

  return (
    <Card accent="violet" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Avatar name={c.display} size={40} ring={c.unread_count > 0 ? 'cyan' : undefined} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 15, fontWeight: 700,
            color: 'var(--ink)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{c.display}</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
            display: 'flex', gap: 6, alignItems: 'center', marginTop: 2,
          }}>
            <span>{c.handle}</span>
            <span>·</span>
            <span>{c.message_count} msgs</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Chip tone="violet">CHAT</Chip>
          <Chip tone="dim">{c.is_imessage ? 'iMessage' : 'SMS'}</Chip>
          {c.unread_count > 0 && <Chip tone="pink">{c.unread_count} UNREAD</Chip>}
        </div>
      </div>
      <div
        ref={transcriptRef}
        style={{
          border: '1px solid var(--line-soft)',
          background: 'rgba(4, 10, 16, 0.55)',
          padding: 12,
          display: 'flex', flexDirection: 'column', gap: 8,
          overflowY: 'auto', minHeight: 120, maxHeight: 340,
          flex: '1 1 auto',
        }}
        aria-label="Conversation thread"
      >
        {messages.length === 0 ? (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
            letterSpacing: '0.2em', margin: 'auto',
          }}>
            {isTauri ? 'LOADING THREAD…' : 'NO MESSAGES (DEMO MODE)'}
          </span>
        ) : (
          messages.map(m => <Bubble key={m.rowid} msg={m} />)
        )}
      </div>
      <Toolbar>
        <ToolbarButton
          tone="cyan"
          onClick={() => void copyToClipboard(
            [`Chat · ${c.display}`, c.handle, c.last_message].join('\n\n'),
          )}
        >COPY THREAD</ToolbarButton>
        <ToolbarButton tone="cyan" onClick={() => onAskSunny(draftPrompt)}>DRAFT REPLY</ToolbarButton>
        <ToolbarButton tone="amber" onClick={() => onAskSunny(`Extract any action items from my chat with ${c.display}: "${c.last_message}"`)}>EXTRACT TODOS</ToolbarButton>
        <ToolbarButton tone="violet" onClick={() => onAskSunny(`Summarize my relationship context with ${c.display} based on recent messages.`)}>CONTEXT</ToolbarButton>
      </Toolbar>
      <InlineComposer
        contactDisplay={c.display}
        onAskSunny={onAskSunny}
        draftPrompt={draftPrompt}
      />
    </Card>
  );
}

// ─── Mail thread panel ───────────────────────────────────────────────────────

function MailThreadPanel({
  item, onAskSunny,
}: {
  readonly item: Extract<UnifiedItem, { kind: 'mail' }>;
  readonly onAskSunny: (prompt: string) => void;
}) {
  const m = item.data;
  const draftPrompt = `Draft a concise, professional reply to this email:\nFrom: ${m.from}\nSubject: ${m.subject}\nBody: ${m.snippet}\n\nMake it clear and action-oriented.`;

  const senderName = (m.from.split(' <')[0] || m.from).trim();

  return (
    <Card accent="pink" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Avatar name={senderName} size={40} ring={m.unread ? 'cyan' : undefined} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--label)', fontSize: 16, fontWeight: 600,
            color: 'var(--ink)', lineHeight: 1.3,
          }}>{m.subject}</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
            marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline',
          }}>
            <span>from <b style={{ color: 'var(--ink)' }}>{senderName}</b></span>
            <span style={{ color: 'var(--ink-dim)' }}>· {new Date(m.received).toLocaleString()}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Chip tone="pink">MAIL</Chip>
          {m.unread && <Chip tone="gold">UNREAD</Chip>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Chip tone="dim">{m.account}</Chip>
        <Chip tone="dim">{m.mailbox}</Chip>
      </div>
      <div style={{
        fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink-2)',
        lineHeight: 1.55, maxHeight: 240, overflowY: 'auto',
        padding: '8px 0', borderTop: '1px solid var(--line-soft)',
        borderBottom: '1px solid var(--line-soft)',
      }}>
        {m.snippet || <span style={{ color: 'var(--ink-dim)' }}>(no preview available)</span>}
      </div>
      <Toolbar>
        <ToolbarButton
          tone="cyan"
          onClick={() => void copyToClipboard(
            [`Subject: ${m.subject}`, `From: ${m.from}`, '', m.snippet || '(no preview)'].join('\n'),
          )}
        >COPY</ToolbarButton>
        <ToolbarButton tone="violet" onClick={() => onAskSunny(`Summarize this email in one line and tell me if it needs action: from ${m.from} · ${m.subject} · ${m.snippet}`)}>SUMMARIZE</ToolbarButton>
        <ToolbarButton tone="amber" onClick={() => onAskSunny(`Extract any action items from this email: ${m.snippet}`)}>EXTRACT TODOS</ToolbarButton>
      </Toolbar>
      <InlineComposer
        contactDisplay={m.from.split('<')[0].trim() || m.from}
        onAskSunny={p => onAskSunny(p)}
        draftPrompt={draftPrompt}
      />
    </Card>
  );
}

// ─── Public export ────────────────────────────────────────────────────────────

export function ThreadPane({
  item,
  onAskSunny,
}: {
  readonly item: UnifiedItem | null;
  readonly onAskSunny: (prompt: string) => void;
}) {
  if (!item) {
    return (
      <EmptyState
        title="Select a message"
        hint="Pick any item on the left to preview. Click DRAFT WITH SUNNY to compose a reply."
      />
    );
  }

  if (item.kind === 'mail') {
    return <MailThreadPanel item={item} onAskSunny={onAskSunny} />;
  }

  return <ChatThreadPanel item={item} onAskSunny={onAskSunny} />;
}
