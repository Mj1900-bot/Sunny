import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { isGroupChatIdentifier } from '../../lib/contacts';
import { ProxyPanel } from './ProxyPanel';
import { SmartReplyChips } from './SmartReplyChips';
import { CYAN_AVATAR } from './styles';
import type {
  ActionChipProps,
  CallMode,
  ConversationMessage,
  DetailProps,
  DetailRowProps,
} from './types';
import { avatarLetter, relativeTime } from './utils';

const TRANSCRIPT_LIMIT = 40;
const TRANSCRIPT_POLL_MS = 6_000;

// ─── Typing indicator (three pulsing dots) ───────────────────────────────────

function TypingIndicator() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '4px 8px',
      fontFamily: 'var(--mono)', fontSize: 10,
      color: 'var(--ink-dim)', letterSpacing: '0.1em',
    }}>
      <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
        {[0, 1, 2].map(i => (
          <span
            key={i}
            style={{
              width: 5, height: 5,
              borderRadius: '50%',
              background: 'var(--cyan)',
              opacity: 0.6,
              animation: `pulseDot 1.4s ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </span>
      <span>composing…</span>
    </div>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function ConversationDetail({
  contact,
  copiedLabel,
  onCopyHandle,
  onOpenInMessages,
  onSendText,
  onCall,
}: DetailProps) {
  const serviceLabel = contact.is_imessage ? 'iMessage' : 'SMS';
  const serviceColor = contact.is_imessage ? 'var(--cyan)' : '#4ade80';
  const isGroup = isGroupChatIdentifier(contact.handle);

  const [messages, setMessages] = useState<ReadonlyArray<ConversationMessage>>([]);
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [callInflight, setCallInflight] = useState<CallMode | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSelectedHandle = useRef<string | null>(null);
  const typingTimer = useRef<number | null>(null);

  const reloadTranscript = useCallback(async () => {
    if (!isTauri) return;
    const rows = await invokeSafe<ReadonlyArray<ConversationMessage>>(
      'messaging_fetch_conversation',
      { chatIdentifier: contact.handle, limit: TRANSCRIPT_LIMIT },
      [],
    );
    setMessages(rows ?? []);
  }, [contact.handle]);

  useEffect(() => {
    if (lastSelectedHandle.current !== contact.handle) {
      lastSelectedHandle.current = contact.handle;
      setComposerText('');
      setSendError(null);
      setMessages([]);
      setIsTyping(false);
      if (typeof window !== 'undefined') {
        window.setTimeout(() => composerRef.current?.focus(), 0);
      }
    }
    void reloadTranscript();
    const h = window.setInterval(() => void reloadTranscript(), TRANSCRIPT_POLL_MS);
    return () => window.clearInterval(h);
  }, [contact.handle, reloadTranscript]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  // Typing indicator: show dots while composerText is non-empty, clear after
  // 2.5s idle to avoid permanent dots when the user stops typing.
  const handleComposerChange = useCallback((val: string) => {
    setComposerText(val);
    if (val.trim().length > 0) {
      setIsTyping(true);
      if (typingTimer.current !== null) clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => setIsTyping(false), 2_500);
    } else {
      setIsTyping(false);
      if (typingTimer.current !== null) clearTimeout(typingTimer.current);
    }
  }, []);

  useEffect(() => () => {
    if (typingTimer.current !== null) clearTimeout(typingTimer.current);
  }, []);

  const handleSend = useCallback(async () => {
    const body = composerText.trim();
    if (body.length === 0 || sending) return;
    setSending(true);
    setSendError(null);
    setIsTyping(false);
    try {
      const ok = await onSendText(contact.handle, body);
      if (ok) {
        setComposerText('');
        window.setTimeout(() => void reloadTranscript(), 600);
      } else {
        setSendError('Send declined or failed.');
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [composerText, contact.handle, onSendText, reloadTranscript, sending]);

  const handleCall = useCallback(
    async (mode: CallMode) => {
      if (callInflight) return;
      setCallInflight(mode);
      try {
        await onCall(contact.handle, mode);
      } finally {
        setCallInflight(null);
      }
    },
    [callInflight, contact.handle, onCall],
  );

  const subtitle = useMemo(() => {
    const rel = relativeTime(contact.last_ts);
    return `${contact.message_count} MSGS · ${rel || 'UNKNOWN'}`;
  }, [contact.last_ts, contact.message_count]);

  // Last incoming message (from_me === false) for SmartReplyChips.
  const lastIncoming = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && !m.from_me && m.text) return m.text;
    }
    return contact.last_message ?? '';
  }, [messages, contact.last_message]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0, flex: 1 }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
        <div
          style={{
            ...CYAN_AVATAR,
            width: 72, height: 72,
            border: '1px solid var(--cyan)',
            boxShadow: '0 0 18px rgba(57, 229, 255, 0.25)',
            background: 'rgba(57, 229, 255, 0.05)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26,
          }}
          aria-hidden="true"
        >
          {avatarLetter(contact.display)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 17, fontWeight: 700,
            letterSpacing: '0.06em', color: 'var(--ink)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {contact.display}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, color: serviceColor,
              letterSpacing: '0.22em', fontWeight: 700, padding: '2px 8px',
              border: `1px solid ${serviceColor}`,
              background: contact.is_imessage
                ? 'rgba(57, 229, 255, 0.08)' : 'rgba(74, 222, 128, 0.08)',
            }}>
              {serviceLabel.toUpperCase()}
            </span>
            {isGroup && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9.5, color: '#f59e0b',
                letterSpacing: '0.22em', fontWeight: 700, padding: '2px 8px',
                border: '1px solid #f59e0b', background: 'rgba(245, 158, 11, 0.08)',
              }}>GROUP</span>
            )}
            {(contact.unread_count ?? 0) > 0 && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9.5, color: '#040a10',
                background: 'var(--cyan)', letterSpacing: '0.18em', fontWeight: 700, padding: '2px 8px',
              }} aria-label={`${contact.unread_count} unread`}>
                {(contact.unread_count ?? 0) > 99 ? '99+' : contact.unread_count} UNREAD
              </span>
            )}
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', letterSpacing: '0.18em',
            }}>{subtitle}</span>
          </div>
        </div>
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <ActionChip label="CALL" disabled={isGroup || callInflight !== null} onClick={() => void handleCall('phone')} />
        <ActionChip
          label={callInflight === 'facetime_audio' ? 'DIALING…' : 'FACETIME AUDIO'}
          disabled={isGroup || callInflight !== null}
          onClick={() => void handleCall('facetime_audio')}
        />
        <ActionChip
          label={callInflight === 'facetime_video' ? 'DIALING…' : 'FACETIME VIDEO'}
          disabled={isGroup || callInflight !== null}
          onClick={() => void handleCall('facetime_video')}
        />
        <ActionChip
          label="SPEAK FOR ME"
          disabled={true}
          onClick={() => undefined}
          title="Coming soon — requires a virtual-audio device + consent workflow."
        />
        <ActionChip label="OPEN IN MESSAGES" onClick={() => onOpenInMessages(contact.handle)} />
        <ActionChip
          label={copiedLabel === 'handle' ? 'COPIED' : 'COPY HANDLE'}
          onClick={() => onCopyHandle(contact.handle)}
        />
      </div>

      {/* Handle row */}
      <DetailRow
        label="HANDLE"
        value={contact.handle}
        copied={copiedLabel === 'handle'}
        onCopy={() => onCopyHandle(contact.handle)}
      />

      {/* SUNNY Proxy configuration */}
      {!isGroup && <ProxyPanel contact={contact} />}

      {/* Transcript */}
      <div
        ref={transcriptRef}
        style={{
          border: '1px solid var(--line-soft)',
          background: 'rgba(4, 10, 16, 0.55)',
          padding: 12,
          display: 'flex', flexDirection: 'column', gap: 8,
          overflowY: 'auto', minHeight: 120, maxHeight: 360,
          flex: '1 1 auto',
        }}
        aria-label="Conversation transcript"
      >
        {messages.length === 0 ? (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
            letterSpacing: '0.2em', margin: 'auto',
          }}>
            NO VISIBLE MESSAGES
          </span>
        ) : (
          messages.map(m => <TranscriptBubble key={m.rowid} message={m} isGroup={isGroup} />)
        )}
      </div>

      {/* Smart Reply chips */}
      {!isGroup && lastIncoming && (
        <SmartReplyChips
          contactDisplay={contact.display}
          lastIncomingMessage={lastIncoming}
          onInsert={text => setComposerText(prev => prev ? `${prev} ${text}` : text)}
        />
      )}

      {/* Typing indicator */}
      {isTyping && <TypingIndicator />}

      {/* Composer */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        borderTop: '1px solid var(--line-soft)', paddingTop: 10,
      }}>
        <textarea
          ref={composerRef}
          value={composerText}
          onChange={e => handleComposerChange(e.target.value)}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={`Reply to ${contact.display}… (⌘↩ to send)`}
          rows={2}
          aria-label={`Reply to ${contact.display}`}
          style={{
            width: '100%', boxSizing: 'border-box',
            fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink)',
            background: 'rgba(6, 14, 22, 0.7)',
            border: '1px solid var(--line-soft)',
            padding: 10, resize: 'vertical', minHeight: 44, maxHeight: 160,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ActionChip
            label={sending ? 'SENDING…' : 'SEND'}
            disabled={sending || composerText.trim().length === 0}
            onClick={() => void handleSend()}
          />
          {sendError && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10.5, color: '#ff6b6b', letterSpacing: '0.05em',
            }} role="alert">{sendError}</span>
          )}
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
            letterSpacing: '0.18em', marginLeft: 'auto',
          }}>{composerText.length} CHARS</span>
        </div>
      </div>
    </div>
  );
}

function TranscriptBubble({ message, isGroup }: Readonly<{ message: ConversationMessage; isGroup: boolean }>) {
  const mine = message.from_me;
  const body = message.text || (message.has_attachment ? '[attachment]' : '');
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: mine ? 'flex-end' : 'flex-start', gap: 2,
    }}>
      {isGroup && !mine && message.sender && (
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)', letterSpacing: '0.12em',
        }}>{message.sender}</span>
      )}
      <div style={{
        maxWidth: '82%', padding: '6px 10px',
        fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.45,
        border: '1px solid', borderColor: mine ? 'var(--cyan)' : 'var(--line-soft)',
        background: mine ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.85)',
        color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {body || '—'}
      </div>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.1em',
      }}>{relativeTime(message.ts)}</span>
    </div>
  );
}

function DetailRow({ label, value, copied, onCopy }: DetailRowProps) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '70px 1fr auto', gap: 14,
      alignItems: 'center', padding: '8px 10px',
      border: '1px solid var(--line-soft)', background: 'rgba(4, 10, 16, 0.55)',
    }}>
      <span style={{
        fontFamily: 'var(--display)', fontSize: 9.5, letterSpacing: '0.22em',
        color: 'var(--ink-dim)', fontWeight: 700,
      }}>{label}</span>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
      <button
        type="button"
        onClick={onCopy}
        style={{
          all: 'unset', cursor: 'pointer', padding: '4px 12px',
          border: `1px solid ${copied ? 'var(--cyan)' : 'var(--line)'}`,
          color: 'var(--cyan)', fontFamily: 'var(--display)', fontSize: 10,
          letterSpacing: '0.22em', fontWeight: 700,
          background: copied
            ? 'rgba(57, 229, 255, 0.18)'
            : 'linear-gradient(90deg, rgba(57, 229, 255, 0.12), transparent)',
        }}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copied ? 'COPIED' : 'COPY'}
      </button>
    </div>
  );
}

function ActionChip({ label, disabled = false, onClick, title }: ActionChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        all: 'unset', cursor: disabled ? 'default' : 'pointer',
        padding: '6px 12px', border: '1px solid var(--line)',
        color: 'var(--cyan)', fontFamily: 'var(--display)', fontSize: 10.5,
        letterSpacing: '0.2em', fontWeight: 700,
        background: disabled
          ? 'rgba(57, 229, 255, 0.03)'
          : 'linear-gradient(90deg, rgba(57, 229, 255, 0.15), transparent)',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );
}
