/**
 * Local heuristic triage classifier for Inbox items.
 *
 * Ships a cheap, purely-local labeller (urgent / important / later / ignore)
 * so the Inbox can render a consistent triage column on first paint without
 * round-tripping through the chat engine for every message. Real "ask Sunny"
 * triage still happens via the AI TRIAGE action button — this is the always-on,
 * free-of-latency baseline.
 *
 * Returns a memoised result keyed by the UnifiedItem id so re-renders during
 * polling don't re-classify thousands of items per second. Cache is bounded
 * and evicts oldest entries once full.
 */
import type { UnifiedItem } from './api';

export type TriageLabel = 'urgent' | 'important' | 'later' | 'ignore';

export type Triage = {
  readonly label: TriageLabel;
  readonly reason: string;
};

const URGENT_TOKENS = [
  'urgent', 'asap', 'immediately', 'critical', 'emergency',
  'action required', 'action needed', 'past due', 'overdue',
  'final notice', 'security alert', 'suspicious',
];

const IMPORTANT_TOKENS = [
  'invoice', 'contract', 'signature', 'approve', 'approval',
  'meeting', 'interview', 'offer', 'payment', 'deadline',
  'review', 'confirm',
];

const IGNORE_TOKENS = [
  'newsletter', 'unsubscribe', 'digest', 'weekly update', 'promo',
  'sale', 'discount', 'receipt', 'do-not-reply', 'noreply',
  'no-reply', 'notifications@', 'mailer-daemon',
];

const DAY = 86_400;

function matches(hay: string, needles: ReadonlyArray<string>): string | null {
  const lower = hay.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n)) return n;
  }
  return null;
}

function classifyMail(item: Extract<UnifiedItem, { kind: 'mail' }>): Triage {
  const m = item.data;
  const blob = `${m.subject} ${m.from} ${m.snippet}`;

  const ignoreHit = matches(blob, IGNORE_TOKENS);
  if (ignoreHit) return { label: 'ignore', reason: `contains "${ignoreHit}"` };

  const urgentHit = matches(blob, URGENT_TOKENS);
  if (urgentHit && m.unread) return { label: 'urgent', reason: `contains "${urgentHit}"` };

  const importantHit = matches(blob, IMPORTANT_TOKENS);
  if (importantHit) {
    return { label: m.unread ? 'important' : 'later', reason: `contains "${importantHit}"` };
  }
  if (m.unread) return { label: 'later', reason: 'unread' };
  return { label: 'ignore', reason: 'read, no signals' };
}

function classifyChat(item: Extract<UnifiedItem, { kind: 'chat' }>): Triage {
  const c = item.data;
  const now = Math.floor(Date.now() / 1000);
  const age = now - c.last_ts;

  const urgentHit = matches(c.last_message, URGENT_TOKENS);
  if (urgentHit && c.unread_count > 0) return { label: 'urgent', reason: `contains "${urgentHit}"` };

  if (c.unread_count > 0) {
    // Fresh unread inbound -> important. Older unread -> later.
    if (age < DAY) return { label: 'important', reason: `${c.unread_count} unread, fresh` };
    return { label: 'later', reason: `${c.unread_count} unread, older` };
  }

  if (age < DAY) return { label: 'later', reason: 'recent thread' };
  return { label: 'ignore', reason: 'read, stale' };
}

const CACHE_CAP = 512;
const cache = new Map<string, Triage>();

/** Classify a UnifiedItem. Memoised by item id. */
export function classify(item: UnifiedItem): Triage {
  const cached = cache.get(item.id);
  if (cached) return cached;
  const fresh = item.kind === 'mail' ? classifyMail(item) : classifyChat(item);
  if (cache.size >= CACHE_CAP) {
    // Evict the oldest — Map iteration order is insertion order.
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(item.id, fresh);
  return fresh;
}

export const TRIAGE_TONE: Record<TriageLabel, 'red' | 'amber' | 'violet' | 'dim'> = {
  urgent: 'red',
  important: 'amber',
  later: 'violet',
  ignore: 'dim',
};
