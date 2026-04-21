import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { useSunny } from '../../hooks/useSunny';
import { useSafety } from '../../store/safety';
import { invoke, invokeSafe, isTauri } from '../../lib/tauri';
import { invalidateContactsCache, isGroupChatIdentifier } from '../../lib/contacts';
import { useProxy } from '../../store/proxy';
import { useProxyInbox } from '../../store/proxyInbox';
import {
  ALPHABET,
  FALLBACK_CONTACTS,
  PRIVACY_PREFPANE_FALLBACK,
  PRIVACY_URL,
} from './constants';
import { ConversationDetail } from './ConversationDetail';
import { PermissionDenied } from './PermissionDenied';
import { CYAN_AVATAR, PLACEHOLDER_TEXT } from './styles';
import type { CallMode, LoadState, MessageContact } from './types';
import {
  avatarLetter,
  contactKey,
  escapeForAppleScript,
  firstLetter,
  isPermissionError,
  normaliseHandle,
  relativeTime,
} from './utils';

const CALL_COMMAND: Record<CallMode, string> = {
  phone: 'messaging_call_phone',
  facetime_audio: 'messaging_facetime_audio',
  facetime_video: 'messaging_facetime_video',
};

const CALL_LABEL: Record<CallMode, string> = {
  phone: 'Phone call',
  facetime_audio: 'FaceTime audio',
  facetime_video: 'FaceTime video',
};

export function ContactsPage() {
  const { runShell } = useSunny();
  const [contacts, setContacts] = useState<ReadonlyArray<MessageContact>>([]);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const cancelledRef = useRef(false);

  const loadContacts = useCallback(async () => {
    setState({ kind: 'loading' });

    if (!isTauri) {
      if (cancelledRef.current) return;
      setContacts(FALLBACK_CONTACTS);
      setState({ kind: 'ready', source: 'fallback' });
      return;
    }

    try {
      const rows = await invoke<ReadonlyArray<MessageContact>>('messages_recent', { limit: 100 });
      if (cancelledRef.current) return;
      setContacts(rows);
      setState({ kind: 'ready', source: 'messages' });
    } catch (e) {
      if (cancelledRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      if (isPermissionError(message)) {
        setState({ kind: 'denied' });
      } else {
        setState({ kind: 'error', message });
      }
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void loadContacts();
    return () => {
      cancelledRef.current = true;
    };
  }, [loadContacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return contacts;
    return contacts.filter(c =>
      c.handle.toLowerCase().includes(q) ||
      c.display.toLowerCase().includes(q) ||
      c.last_message.toLowerCase().includes(q),
    );
  }, [contacts, query]);

  // Left pane preserves recency order (server returns sorted by last_date DESC).
  const sorted = filtered;

  const availableLetters = useMemo(() => {
    const set = new Set<string>();
    for (const c of sorted) set.add(firstLetter(c.display));
    return set;
  }, [sorted]);

  const selected = useMemo(() => {
    if (selectedKey === null) return null;
    return sorted.find(c => contactKey(c) === selectedKey) ?? null;
  }, [sorted, selectedKey]);

  useEffect(() => {
    if (copied === null) return;
    const h = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(h);
  }, [copied]);

  // j/k step through the left-rail conversation list without stealing keys
  // from inputs (search box, composer). Scroll the newly-selected row into
  // view so the selection cursor is always visible.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editable = target?.isContentEditable === true;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) {
        return;
      }
      if (sorted.length === 0) return;
      e.preventDefault();
      const currentIdx = selectedKey === null
        ? -1
        : sorted.findIndex(c => contactKey(c) === selectedKey);
      const nextIdx = e.key === 'j'
        ? Math.min(sorted.length - 1, currentIdx + 1)
        : Math.max(0, currentIdx - 1);
      const next = sorted[nextIdx];
      if (!next) return;
      const nextKey = contactKey(next);
      setSelectedKey(nextKey);
      const node = rowRefs.current.get(nextKey);
      node?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedKey, sorted]);

  const jumpToLetter = useCallback(
    (letter: string) => {
      const target = sorted.find(c => firstLetter(c.display) === letter);
      if (!target) return;
      const node = rowRefs.current.get(contactKey(target));
      if (node && listRef.current) {
        node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [sorted],
  );

  const openInMessages = useCallback(
    async (handle: string) => {
      if (!isTauri) return;
      // Activate Messages.app first so the imessage:// URL lands in a ready window.
      const safe = escapeForAppleScript(handle);
      await invokeSafe<string>('applescript', {
        script: 'tell application "Messages" to activate',
      });
      const url = handle.includes('@')
        ? `imessage://${encodeURIComponent(handle)}`
        : `imessage://${encodeURIComponent(safe)}`;
      void runShell(`open "${url}"`);
    },
    [runShell],
  );

  const copyHandle = useCallback(async (handle: string) => {
    try {
      await navigator.clipboard.writeText(handle);
      setCopied('handle');
    } catch {
      // clipboard unavailable — silently no-op rather than crash UI
    }
  }, []);

  const sendText = useCallback(
    async (handle: string, body: string) => {
      if (!isTauri) return false;
      if (isGroupChatIdentifier(handle)) {
        // iMessage group-send requires a different AppleScript path; refuse
        // here rather than silently sending to no one.
        return false;
      }
      // Handles arrive in mixed forms (`+14155550102` vs `4155550102` vs
      // `Foo@bar.com`). Normalise both sides so the display label lookup
      // isn't a coin flip.
      const norm = normaliseHandle(handle);
      const target = contacts.find(c => normaliseHandle(c.handle) === norm);
      const label = target?.display ?? handle;
      const approved = await useSafety.getState().request({
        title: `Send iMessage to ${label}`,
        description: `SUNNY will send this message via Messages.app to ${handle}.`,
        verb: 'SEND',
        preview: body,
        risk: 'medium',
      });
      if (!approved) return false;
      try {
        await invoke<void>('messaging_send_imessage', { to: handle, body });
        // The user just replied themselves. Any proxy draft queued for
        // this contact is now stale — skip it so SUNNY doesn't fire a
        // second reply a few seconds later.
        useProxyInbox.getState().cancelPendingForHandle(handle, 'user-sent');
        invalidateContactsCache();
        return true;
      } catch (e) {
        console.error('messaging_send_imessage failed', e);
        return false;
      }
    },
    [contacts],
  );

  const call = useCallback(
    async (handle: string, mode: CallMode) => {
      if (!isTauri) return;
      if (isGroupChatIdentifier(handle)) return;
      const norm = normaliseHandle(handle);
      const target = contacts.find(c => normaliseHandle(c.handle) === norm);
      const label = target?.display ?? handle;
      const approved = await useSafety.getState().request({
        title: `${CALL_LABEL[mode]} to ${label}`,
        description: `SUNNY will initiate a ${CALL_LABEL[mode].toLowerCase()} via ${mode === 'phone' ? 'your paired iPhone' : 'FaceTime'}.`,
        verb: 'SEND',
        preview: handle,
        risk: 'medium',
      });
      if (!approved) return;
      await invokeSafe<void>(CALL_COMMAND[mode], { to: handle });
    },
    [contacts],
  );

  const openPrivacyPane = useCallback(async () => {
    if (!isTauri) return;
    // Primary: deep-link directly to Privacy → Full Disk Access.
    const primary = await invokeSafe<void>('open_path', { path: PRIVACY_URL });
    if (primary !== null) return;
    // Fallback 1: legacy Security prefPane (opens Security & Privacy).
    const fallback = await invokeSafe<void>('open_path', { path: PRIVACY_PREFPANE_FALLBACK });
    if (fallback !== null) return;
    // Fallback 2: shell out via `open` so we at least surface *something*.
    void runShell(`open "${PRIVACY_URL}"`);
  }, [runShell]);

  const proxyConfigs = useProxy(s => s.configs);
  const proxyGlobal = useProxy(s => s.globalEnabled);
  const setProxyGlobal = useProxy(s => s.setGlobalEnabled);
  const activeProxies = useMemo(
    () => proxyConfigs.filter(c => c.enabled).length,
    [proxyConfigs],
  );
  const totalUnread = useMemo(
    () => contacts.reduce((n, c) => n + Math.max(0, c.unread_count ?? 0), 0),
    [contacts],
  );

  const badge =
    state.kind === 'ready'
      ? [
          `${sorted.length}/${contacts.length}`,
          totalUnread > 0 ? `${totalUnread} UNREAD` : 'iMessage',
          activeProxies > 0
            ? `${activeProxies} PROXY${activeProxies === 1 ? '' : 'S'}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : state.kind === 'loading'
        ? 'SYNCING IMESSAGES…'
        : state.kind === 'denied'
          ? 'LOCKED'
          : 'ERROR';

  return (
    <ModuleView title="CONTACTS" badge={badge}>
      {proxyConfigs.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 12px',
            border: `1px solid ${proxyGlobal ? 'var(--cyan)' : '#ef4444'}`,
            background: proxyGlobal
              ? 'rgba(57, 229, 255, 0.05)'
              : 'rgba(239, 68, 68, 0.08)',
            marginBottom: 10,
          }}
          role="status"
          aria-live="polite"
        >
          <span
            style={{
              fontFamily: 'var(--display)',
              fontSize: 10.5,
              letterSpacing: '0.22em',
              fontWeight: 700,
              color: proxyGlobal ? 'var(--cyan)' : '#ef4444',
            }}
          >
            {proxyGlobal
              ? `SUNNY PROXY ACTIVE · ${activeProxies} contact${activeProxies === 1 ? '' : 's'}`
              : 'SUNNY PROXY PAUSED — no auto-replies will be drafted or sent'}
          </span>
          <button
            type="button"
            onClick={() => setProxyGlobal(!proxyGlobal)}
            style={{
              all: 'unset',
              cursor: 'pointer',
              marginLeft: 'auto',
              padding: '4px 10px',
              border: `1px solid ${proxyGlobal ? '#ef4444' : 'var(--cyan)'}`,
              fontFamily: 'var(--display)',
              fontSize: 10,
              letterSpacing: '0.2em',
              fontWeight: 700,
              color: proxyGlobal ? '#ef4444' : 'var(--cyan)',
              background: 'rgba(6, 14, 22, 0.6)',
            }}
            aria-pressed={!proxyGlobal}
          >
            {proxyGlobal ? 'PAUSE ALL' : 'RESUME'}
          </button>
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '380px 1fr',
          gap: 14,
          height: '100%',
          minHeight: 0,
        }}
      >
        {/* LEFT PANE — conversation list */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 10 }}>
          {state.kind === 'ready' && state.source === 'fallback' && (
            <div
              style={{
                border: '1px solid var(--line-soft)',
                background: 'rgba(57, 229, 255, 0.06)',
                color: 'var(--cyan)',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.18em',
                padding: '6px 10px',
                textAlign: 'center',
              }}
            >
              DEMO MODE · SAMPLE CONVERSATIONS
            </div>
          )}

          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="SEARCH · handle / message"
            aria-label="Search conversations"
          />

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 2,
              justifyContent: 'space-between',
              padding: '4px 6px',
              border: '1px solid var(--line-soft)',
              background: 'rgba(6, 14, 22, 0.5)',
            }}
            aria-label="Jump to letter"
          >
            {ALPHABET.split('').map(letter => {
              const active = availableLetters.has(letter);
              return (
                <button
                  key={letter}
                  type="button"
                  onClick={() => active && jumpToLetter(letter)}
                  disabled={!active}
                  style={{
                    all: 'unset',
                    cursor: active ? 'pointer' : 'default',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    padding: '2px 4px',
                    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                    opacity: active ? 1 : 0.4,
                  }}
                  aria-label={`Jump to ${letter}`}
                >
                  {letter}
                </button>
              );
            })}
          </div>

          <div
            ref={listRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              border: '1px solid var(--line-soft)',
              background: 'rgba(6, 14, 22, 0.5)',
            }}
          >
            {state.kind === 'loading' && (
              <div
                style={{
                  padding: 14,
                  color: 'var(--ink-dim)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  letterSpacing: '0.18em',
                }}
              >
                SYNCING IMESSAGES…
              </div>
            )}

            {state.kind === 'ready' && sorted.length === 0 && (
              <div
                style={{
                  padding: 16,
                  color: 'var(--ink-dim)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  letterSpacing: '0.2em',
                }}
              >
                NO RECENT CONVERSATIONS
              </div>
            )}

            {sorted.map(c => {
              const key = contactKey(c);
              const isSelected = key === selectedKey;
              return (
                <div
                  key={key}
                  ref={node => {
                    if (node) rowRefs.current.set(key, node);
                    else rowRefs.current.delete(key);
                  }}
                  className="list-row"
                  onClick={() => setSelectedKey(key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedKey(key);
                    }
                  }}
                  style={{
                    borderLeft: isSelected
                      ? '2px solid var(--cyan)'
                      : '2px solid transparent',
                    background: isSelected
                      ? 'rgba(57, 229, 255, 0.1)'
                      : undefined,
                    paddingLeft: 8,
                    display: 'grid',
                    gridTemplateColumns: '32px 1fr auto',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      ...CYAN_AVATAR,
                      width: 28,
                      height: 28,
                      border: '1px solid var(--cyan)',
                      background: 'rgba(57, 229, 255, 0.08)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                    }}
                    aria-hidden="true"
                  >
                    {avatarLetter(c.display)}
                  </div>
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        gap: 6,
                        alignItems: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: (c.unread_count ?? 0) > 0 ? 700 : 500,
                          color:
                            (c.unread_count ?? 0) > 0 ? 'var(--ink)' : undefined,
                        }}
                      >
                        {c.display}
                      </span>
                      {(c.unread_count ?? 0) > 0 && (
                        <span
                          aria-label={`${c.unread_count} unread`}
                          style={{
                            fontFamily: 'var(--mono)',
                            fontSize: 9.5,
                            fontWeight: 700,
                            letterSpacing: '0.1em',
                            padding: '1px 6px',
                            borderRadius: 8,
                            color: '#040a10',
                            background: 'var(--cyan)',
                            flexShrink: 0,
                          }}
                        >
                          {(c.unread_count ?? 0) > 99 ? '99+' : c.unread_count}
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 10.5,
                        color:
                          (c.unread_count ?? 0) > 0 ? 'var(--ink)' : 'var(--ink-2)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.last_message || '—'}
                    </span>
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 9.5,
                      color:
                        (c.unread_count ?? 0) > 0 ? 'var(--cyan)' : 'var(--ink-dim)',
                      letterSpacing: '0.12em',
                      whiteSpace: 'nowrap',
                      paddingRight: 8,
                      fontWeight: (c.unread_count ?? 0) > 0 ? 700 : 400,
                    }}
                  >
                    {relativeTime(c.last_ts)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT PANE — detail */}
        <div
          style={{
            border: '1px solid var(--line-soft)',
            background: 'rgba(6, 14, 22, 0.5)',
            padding: 20,
            overflow: 'auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {state.kind === 'loading' && (
            <div
              style={{
                margin: 'auto',
                textAlign: 'center',
                color: 'var(--ink-dim)',
                fontFamily: 'var(--mono)',
                fontSize: 13,
                letterSpacing: '0.18em',
              }}
            >
              <div style={{ ...PLACEHOLDER_TEXT, marginBottom: 10 }}>
                — SYNCING IMESSAGES —
              </div>
              <div>Reading ~/Library/Messages/chat.db…</div>
            </div>
          )}

          {state.kind === 'denied' && (
            <PermissionDenied
              onOpenSettings={openPrivacyPane}
              onRetry={loadContacts}
            />
          )}

          {state.kind === 'error' && (
            <div
              style={{
                margin: 'auto',
                maxWidth: 460,
                textAlign: 'center',
                color: 'var(--red, #ff6b6b)',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--display)',
                  letterSpacing: '0.3em',
                  marginBottom: 14,
                  fontSize: 16,
                  fontWeight: 700,
                }}
              >
                — LINK FAILED —
              </div>
              <div style={{ color: 'var(--ink-2)' }}>{state.message}</div>
            </div>
          )}

          {state.kind === 'ready' && selected === null && (
            <div style={{ margin: 'auto', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={PLACEHOLDER_TEXT}>— SELECT A CONVERSATION —</div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  color: 'var(--ink-dim)',
                  letterSpacing: '0.18em',
                }}
              >
                J / K TO STEP · ⌘↩ TO SEND
              </div>
            </div>
          )}

          {state.kind === 'ready' && selected !== null && (
            <ConversationDetail
              contact={selected}
              copiedLabel={copied}
              onCopyHandle={copyHandle}
              onOpenInMessages={openInMessages}
              onSendText={sendText}
              onCall={call}
            />
          )}
        </div>
      </div>
    </ModuleView>
  );
}
