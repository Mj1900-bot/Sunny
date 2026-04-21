// Proxy engine — the bridge between the chat.db watcher and the AI.
//
// Start the engine once near the top of the React tree. It subscribes to the
// Tauri `messages:new` event, pulls the latest config from `useProxy`, decides
// whether to DRAFT (show a SEND/EDIT/SKIP preview) or AUTO-SEND (direct fire),
// and logs the exchange.
//
// Guardrails — these are the rules that stop SUNNY from being a spam cannon:
//
//   • The Tauri watcher only fires for handles the frontend has registered
//     via `messages_watcher_set_subscriptions`. We only re-sync that set when
//     the set of ACTIVE handles changes (or the global kill switch flips).
//     Re-syncing on every cursor advance used to regress the backend's own
//     watermark and caused every recent message to be re-emitted, which in
//     turn produced the duplicate drafts users were seeing.
//
//   • `autoSend` messages are gated by a 30-second floor, the global kill
//     switch, and a per-contact mute.
//
//   • `enabledAt` is a hard floor on incoming `ts`. When the user turns a
//     proxy on for a contact, we never draft for messages that arrived
//     before that moment — even if the backend re-emits them.
//
//   • We short-circuit when the user has already replied (their own
//     `from_me` message is newer than the trigger). Any pending drafts for
//     that contact are cancelled.
//
//   • Per-handle in-flight flag so two fast incoming messages don't produce
//     two parallel LLM calls and two competing drafts.
//
//   • `autoSend` still goes through the ConfirmGate at HIGH risk so the
//     user always sees the exact body before we fire.

import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';

import { invoke, invokeSafe, isTauri } from './tauri';
import { chatFor } from './modelRouter';
import { useProxy, isProxyActive, type ProxyConfig } from '../store/proxy';
import { useProxyInbox } from '../store/proxyInbox';
import { useSafety } from '../store/safety';
import { invalidateContactsCache } from './contacts';

const AUTO_SEND_COOLDOWN_MS = 30_000;
const HISTORY_BEFORE_REPLY = 10;
/** How many `(handle, rowid)` keys we keep in the dedupe ring. */
const DEDUPE_RING_SIZE = 200;

type NewMessageEvent = Readonly<{
  chat_identifier: string;
  rowid: number;
  text: string;
  ts: number;
  sender: string | null;
  has_attachment: boolean;
}>;

type ConversationMessage = Readonly<{
  rowid: number;
  text: string;
  ts: number;
  from_me: boolean;
  sender: string | null;
  has_attachment: boolean;
}>;

let started = false;
let stopListener: UnlistenFn | null = null;
let unsubscribeStore: (() => void) | null = null;

/** Handles currently producing a draft. Prevents parallel LLM calls per chat. */
const inFlight = new Set<string>();
/**
 * Ring buffer of `handle:rowid` keys we've already processed. The backend's
 * cursor *should* prevent re-emits, but belt-and-braces: if a re-emit slips
 * through, we swallow it here rather than drafting twice.
 */
const seenKeys: string[] = [];
const seenSet = new Set<string>();

function markSeen(key: string): void {
  if (seenSet.has(key)) return;
  seenSet.add(key);
  seenKeys.push(key);
  while (seenKeys.length > DEDUPE_RING_SIZE) {
    const evicted = seenKeys.shift();
    if (evicted !== undefined) seenSet.delete(evicted);
  }
}

export async function startProxyEngine(): Promise<void> {
  if (started || !isTauri) return;
  started = true;

  stopListener = await listen<NewMessageEvent>('messages:new', evt => {
    void handleIncoming(evt.payload);
  });

  // Sync the watcher's subscription set with the proxy store ONLY when the
  // active set of handles changes (or the global kill switch flips). The
  // cursor itself is advanced backend-side as the watcher emits rows — we
  // must never push a stale frontend cursor back down, or we'll replay
  // messages that were already delivered.
  let lastMembership = '';
  const resync = async () => {
    const { configs, globalEnabled } = useProxy.getState();
    if (!globalEnabled) {
      await invokeSafe('messages_watcher_set_subscriptions', { subscriptions: [] });
      return;
    }
    const active = configs.filter(c => c.enabled);
    const subs = active.map(c => ({
      chat_identifier: c.handle,
      // For a handle we've seen before, pass the stored watermark. For a
      // brand-new enable the frontend may not have a cursor yet; `0` here
      // is safe because the engine will drop any message older than the
      // `enabledAt` stamp inside `handleIncoming`.
      since_rowid: c.lastSeenRowid ?? 0,
    }));
    await invokeSafe('messages_watcher_set_subscriptions', { subscriptions: subs });
  };

  unsubscribeStore = useProxy.subscribe(state => {
    // Key on membership only — never on `lastSeenRowid`. Advancing the
    // cursor is a normal side-effect of every emitted message and must not
    // cause us to rewrite the backend's subscription list.
    const membership = `${state.globalEnabled}::${state.configs
      .filter(c => c.enabled)
      .map(c => c.handle)
      .sort()
      .join('|')}`;
    if (membership !== lastMembership) {
      lastMembership = membership;
      void resync();
    }
  });

  // Seed the initial membership key so the first real change triggers a push.
  const s0 = useProxy.getState();
  lastMembership = `${s0.globalEnabled}::${s0.configs
    .filter(c => c.enabled)
    .map(c => c.handle)
    .sort()
    .join('|')}`;

  // Initial sync — this is the one time we push cursors to the backend per
  // session. After this, the backend owns the cursor.
  await resync();
}

export function stopProxyEngine(): void {
  if (stopListener) {
    stopListener();
    stopListener = null;
  }
  if (unsubscribeStore) {
    unsubscribeStore();
    unsubscribeStore = null;
  }
  inFlight.clear();
  seenKeys.length = 0;
  seenSet.clear();
  started = false;
}

async function handleIncoming(evt: NewMessageEvent): Promise<void> {
  const { configs, globalEnabled } = useProxy.getState();
  const cfg = configs.find(c => c.handle === evt.chat_identifier);
  if (!isProxyActive(cfg, globalEnabled) || !cfg) return;

  // 1. Dedupe — we've already processed this row in this session.
  const dedupeKey = `${evt.chat_identifier}:${evt.rowid}`;
  if (seenSet.has(dedupeKey)) return;

  // 2. Watermark — the backend's own cursor should block this, but defend
  //    anyway in case of a restart with a stale frontend cursor.
  if (cfg.lastSeenRowid !== undefined && evt.rowid <= cfg.lastSeenRowid) return;

  // 3. Hard floor on `ts` — never draft for a message that predates the
  //    moment the user turned this proxy on. `evt.ts` is seconds since
  //    epoch; `cfg.enabledAt` is ms. A 30s fudge covers clock skew and the
  //    poll interval.
  if (cfg.enabledAt !== undefined) {
    const enabledTs = Math.floor(cfg.enabledAt / 1000) - 30;
    if (evt.ts < enabledTs) {
      useProxy.getState().setLastSeen(evt.chat_identifier, evt.rowid);
      markSeen(dedupeKey);
      return;
    }
  }

  // 4. Per-handle in-flight guard. Multiple messages arriving in a burst
  //    would otherwise each spin up their own LLM draft. Instead we let the
  //    first complete; the next tick will pick up the newer trigger via
  //    the advanced cursor.
  if (inFlight.has(evt.chat_identifier)) return;
  inFlight.add(evt.chat_identifier);

  // Mark seen immediately so in-session retries on the same (handle,rowid)
  // don't respawn a draft. The persistent watermark, however, must only
  // advance once the draft pipeline has actually completed — otherwise a
  // mid-pipeline failure would leave the watermark ahead of a message that
  // never produced a draft, and the NEXT incoming message from the same
  // contact would be silently dropped by the `evt.rowid <= lastSeenRowid`
  // guard above.
  markSeen(dedupeKey);

  // Latent-bug B1 fix: advance the watermark in a `finally` block that runs
  // only after `draftAndMaybeSend` completes (success, or errors it caught
  // internally). If the call throws uncaught, we leave the watermark where
  // it was so the same rowid is reconsidered on the next watcher tick.
  let completed = false;
  try {
    await draftAndMaybeSend(cfg, evt);
    completed = true;
  } finally {
    if (completed) {
      useProxy.getState().setLastSeen(evt.chat_identifier, evt.rowid);
    }
    inFlight.delete(evt.chat_identifier);
  }
}

async function draftAndMaybeSend(cfg: ProxyConfig, evt: NewMessageEvent): Promise<void> {
  const triggerText = evt.text.trim() || (evt.has_attachment ? '[attachment]' : '');
  if (triggerText.length === 0) return;

  const history = await loadHistory(evt.chat_identifier);

  // 5. User already replied? `fetch_conversation` returns oldest→newest, so
  //    the last entry is the most recent message. If that's from the user
  //    and at-or-after this trigger, the user has handled the conversation
  //    themselves — cancel any older pending drafts and bail.
  const last = history[history.length - 1];
  if (last && last.from_me && last.ts >= evt.ts) {
    useProxyInbox.getState().cancelPendingForHandle(cfg.handle, 'user-sent');
    return;
  }

  // 6. Cancel any prior pending drafts for this contact. The newer message
  //    supersedes them — showing three stale suggestions for three messages
  //    in a burst is exactly the clutter the user asked us to fix.
  useProxyInbox.getState().cancelPendingForHandle(cfg.handle, 'superseded');

  const prompt = buildReplyPrompt(cfg, triggerText, history);
  const draftBody = await chatFor('planning', prompt);
  if (!draftBody) {
    useProxyInbox.getState().addDraft({
      handle: cfg.handle,
      body: '(proxy unavailable — re-open the conversation to retry)',
      triggerText,
      triggerRowid: evt.rowid,
    });
    return;
  }

  const cleaned = cleanDraft(draftBody);
  if (cleaned.length === 0) {
    useProxyInbox.getState().addDraft({
      handle: cfg.handle,
      body: '(SUNNY chose not to reply)',
      triggerText,
      triggerRowid: evt.rowid,
    });
    return;
  }

  // Re-check "user already replied" after the LLM round-trip. It's common
  // for the user to type something while the model is thinking.
  const fresh = await loadHistory(evt.chat_identifier);
  const freshLast = fresh[fresh.length - 1];
  if (freshLast && freshLast.from_me && freshLast.ts >= evt.ts) {
    useProxyInbox.getState().cancelPendingForHandle(cfg.handle, 'user-sent');
    return;
  }

  const draftId = useProxyInbox.getState().addDraft({
    handle: cfg.handle,
    body: cleaned,
    triggerText,
    triggerRowid: evt.rowid,
  });

  const now = Date.now();
  const lastSent = cfg.lastSentAt ?? 0;
  const willAutoSend = cfg.autoSend && now - lastSent >= AUTO_SEND_COOLDOWN_MS;

  if (!willAutoSend) {
    const preview = cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
    await invokeSafe('notify_send', {
      title: `Draft ready for ${cfg.display}`,
      body: preview,
      sound: 'Ping',
    });
    return;
  }

  const approved = await useSafety.getState().request({
    title: `SUNNY PROXY: auto-reply to ${cfg.display}`,
    description:
      'SUNNY is about to send this reply on your behalf. Decline to keep it as a draft.',
    verb: 'SEND',
    preview: `${triggerText}\n\n→ ${cleaned}`,
    risk: 'high',
  });
  if (!approved) {
    useProxyInbox.getState().updateDraft(draftId, { status: 'skipped' });
    return;
  }
  try {
    await invoke<void>('messaging_send_imessage', { to: cfg.handle, body: cleaned });
    useProxy.getState().markAutoSent(cfg.handle);
    useProxyInbox.getState().updateDraft(draftId, { status: 'sent' });
    invalidateContactsCache();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useProxyInbox.getState().updateDraft(draftId, {
      status: 'error',
      errorMessage: msg,
    });
  }
}

async function loadHistory(handle: string): Promise<ReadonlyArray<ConversationMessage>> {
  const rows = await invokeSafe<ReadonlyArray<ConversationMessage>>(
    'messaging_fetch_conversation',
    { chatIdentifier: handle, limit: HISTORY_BEFORE_REPLY },
    [],
  );
  return rows ?? [];
}

function buildReplyPrompt(
  cfg: ProxyConfig,
  trigger: string,
  history: ReadonlyArray<ConversationMessage>,
): string {
  // Style sample — the user's own recent outgoing messages. Small models
  // mirror tone much better when they can see it, so drafts come out
  // feeling like the user rather than like a generic assistant.
  const userSamples = history
    .filter(m => m.from_me && m.text.trim().length > 0)
    .slice(-4)
    .map(m => m.text.trim());

  const lines: string[] = [];
  lines.push(
    'You are SUNNY, replying on behalf of the user in a private 1:1 text conversation.',
  );
  lines.push(`Persona: ${cfg.persona || 'Casual, concise, first-person.'}`);
  lines.push('');
  lines.push('Rules:');
  lines.push('- Output ONLY the reply text. No preamble, no quoting, no markdown, no role labels, no emojis unless the sender used one first.');
  lines.push('- Match the user\'s own texting style from the samples below (casing, punctuation, length).');
  lines.push('- Keep it under 2 short sentences unless the sender explicitly asked for detail.');
  lines.push('- If the message is ambiguous, ask ONE short clarifying question instead of guessing.');
  lines.push('- Never invent facts about the user\'s schedule, whereabouts, or opinions. If the answer requires facts you don\'t have, say the user will get back to them.');
  lines.push('- If no reply is warranted (e.g. a one-word acknowledgment), output an empty string.');
  if (userSamples.length > 0) {
    lines.push('');
    lines.push('User\'s recent replies (copy this tone):');
    for (const s of userSamples) lines.push(`- ${s}`);
  }
  lines.push('');
  lines.push(`Recent conversation with ${cfg.display} (oldest → newest):`);
  for (const m of history) {
    const who = m.from_me ? 'me' : cfg.display;
    const body = m.text || (m.has_attachment ? '[attachment]' : '');
    if (body) lines.push(`${who}: ${body}`);
  }
  lines.push(`${cfg.display}: ${trigger}`);
  lines.push('me:');
  return lines.join('\n');
}

/**
 * Some models wrap their reply in quotes, add "Reply:" prefixes, or echo
 * the role label back. Strip the common forms so the raw body goes out
 * as-is.
 */
function cleanDraft(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/i, '').trim();
  }
  // Strip surrounding straight- or smart-quotes.
  const quotePairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['\u201c', '\u201d'],
    ['\u2018', '\u2019'],
  ];
  for (const [l, r] of quotePairs) {
    if (s.length > 1 && s.startsWith(l) && s.endsWith(r)) {
      s = s.slice(1, -1).trim();
      break;
    }
  }
  // Strip role labels some models leak ("me:", "Reply:", "SUNNY:", etc.)
  s = s
    .replace(/^(me|you|user|sunny|reply|response|answer)\s*:\s*/i, '')
    .trim();
  // Collapse runs of blank lines — SMS/iMessage renders them ugly.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

export const __testing = { cleanDraft, buildReplyPrompt, handleIncoming };
