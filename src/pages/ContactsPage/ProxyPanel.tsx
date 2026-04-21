// SUNNY PROXY panel — the per-contact auto-reply configuration surface.
//
// Mounted inside `ConversationDetail`. Lets the user:
//   - Toggle the proxy on/off for the selected contact.
//   - Snooze it for an hour without losing the persona/config.
//   - Edit the persona prompt that SUNNY uses when drafting replies.
//   - Flip auto-send (off by default — drafts land below for SEND/EDIT/SKIP).
//   - Review and act on the pending draft (only one per contact now — the
//     engine cancels stale drafts on new messages).
//
// UX notes:
//   - When the proxy is off, we collapse to a one-line CTA. No persona box,
//     no empty draft list. Enabling expands the full control surface.
//   - The header is one row: status pill + single action button. The old
//     design had three overlapping controls (pill + TURN OFF + AUTO-SEND
//     checkbox) all saying similar things; this consolidates them.
//   - Auto-send shows its cooldown countdown inline so the user knows
//     whether the next reply will fire silently or queue as a draft.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { invoke, isTauri } from '../../lib/tauri';
import { invalidateContactsCache } from '../../lib/contacts';
import { useSafety } from '../../store/safety';
import { DEFAULT_PERSONA, useProxy, type ProxyConfig } from '../../store/proxy';
import { useProxyInbox, type ProxyDraft } from '../../store/proxyInbox';
import { relativeTime } from './utils';
import type { MessageContact } from './types';

const AUTO_SEND_COOLDOWN_MS = 30_000;

export function ProxyPanel({ contact }: Readonly<{ contact: MessageContact }>) {
  const { config, rawConfig, upsert } = useProxyForHandle(contact);
  const muteUntil = useProxy(s => s.muteUntil);

  // Filter drafts per-handle in a memo — returning `.filter()` from a
  // selector would break `useSyncExternalStore`'s snapshot cache.
  const allDrafts = useProxyInbox(s => s.drafts);
  const drafts = useMemo(
    () => allDrafts.filter(d => d.handle === contact.handle),
    [allDrafts, contact.handle],
  );
  const updateDraft = useProxyInbox(s => s.updateDraft);
  const removeDraft = useProxyInbox(s => s.removeDraft);
  const cancelPending = useProxyInbox(s => s.cancelPendingForHandle);

  const toggleEnabled = () => {
    if (config.enabled) {
      // Cancel any queued drafts so the transcript doesn't show a stale
      // "pending" card for a proxy the user just turned off.
      cancelPending(contact.handle, 'superseded');
      upsert({ enabled: false });
    } else {
      upsert({ enabled: true });
    }
  };

  const toggleAutoSend = () => {
    if (!config.autoSend) {
      void useSafety.getState()
        .request({
          title: `Enable auto-send for ${contact.display}`,
          description:
            'SUNNY will send replies to this contact automatically (still gated by a 30-second cooldown and the global kill switch).',
          verb: 'EXECUTE',
          preview:
            'Auto-send messages on your behalf until you turn this off or pause the proxy globally.',
          risk: 'high',
        })
        .then(approved => {
          if (approved) upsert({ autoSend: true });
        });
      return;
    }
    upsert({ autoSend: false });
  };

  const snoozeOneHour = () => {
    muteUntil(contact.handle, Date.now() + 60 * 60 * 1000);
    cancelPending(contact.handle, 'superseded');
  };
  const clearSnooze = () => muteUntil(contact.handle, 0);

  const sendDraftNow = async (draft: ProxyDraft) => {
    if (!isTauri) return;
    const approved = await useSafety.getState().request({
      title: `Send drafted reply to ${contact.display}`,
      description: 'SUNNY drafted this reply in response to their last message.',
      verb: 'SEND',
      preview: draft.body,
      risk: 'medium',
    });
    if (!approved) {
      updateDraft(draft.id, { status: 'skipped' });
      return;
    }
    try {
      await invoke<void>('messaging_send_imessage', {
        to: contact.handle,
        body: draft.body,
      });
      updateDraft(draft.id, { status: 'sent' });
      invalidateContactsCache();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateDraft(draft.id, { status: 'error', errorMessage: msg });
    }
  };

  // Hooks must be called unconditionally, so compute `now` before any
  // early returns. We use a ticking "now" subscription so we can evaluate
  // `mutedUntil` and the auto-send cooldown inside render without calling
  // `Date.now()` directly (the React purity rule rightly flags that —
  // repeated render calls with different results cause unstable UI).
  const now = useNow(rawConfig?.mutedUntil && config.enabled ? 30_000 : null);

  // -------------- Disabled collapsed state --------------
  if (!config.enabled) {
    return (
      <section
        aria-label="SUNNY proxy configuration"
        style={{
          border: '1px solid var(--line-soft)',
          background: 'rgba(4, 10, 16, 0.45)',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--display)',
            fontSize: 10.5,
            letterSpacing: '0.28em',
            color: 'var(--ink-dim)',
            fontWeight: 700,
          }}
        >
          SUNNY PROXY
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink-2)',
            letterSpacing: '0.04em',
          }}
        >
          Off. Enable to auto-draft replies for {contact.display.split(' ')[0]}.
        </span>
        <button
          type="button"
          onClick={toggleEnabled}
          style={{ ...chipStyle(true), marginLeft: 'auto' }}
        >
          ENABLE
        </button>
      </section>
    );
  }

  // -------------- Enabled expanded state --------------
  const muted = !!rawConfig?.mutedUntil && rawConfig.mutedUntil > now;
  const accent = muted ? '#f59e0b' : 'var(--cyan)';

  return (
    <section
      aria-label="SUNNY proxy configuration"
      style={{
        border: `1px solid ${accent}`,
        background: 'rgba(4, 10, 16, 0.55)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <ProxyHeader
        contact={contact}
        muted={muted}
        mutedUntil={rawConfig?.mutedUntil}
        onToggle={toggleEnabled}
        onSnooze={snoozeOneHour}
        onUnsnooze={clearSnooze}
      />

      <AutoSendRow
        autoSend={config.autoSend}
        muted={muted}
        lastSentAt={rawConfig?.lastSentAt}
        onToggle={toggleAutoSend}
      />

      <PersonaEditor
        key={contact.handle}
        initial={config.persona}
        onCommit={value => upsert({ persona: value.trim() || DEFAULT_PERSONA })}
      />

      <DraftsList
        drafts={drafts}
        onSend={sendDraftNow}
        onSkip={d => updateDraft(d.id, { status: 'skipped' })}
        onEdit={(d, body) => updateDraft(d.id, { body })}
        onClear={removeDraft}
      />
    </section>
  );
}

// --------------------------------------------------------------------------
// Header
// --------------------------------------------------------------------------

function ProxyHeader({
  contact,
  muted,
  mutedUntil,
  onToggle,
  onSnooze,
  onUnsnooze,
}: Readonly<{
  contact: MessageContact;
  muted: boolean;
  mutedUntil: number | undefined;
  onToggle: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
}>) {
  // Re-render every 30s while muted so the "resumes in Xm" label ticks down.
  const now = useNow(muted ? 30_000 : null);
  const label = muted && mutedUntil
    ? `SNOOZED · RESUMES ${formatRelativeFuture(mutedUntil, now)}`
    : 'ACTIVE';
  const color = muted ? '#f59e0b' : 'var(--cyan)';

  return (
    <header style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span
        aria-label={`Proxy status for ${contact.display}`}
        style={{
          fontFamily: 'var(--display)',
          fontSize: 10.5,
          letterSpacing: '0.28em',
          color,
          fontWeight: 700,
        }}
      >
        SUNNY PROXY
      </span>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          color,
          letterSpacing: '0.2em',
          border: `1px solid ${color}`,
          padding: '1px 6px',
        }}
      >
        {label}
      </span>
      {muted ? (
        <button type="button" onClick={onUnsnooze} style={chipStyle(false)}>
          RESUME
        </button>
      ) : (
        <button
          type="button"
          onClick={onSnooze}
          style={chipStyle(false)}
          title="Silence drafts for 1 hour"
        >
          SNOOZE 1H
        </button>
      )}
      <button
        type="button"
        onClick={onToggle}
        style={{ ...chipStyle(false), marginLeft: 'auto' }}
        aria-pressed={true}
      >
        TURN OFF
      </button>
    </header>
  );
}

// --------------------------------------------------------------------------
// Auto-send row (with cooldown readout)
// --------------------------------------------------------------------------

function AutoSendRow({
  autoSend,
  muted,
  lastSentAt,
  onToggle,
}: Readonly<{
  autoSend: boolean;
  muted: boolean;
  lastSentAt: number | undefined;
  onToggle: () => void;
}>) {
  // Tick every second while cooling down so the countdown stays live.
  const cooldownRemaining = useCooldown(lastSentAt);
  const onCooldown = autoSend && cooldownRemaining > 0;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 8px',
        border: '1px solid var(--line-soft)',
        background: autoSend ? 'rgba(239, 68, 68, 0.05)' : 'rgba(6, 14, 22, 0.4)',
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          color: autoSend ? '#ef4444' : 'var(--ink-2)',
          letterSpacing: '0.06em',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={autoSend}
          onChange={onToggle}
          disabled={muted}
        />
        AUTO-SEND WITHOUT REVIEW
      </label>
      <span
        style={{
          marginLeft: 'auto',
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          color: 'var(--ink-dim)',
          letterSpacing: '0.12em',
        }}
      >
        {muted
          ? 'SNOOZED'
          : !autoSend
            ? 'DRAFTS QUEUE FOR REVIEW'
            : onCooldown
              ? `NEXT AUTO-SEND IN ${Math.ceil(cooldownRemaining / 1000)}s`
              : 'READY'}
      </span>
    </div>
  );
}

// --------------------------------------------------------------------------
// Persona editor with saved feedback
// --------------------------------------------------------------------------

function PersonaEditor({
  initial,
  onCommit,
}: Readonly<{
  initial: string;
  onCommit: (value: string) => void;
}>) {
  // `value` is the in-flight buffer. We reconcile with `initial` via the
  // component key (parent passes `key={contact.handle}`) so switching
  // contacts remounts cleanly — that avoids the "setState inside effect"
  // anti-pattern we'd otherwise need to sync props into state.
  const [value, setValue] = useState(initial);
  const [showSaved, setShowSaved] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  const commit = () => {
    const next = value.trim() || DEFAULT_PERSONA;
    if (next === initial) return;
    onCommit(next);
    setShowSaved(true);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShowSaved(false), 1400);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontFamily: 'var(--display)',
            fontSize: 9.5,
            letterSpacing: '0.22em',
            color: 'var(--ink-dim)',
            fontWeight: 700,
          }}
        >
          PERSONA
        </span>
        {showSaved && (
          <span
            role="status"
            aria-live="polite"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              color: '#4ade80',
              letterSpacing: '0.2em',
              fontWeight: 700,
            }}
          >
            SAVED
          </span>
        )}
      </div>
      <textarea
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        rows={2}
        placeholder={DEFAULT_PERSONA}
        aria-label="Persona prompt"
        style={{
          width: '100%',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--ink)',
          background: 'rgba(6, 14, 22, 0.7)',
          border: '1px solid var(--line-soft)',
          padding: 8,
          resize: 'vertical',
          minHeight: 40,
          maxHeight: 140,
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

// --------------------------------------------------------------------------
// Drafts
// --------------------------------------------------------------------------

function DraftsList({
  drafts,
  onSend,
  onSkip,
  onEdit,
  onClear,
}: Readonly<{
  drafts: ReadonlyArray<ProxyDraft>;
  onSend: (d: ProxyDraft) => void;
  onSkip: (d: ProxyDraft) => void;
  onEdit: (d: ProxyDraft, body: string) => void;
  onClear: (id: string) => void;
}>) {
  // The engine cancels older pending drafts whenever a newer trigger
  // arrives, so in practice `pending` is 0 or 1. Guard anyway.
  const pending = useMemo(() => drafts.filter(d => d.status === 'pending'), [drafts]);
  const history = useMemo(() => drafts.filter(d => d.status !== 'pending').slice(0, 5), [drafts]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span
        style={{
          fontFamily: 'var(--display)',
          fontSize: 9.5,
          letterSpacing: '0.22em',
          color: 'var(--ink-dim)',
          fontWeight: 700,
        }}
      >
        DRAFT{pending.length === 0 ? '' : 'S'} · {pending.length ? 'READY' : 'WAITING'}
      </span>
      {pending.length === 0 && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-dim)' }}>
          No draft yet. SUNNY will prepare one on the next inbound message.
        </span>
      )}
      {pending.map(d => (
        <PendingDraftCard
          // Rebuild the card when the draft body changes so the edit
          // buffer stays in sync without a setState-in-effect bridge.
          key={`${d.id}:${d.body.length}`}
          draft={d}
          onSend={() => onSend(d)}
          onSkip={() => onSkip(d)}
          onEdit={body => onEdit(d, body)}
        />
      ))}
      {history.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontFamily: 'var(--display)',
              fontSize: 9.5,
              letterSpacing: '0.22em',
              color: 'var(--ink-dim)',
              fontWeight: 700,
              marginTop: 6,
            }}
          >
            RECENT
          </span>
          {history.map(d => (
            <HistoryRow key={d.id} draft={d} onClear={() => onClear(d.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingDraftCard({
  draft,
  onSend,
  onSkip,
  onEdit,
}: Readonly<{
  draft: ProxyDraft;
  onSend: () => void;
  onSkip: () => void;
  onEdit: (body: string) => void;
}>) {
  const [editing, setEditing] = useState(false);
  const [buf, setBuf] = useState(draft.body);

  return (
    <div
      style={{
        border: '1px solid var(--cyan)',
        background: 'rgba(57, 229, 255, 0.06)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-dim)',
          letterSpacing: '0.05em',
        }}
      >
        In reply to: {draft.triggerText.slice(0, 180)}
        {draft.triggerText.length > 180 ? '…' : ''}
      </span>
      {editing ? (
        <textarea
          value={buf}
          onChange={e => setBuf(e.target.value)}
          rows={3}
          aria-label="Edit drafted reply"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            color: 'var(--ink)',
            background: 'rgba(6, 14, 22, 0.7)',
            border: '1px solid var(--line-soft)',
            padding: 8,
            resize: 'vertical',
            width: '100%',
            boxSizing: 'border-box',
          }}
        />
      ) : (
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            color: 'var(--ink)',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {draft.body}
        </span>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" onClick={onSend} style={chipStyle(true)}>
          SEND
        </button>
        {editing ? (
          <button
            type="button"
            onClick={() => {
              onEdit(buf);
              setEditing(false);
            }}
            style={chipStyle(false)}
          >
            SAVE EDIT
          </button>
        ) : (
          <button type="button" onClick={() => setEditing(true)} style={chipStyle(false)}>
            EDIT
          </button>
        )}
        <button type="button" onClick={onSkip} style={chipStyle(false)}>
          SKIP
        </button>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--mono)',
            fontSize: 9.5,
            color: 'var(--ink-dim)',
            letterSpacing: '0.1em',
            alignSelf: 'center',
          }}
        >
          {relativeTime(Math.floor(draft.createdAt / 1000))}
        </span>
      </div>
    </div>
  );
}

function HistoryRow({
  draft,
  onClear,
}: Readonly<{ draft: ProxyDraft; onClear: () => void }>) {
  const label: Record<ProxyDraft['status'], string> = {
    sent: 'SENT',
    skipped: 'SKIPPED',
    error: 'ERROR',
    pending: 'PENDING',
  };
  const color =
    draft.status === 'sent'
      ? '#4ade80'
      : draft.status === 'error'
        ? '#ef4444'
        : 'var(--ink-dim)';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '80px 1fr auto',
        gap: 10,
        alignItems: 'center',
        padding: '4px 8px',
        border: '1px solid var(--line-soft)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--display)',
          fontSize: 9,
          letterSpacing: '0.22em',
          color,
          fontWeight: 700,
        }}
      >
        {label[draft.status]}
      </span>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          color: 'var(--ink-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={draft.errorMessage ?? draft.body}
      >
        {draft.errorMessage ?? draft.body}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Dismiss entry"
        style={{
          all: 'unset',
          cursor: 'pointer',
          padding: '2px 6px',
          border: '1px solid var(--line-soft)',
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          color: 'var(--ink-dim)',
        }}
      >
        ×
      </button>
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    all: 'unset',
    cursor: 'pointer',
    padding: '4px 10px',
    border: `1px solid ${active ? 'var(--cyan)' : 'var(--line)'}`,
    fontFamily: 'var(--display)',
    fontSize: 10,
    letterSpacing: '0.2em',
    fontWeight: 700,
    color: active ? '#fff' : 'var(--cyan)',
    background: active
      ? 'linear-gradient(90deg, rgba(57, 229, 255, 0.3), rgba(57, 229, 255, 0.1))'
      : 'linear-gradient(90deg, rgba(57, 229, 255, 0.1), transparent)',
  };
}

// --------------------------------------------------------------------------
// Hook helpers
// --------------------------------------------------------------------------

type ProxyView = Readonly<{
  enabled: boolean;
  persona: string;
  autoSend: boolean;
}>;

function useProxyForHandle(contact: MessageContact): {
  config: ProxyView;
  rawConfig: ProxyConfig | undefined;
  upsert: (patch: Partial<ProxyView>) => void;
} {
  const existing = useProxy(s => s.configs.find(c => c.handle === contact.handle));
  const upsertStore = useProxy(s => s.upsert);
  const config: ProxyView = {
    enabled: existing?.enabled ?? false,
    persona: existing?.persona ?? DEFAULT_PERSONA,
    autoSend: existing?.autoSend ?? false,
  };
  const upsert = (patch: Partial<ProxyView>) => {
    upsertStore({
      handle: contact.handle,
      display: contact.display,
      ...patch,
    });
  };
  return { config, rawConfig: existing, upsert };
}

/**
 * Subscribe to wall-clock time through `useSyncExternalStore` so the
 * current `Date.now()` is available during render without violating the
 * `react-hooks/purity` rule. Pass `null` to pause ticking (render-time
 * reads still return a stable value inside a commit).
 */
function useNow(intervalMs: number | null): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (intervalMs === null) return () => undefined;
      const h = window.setInterval(onChange, intervalMs);
      return () => window.clearInterval(h);
    },
    [intervalMs],
  );
  return useSyncExternalStore(subscribe, getNowSnapshot, getNowSnapshot);
}

function getNowSnapshot(): number {
  return Date.now();
}

/**
 * Returns the ms remaining until auto-send is off cooldown, ticking
 * once a second while the cooldown is active.
 */
function useCooldown(lastSentAt: number | undefined): number {
  // The subscription ticks every 1s while a cooldown is outstanding.
  // `null` pauses ticking when there's no lastSentAt yet.
  const now = useNow(lastSentAt ? 1_000 : null);
  if (!lastSentAt) return 0;
  const elapsed = now - lastSentAt;
  return Math.max(0, AUTO_SEND_COOLDOWN_MS - elapsed);
}

function formatRelativeFuture(untilMs: number, now: number): string {
  const diff = Math.max(0, untilMs - now);
  const mins = Math.round(diff / 60_000);
  if (mins <= 0) return 'NOW';
  if (mins < 60) return `IN ${mins}M`;
  const hours = Math.round(mins / 60);
  return `IN ${hours}H`;
}
