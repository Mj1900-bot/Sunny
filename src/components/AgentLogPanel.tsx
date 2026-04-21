import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from './Panel';
import { useEventBus, type SunnyEvent } from '../hooks/useEventBus';

type Role = 'user' | 'sunny' | 'system' | 'tool';

type Message = {
  id: string;
  role: Role;
  text: string;
  ts: number;
  // Optional tool metadata (only set for role === 'tool')
  tool?: {
    name: string;
    argsSummary: string;
    status: 'running' | 'ok' | 'err';
    durationMs?: number;
  };
  // Marks a transient "thinking..." placeholder that gets replaced by first real chunk
  thinking?: boolean;
};

type ToolStartDetail = {
  tool: string;
  args: Record<string, unknown>;
};

type ToolEndDetail = {
  tool: string;
  ok: boolean;
  duration_ms: number;
};

type FilterMode = 'ALL' | 'CHAT' | 'TOOLS' | 'ERRORS';

const STORAGE_KEY = 'sunny.chat.history.v1';
const RENDER_LIMIT = 60;
const ARGS_TRUNCATE = 80;

const ROLE_LABEL: Record<Role, string> = {
  user: 'USER',
  sunny: 'SUNNY',
  system: 'SYSTEM',
  tool: 'TOOL',
};

const FILTER_CHIPS: ReadonlyArray<FilterMode> = ['ALL', 'CHAT', 'TOOLS', 'ERRORS'];

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRole(value: unknown): value is Role {
  return value === 'user' || value === 'sunny' || value === 'system' || value === 'tool';
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    isRole(m.role) &&
    typeof m.text === 'string' &&
    typeof m.ts === 'number'
  );
}

function isToolStartDetail(value: unknown): value is ToolStartDetail {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return typeof d.tool === 'string' && typeof d.args === 'object' && d.args !== null;
}

function isToolEndDetail(value: unknown): value is ToolEndDetail {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.tool === 'string' &&
    typeof d.ok === 'boolean' &&
    typeof d.duration_ms === 'number'
  );
}

function readHistory(): Message[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isMessage)
      .map(m => ({ id: m.id, role: m.role, text: m.text, ts: m.ts }));
  } catch (error) {
    console.error('AgentLogPanel: failed to read history', error);
    return [];
  }
}

function truncateArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    if (json.length <= ARGS_TRUNCATE) return json;
    return `${json.slice(0, ARGS_TRUNCATE - 1)}…`;
  } catch {
    return '{…}';
  }
}

function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const TOOL_STYLE: React.CSSProperties = {
  borderLeft: '2px solid var(--violet)',
  background: 'rgba(180,140,255,0.04)',
  paddingLeft: 8,
};

const SYSTEM_STYLE: React.CSSProperties = {
  borderLeft: '2px solid var(--red)',
  background: 'rgba(255,77,94,0.06)',
  paddingLeft: 8,
};

const META_STYLE: React.CSSProperties = {
  opacity: 0.5,
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.18em',
  float: 'right',
  marginLeft: 8,
};

const FILTER_BAR_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  padding: '4px 0 8px 0',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  marginBottom: 8,
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '2px 8px',
    fontFamily: 'var(--display)',
    fontSize: 9,
    letterSpacing: '0.22em',
    borderRadius: 2,
    cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.12)',
    background: active ? 'rgba(180,140,255,0.18)' : 'transparent',
    color: active ? 'var(--violet)' : 'inherit',
    opacity: active ? 1 : 0.6,
    userSelect: 'none',
  };
}

export function AgentLogPanel() {
  const [messages, setMessages] = useState<Message[]>(() => readHistory());
  const [filter, setFilter] = useState<FilterMode>('ALL');
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const streamingIdRef = useRef<string | null>(null);
  const thinkingIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const refreshFromStorage = useCallback(() => {
    setMessages(readHistory());
  }, []);

  // Poll once on mount to pick up any history written before we subscribed
  useEffect(() => {
    refreshFromStorage();
  }, [refreshFromStorage]);

  // Tick every 20s to refresh relative timestamps
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 20_000);
    return () => { window.clearInterval(id); };
  }, []);

  // Cross-tab/cross-component storage updates
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === STORAGE_KEY) refreshFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('storage', onStorage); };
  }, [refreshFromStorage]);

  // Stream chunks into an in-progress SUNNY message (ephemeral — writer owns
  // persistence). Sprint-9 migration: drives off the Rust event bus's
  // ChatChunk events via `useEventBus` instead of the legacy
  // `sunny://chat.chunk` / `sunny://chat.done` Tauri listeners. Bus events
  // carry `done: true` on the terminal chunk; we trigger storage resync
  // when we see that terminal frame.
  const chatChunkEvents = useEventBus({ kind: 'ChatChunk', limit: 500 });
  const lastSeenChunkKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (chatChunkEvents.length === 0) return;

    type ChatChunkEvent = Extract<SunnyEvent, { kind: 'ChatChunk' }>;
    const keyOf = (e: ChatChunkEvent): string =>
      typeof e.seq === 'number'
        ? `seq|${e.seq}`
        : `at|${e.at}|${e.turn_id}|${e.delta.length}|${e.done ? 1 : 0}`;

    // Events are newest-first — walk to gather anything after our last
    // seen key, then replay oldest-first so stream state evolves naturally.
    const lastSeen = lastSeenChunkKeyRef.current;
    const freshOldestFirst: ChatChunkEvent[] = [];
    for (const e of chatChunkEvents) {
      if (e.kind !== 'ChatChunk') continue;
      const key = keyOf(e);
      if (key === lastSeen) break;
      freshOldestFirst.unshift(e);
    }
    if (freshOldestFirst.length === 0) return;
    lastSeenChunkKeyRef.current = keyOf(
      freshOldestFirst[freshOldestFirst.length - 1],
    );

    let sawTerminal = false;
    for (const evt of freshOldestFirst) {
      const delta = typeof evt.delta === 'string' ? evt.delta : '';
      const done = evt.done === true;

      // Empty non-terminal chunk → show transient "thinking…" placeholder.
      if (!delta && !done) {
        setMessages(prev => {
          if (thinkingIdRef.current || streamingIdRef.current) return prev;
          const id = makeId();
          thinkingIdRef.current = id;
          return [
            ...prev,
            {
              id,
              role: 'sunny',
              text: 'SUNNY is thinking…',
              ts: Date.now(),
              thinking: true,
            },
          ];
        });
        continue;
      }

      if (done) {
        sawTerminal = true;
        // Terminal chunk on the bus may carry a trailing delta (providers
        // that split the final answer across a last delta + done) or be
        // empty. Fold any delta into the active stream, then clear the
        // streaming refs so the next turn starts clean.
        if (delta.length > 0) {
          setMessages(prev => {
            const activeId = streamingIdRef.current;
            if (activeId) {
              return prev.map(m =>
                m.id === activeId ? { ...m, text: m.text + delta } : m,
              );
            }
            const thinkingId = thinkingIdRef.current;
            if (thinkingId) {
              return prev.map(m =>
                m.id === thinkingId
                  ? { ...m, text: delta, thinking: false, ts: Date.now() }
                  : m,
              );
            }
            return [
              ...prev,
              { id: makeId(), role: 'sunny', text: delta, ts: Date.now() },
            ];
          });
        } else {
          // Zero-delta terminal chunk with no active stream but a
          // lingering thinking placeholder → clear it so we don't strand
          // "SUNNY is thinking…" in the log.
          const thinkingId = thinkingIdRef.current;
          if (thinkingId && !streamingIdRef.current) {
            setMessages(prev => prev.filter(m => m.id !== thinkingId));
          }
        }
        streamingIdRef.current = null;
        thinkingIdRef.current = null;
        continue;
      }

      // Mid-stream delta — append to active stream, or seed a new one.
      setMessages(prev => {
        const activeId = streamingIdRef.current;
        if (activeId) {
          return prev.map(m =>
            m.id === activeId ? { ...m, text: m.text + delta } : m,
          );
        }
        const thinkingId = thinkingIdRef.current;
        if (thinkingId) {
          thinkingIdRef.current = null;
          streamingIdRef.current = thinkingId;
          return prev.map(m =>
            m.id === thinkingId
              ? { ...m, text: delta, thinking: false, ts: Date.now() }
              : m,
          );
        }
        const id = makeId();
        streamingIdRef.current = id;
        return [...prev, { id, role: 'sunny', text: delta, ts: Date.now() }];
      });
    }

    if (sawTerminal) {
      // ChatPanel persists canonical history on chat.done — give it a
      // moment, then pull the authoritative copy from storage.
      window.setTimeout(refreshFromStorage, 50);
    }
  }, [chatChunkEvents, refreshFromStorage]);

  // Voice transcript -> local USER message (ChatPanel persists canonically)
  useEffect(() => {
    const onVoice = (e: Event): void => {
      const detail = (e as CustomEvent<string>).detail;
      const text = typeof detail === 'string' ? detail.trim() : '';
      if (!text) return;
      setMessages(prev => [
        ...prev,
        { id: makeId(), role: 'user', text, ts: Date.now() },
      ]);
      window.setTimeout(refreshFromStorage, 50);
    };
    window.addEventListener('sunny-voice-transcript', onVoice);
    return () => { window.removeEventListener('sunny-voice-transcript', onVoice); };
  }, [refreshFromStorage]);

  // Tool invocation start
  useEffect(() => {
    const onToolStart = (e: Event): void => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (!isToolStartDetail(detail)) return;
      const summary = truncateArgs(detail.args);
      setMessages(prev => [
        ...prev,
        {
          id: makeId(),
          role: 'tool',
          text: `${detail.tool}(${summary}) · running`,
          ts: Date.now(),
          tool: {
            name: detail.tool,
            argsSummary: summary,
            status: 'running',
          },
        },
      ]);
    };
    window.addEventListener('sunny-tool-start', onToolStart);
    return () => { window.removeEventListener('sunny-tool-start', onToolStart); };
  }, []);

  // Tool invocation end — update the most recent running tool for this name
  useEffect(() => {
    const onToolEnd = (e: Event): void => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (!isToolEndDetail(detail)) return;
      setMessages(prev => {
        // Find most recent running tool msg with matching name
        let targetIdx = -1;
        for (let i = prev.length - 1; i >= 0; i -= 1) {
          const m = prev[i];
          if (m.role === 'tool' && m.tool && m.tool.name === detail.tool && m.tool.status === 'running') {
            targetIdx = i;
            break;
          }
        }
        const status: 'ok' | 'err' = detail.ok ? 'ok' : 'err';
        const statusLabel = detail.ok ? 'ok' : 'err';
        if (targetIdx === -1) {
          // No matching start — append standalone end marker
          return [
            ...prev,
            {
              id: makeId(),
              role: 'tool',
              text: `${detail.tool}(…) · ${statusLabel} · ${detail.duration_ms}ms`,
              ts: Date.now(),
              tool: {
                name: detail.tool,
                argsSummary: '…',
                status,
                durationMs: detail.duration_ms,
              },
            },
          ];
        }
        return prev.map((m, idx) => {
          if (idx !== targetIdx || !m.tool) return m;
          return {
            ...m,
            text: `${m.tool.name}(${m.tool.argsSummary}) · ${statusLabel} · ${detail.duration_ms}ms`,
            tool: {
              ...m.tool,
              status,
              durationMs: detail.duration_ms,
            },
          };
        });
      });
    };
    window.addEventListener('sunny-tool-end', onToolEnd);
    return () => { window.removeEventListener('sunny-tool-end', onToolEnd); };
  }, []);

  // Voice / pipeline error -> system error message
  useEffect(() => {
    const onError = (e: Event): void => {
      const detail = (e as CustomEvent<unknown>).detail;
      const text = typeof detail === 'string' ? detail.trim() : '';
      if (!text) return;
      setMessages(prev => [
        ...prev,
        { id: makeId(), role: 'system', text, ts: Date.now() },
      ]);
    };
    window.addEventListener('sunny-voice-error', onError);
    return () => { window.removeEventListener('sunny-voice-error', onError); };
  }, []);

  // Auto-scroll to bottom on new/updated messages
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const filtered = useMemo(() => {
    if (filter === 'ALL') return messages;
    if (filter === 'CHAT') {
      return messages.filter(m => m.role === 'user' || m.role === 'sunny');
    }
    if (filter === 'TOOLS') return messages.filter(m => m.role === 'tool');
    return messages.filter(m => m.role === 'system');
  }, [messages, filter]);

  const visible = useMemo(
    () => (filtered.length > RENDER_LIMIT ? filtered.slice(-RENDER_LIMIT) : filtered),
    [filtered],
  );

  const turnCount = useMemo(
    () => messages.filter(m => m.role === 'user' || m.role === 'sunny').length,
    [messages],
  );
  const toolCount = useMemo(
    () => messages.filter(m => m.role === 'tool').length,
    [messages],
  );

  const badge = `${turnCount}T · ${toolCount}◆`;

  return (
    <Panel id="p-agent" title="CONVERSATION" right={badge}>
      <div style={FILTER_BAR_STYLE}>
        {FILTER_CHIPS.map(chip => (
          <button
            key={chip}
            type="button"
            onClick={() => setFilter(chip)}
            style={chipStyle(filter === chip)}
          >
            {chip}
          </button>
        ))}
      </div>
      <div className="log" ref={listRef}>
        {visible.length === 0 ? (
          <div
            className="m sunny"
            style={{
              opacity: 0.6,
              fontFamily: 'var(--display)',
              fontSize: 10,
              letterSpacing: '0.22em',
            }}
          >
            <div className="who">SUNNY</div>
            <div className="t">WAITING FOR FIRST MESSAGE</div>
          </div>
        ) : (
          visible.map(m => {
            const extraStyle: React.CSSProperties | undefined =
              m.role === 'tool'
                ? TOOL_STYLE
                : m.role === 'system'
                  ? SYSTEM_STYLE
                  : undefined;
            const textStyle: React.CSSProperties | undefined = m.thinking
              ? { opacity: 0.5, fontStyle: 'italic' }
              : undefined;
            return (
              <div key={m.id} className={`m ${m.role}`} style={extraStyle}>
                <div className="who">
                  {ROLE_LABEL[m.role]}
                  <span className="meta" style={META_STYLE}>
                    {relativeTime(m.ts, nowTick)}
                  </span>
                </div>
                <div className="t" style={textStyle}>{m.text}</div>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}
