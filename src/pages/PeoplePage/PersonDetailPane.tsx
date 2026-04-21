/**
 * PersonDetailPane — right-side detail for a selected person.
 *
 * Shows conversation history (last-contact indicator), a notes field
 * backed by localStorage, and quick Sunny actions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Card, Chip, EmptyState, Toolbar, ToolbarButton, relTime } from '../_shared';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { askSunny } from '../../lib/askSunny';
import { copyToClipboard } from '../../lib/clipboard';
import type { Person } from './PersonCard';
import { warmth, TRIAGE_TONE_FOR_WARMTH } from './PersonCard';

type ConversationMessage = {
  readonly rowid: number;
  readonly text: string;
  readonly ts: number;
  readonly from_me: boolean;
  readonly has_attachment: boolean;
};

const NOTES_KEY = (handle: string) => `sunny:people:notes:${handle}`;
const LIMIT = 20;

function Bubble({ msg }: { readonly msg: ConversationMessage }) {
  const body = msg.text || (msg.has_attachment ? '[attachment]' : '—');
  const mine = msg.from_me;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: mine ? 'flex-end' : 'flex-start', gap: 2,
    }}>
      <div style={{
        maxWidth: '82%', padding: '6px 10px',
        fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.45,
        border: '1px solid', borderColor: mine ? 'var(--cyan)' : 'var(--line-soft)',
        background: mine ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.85)',
        color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>{body}</div>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.1em',
      }}>{relTime(msg.ts)}</span>
    </div>
  );
}

export function PersonDetailPane({ person }: { readonly person: Person | null }) {
  const [messages, setMessages] = useState<ReadonlyArray<ConversationMessage>>([]);
  const [notes, setNotes] = useState('');
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const prevHandleRef = useRef<string | null>(null);

  // Load notes from localStorage when person changes.
  useEffect(() => {
    if (!person) return;
    try {
      setNotes(localStorage.getItem(NOTES_KEY(person.handle)) ?? '');
    } catch {
      setNotes('');
    }
  }, [person?.handle]);

  const saveNotes = useCallback((val: string, handle: string) => {
    setNotes(val);
    try {
      localStorage.setItem(NOTES_KEY(handle), val);
    } catch {
      // quota — silently skip
    }
  }, []);

  const reload = useCallback(async () => {
    if (!person?.lastChat || !isTauri) return;
    const rows = await invokeSafe<ConversationMessage[]>(
      'messaging_fetch_conversation',
      { chatIdentifier: person.handle, limit: LIMIT },
      [],
    );
    setMessages(rows ?? []);
  }, [person?.handle, person?.lastChat]);

  useEffect(() => {
    if (!person) return;
    if (prevHandleRef.current !== person.handle) {
      prevHandleRef.current = person.handle;
      setMessages([]);
    }
    void reload();
    const h = window.setInterval(() => void reload(), 10_000);
    return () => clearInterval(h);
  }, [person?.handle, reload]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  if (!person) {
    return (
      <EmptyState
        title="Select a person"
        hint="Click any contact to view conversation history and notes."
      />
    );
  }

  const w = warmth(person.lastChat?.last_ts);
  const warmthTone = TRIAGE_TONE_FOR_WARMTH[w];
  const lastContactLabel = person.lastChat
    ? `Last contact ${relTime(person.lastChat.last_ts)}`
    : 'No conversation on record';

  return (
    <Card accent={w === 'warm' ? 'green' : w === 'cooling' ? 'amber' : w === 'cold' ? 'red' : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Header */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Avatar
          name={person.display}
          size={44}
          ring={w === 'warm' ? 'green' : w === 'cooling' ? 'amber' : w === 'cold' ? 'red' : 'dim'}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--display)', fontSize: 17, fontWeight: 700,
            color: 'var(--ink)', lineHeight: 1.2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{person.display}</div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
            display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4,
          }}>
            <span>{person.handle}</span>
            {person.lastChat && <span>· {person.lastChat.message_count} msgs</span>}
          </div>
        </div>
        <ToolbarButton
          tone="cyan"
          onClick={() => void copyToClipboard(person.handle)}
        >COPY HANDLE</ToolbarButton>
        <Chip tone={warmthTone}>{w}</Chip>
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10.5,
        color: w === 'cold' ? 'var(--red)' : 'var(--ink-2)',
        padding: '6px 10px',
        borderLeft: warmthTone === 'dim'
          ? '2px solid var(--line-soft)'
          : `2px solid var(--${warmthTone})`,
        background: 'rgba(6, 14, 22, 0.4)',
        letterSpacing: '0.04em',
      }}>{lastContactLabel}</div>

      {/* Conversation history */}
      <div style={{
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
        color: 'var(--ink-2)', fontWeight: 700, marginTop: 4,
      }}>RECENT MESSAGES</div>
      <div
        ref={transcriptRef}
        style={{
          border: '1px solid var(--line-soft)',
          background: 'rgba(4, 10, 16, 0.55)',
          padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
          overflowY: 'auto', minHeight: 80, maxHeight: 240, flex: '1 1 auto',
        }}
        aria-label="Conversation history"
      >
        {!person.lastChat ? (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
            letterSpacing: '0.18em', margin: 'auto',
          }}>NO THREAD</span>
        ) : messages.length === 0 ? (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)',
            letterSpacing: '0.18em', margin: 'auto',
          }}>LOADING…</span>
        ) : (
          messages.map(m => <Bubble key={m.rowid} msg={m} />)
        )}
      </div>

      {/* Notes */}
      <div style={{
        fontFamily: 'var(--display)', fontSize: 9, letterSpacing: '0.22em',
        color: 'var(--ink-2)', fontWeight: 700,
      }}>NOTES</div>
      <textarea
        value={notes}
        onChange={e => saveNotes(e.target.value, person.handle)}
        placeholder="Add private notes about this person…"
        rows={3}
        style={{
          width: '100%', boxSizing: 'border-box',
          fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink)',
          background: 'rgba(6, 14, 22, 0.7)',
          border: '1px solid var(--line-soft)',
          padding: 8, resize: 'vertical', minHeight: 56, maxHeight: 120,
        }}
      />

      {/* Actions */}
      <Toolbar>
        <ToolbarButton tone="cyan" onClick={() => askSunny(
          `Summarize everything you remember about ${person.display} (handle ${person.handle}) — recent topics, preferences, outstanding threads.`,
          'people',
        )}>BRIEF</ToolbarButton>
        <ToolbarButton tone="violet" onClick={() => askSunny(
          `Draft a warm check-in message to ${person.display}. Reference our last exchange if I have one.`,
          'people',
        )}>CHECK IN</ToolbarButton>
        <ToolbarButton tone="amber" onClick={() => askSunny(
          `Save three durable facts about ${person.display} to semantic memory based on our recent conversations.`,
          'people',
        )}>LEARN</ToolbarButton>
      </Toolbar>
    </Card>
  );
}
