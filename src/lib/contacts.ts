// Contact resolver: given a fuzzy name the user said to the AI ("text Sunny"),
// find the `MessageContact` entry it refers to. Used by the `text_contact` and
// `call_contact` tools and by the ContactsPage quick-reply composer.
//
// Match strategy (in order; first tier wins):
//   1. Exact case-insensitive match on `display`
//   2. Exact match on `handle` (after digit-normalising phones on both sides)
//   3. Case-insensitive prefix match on `display`
//   4. Case-insensitive substring match on `display`
//   5. Digit-substring match on the handle (e.g. "5551234" → +16045551234)
//
// If more than one entry is returned at the same tier, the result is
// `{ ambiguous: MessageContact[] }` so the caller (AI agent or UI) can ask
// the user to pick. Returning the structured list lets the agent do a
// follow-up tool call with the chosen handle without a round-trip through
// natural-language disambiguation.

import { invokeSafe, isTauri } from './tauri';
import type { MessageContact } from '../pages/ContactsPage/types';

export type ResolveHit = Readonly<{ kind: 'hit'; contact: MessageContact }>;
export type ResolveAmbiguous = Readonly<{ kind: 'ambiguous'; contacts: ReadonlyArray<MessageContact> }>;
export type ResolveMiss = Readonly<{ kind: 'miss' }>;
export type ResolveResult = ResolveHit | ResolveAmbiguous | ResolveMiss;

export type AddressBookEntry = Readonly<{ handle_key: string; name: string }>;

const CACHE_TTL_MS = 15_000;
const ADDRESS_BOOK_TTL_MS = 120_000;

type Cache = {
  contacts: ReadonlyArray<MessageContact>;
  fetchedAt: number;
};

type AddressBookCache = {
  entries: ReadonlyArray<AddressBookEntry>;
  fetchedAt: number;
};

let cache: Cache | null = null;
let addressBookCache: AddressBookCache | null = null;

/**
 * Load the recent-contacts list, caching briefly so repeated tool calls in the
 * same agent turn don't re-hit chat.db. Falls back to an empty list when
 * outside Tauri (browser preview).
 */
export async function loadContacts(): Promise<ReadonlyArray<MessageContact>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.contacts;
  }
  if (!isTauri) {
    cache = { contacts: [], fetchedAt: Date.now() };
    return cache.contacts;
  }
  const rows = await invokeSafe<ReadonlyArray<MessageContact>>('messages_recent', { limit: 200 }, []);
  const contacts = rows ?? [];
  cache = { contacts, fetchedAt: Date.now() };
  return contacts;
}

/** Force-refresh the cache on next call. Used after sends so outgoing messages appear. */
export function invalidateContactsCache(): void {
  cache = null;
  addressBookCache = null;
}

/**
 * Snapshot of the macOS AddressBook. Cached a bit longer than the messages
 * cache since contacts change much less often than the message stream.
 */
export async function loadAddressBook(): Promise<ReadonlyArray<AddressBookEntry>> {
  if (addressBookCache && Date.now() - addressBookCache.fetchedAt < ADDRESS_BOOK_TTL_MS) {
    return addressBookCache.entries;
  }
  if (!isTauri) {
    addressBookCache = { entries: [], fetchedAt: Date.now() };
    return addressBookCache.entries;
  }
  const entries = await invokeSafe<ReadonlyArray<AddressBookEntry>>('contacts_book_list', {}, []);
  addressBookCache = { entries: entries ?? [], fetchedAt: Date.now() };
  return addressBookCache.entries;
}

export async function resolveContact(query: string): Promise<ResolveResult> {
  const q = query.trim();
  if (q.length === 0) return { kind: 'miss' };
  const [contacts, address] = await Promise.all([loadContacts(), loadAddressBook()]);

  // First pass: match against recent chats (preserves recency + last-message
  // context). This is the best possible hit — the AI can text them right back.
  const primary = matchContacts(q, contacts);
  if (primary.kind === 'hit') return primary;
  if (primary.kind === 'ambiguous') return primary;

  // Fallback: search AddressBook so "text Mom" resolves even when the last
  // message from Mom has rolled off the recent list. Synthesize lightweight
  // MessageContact entries so the downstream agent tool sees a uniform shape.
  const fallback = matchAddressBook(q, address);
  return fallback;
}

/** Pure function — exposed for unit tests. */
export function matchContacts(
  query: string,
  contacts: ReadonlyArray<MessageContact>,
): ResolveResult {
  const q = query.trim();
  if (q.length === 0 || contacts.length === 0) return { kind: 'miss' };
  const qLower = q.toLowerCase();
  const qDigits = digitsOnly(q);

  // Tier 1: exact display match (case-insensitive)
  const exact = contacts.filter(c => c.display.toLowerCase() === qLower);
  if (exact.length > 0) return narrow(exact);

  // Tier 2: exact handle match after digit normalisation
  if (qDigits.length >= 7) {
    const handleExact = contacts.filter(c => digitsOnly(c.handle) === qDigits);
    if (handleExact.length > 0) return narrow(handleExact);
  }
  // Also allow exact email / raw-handle match
  const handleRaw = contacts.filter(c => c.handle.toLowerCase() === qLower);
  if (handleRaw.length > 0) return narrow(handleRaw);

  // Tier 3: prefix match on display
  const prefix = contacts.filter(c => c.display.toLowerCase().startsWith(qLower));
  if (prefix.length > 0) return narrow(prefix);

  // Tier 4: substring match on display
  const substr = contacts.filter(c => c.display.toLowerCase().includes(qLower));
  if (substr.length > 0) return narrow(substr);

  // Tier 5: substring on digits (useful when user only remembers last few digits)
  if (qDigits.length >= 4) {
    const digitSub = contacts.filter(c => digitsOnly(c.handle).includes(qDigits));
    if (digitSub.length > 0) return narrow(digitSub);
  }

  return { kind: 'miss' };
}

function narrow(matches: ReadonlyArray<MessageContact>): ResolveResult {
  if (matches.length === 1) return { kind: 'hit', contact: matches[0] };
  // More than one match at the same tier → ask the user / agent to pick.
  // Cap at 8 options so the agent prompt stays readable.
  return { kind: 'ambiguous', contacts: matches.slice(0, 8) };
}

/**
 * Search the raw AddressBook for entries whose *name* matches. The index is
 * keyed by normalised handle, so we flip the match direction and filter on the
 * value (display name). One AddressBook contact may have multiple handles
 * (home + work phone, etc.) — we return each as its own synthetic
 * `MessageContact` so the ambiguity dialog still works.
 */
export function matchAddressBook(
  query: string,
  entries: ReadonlyArray<AddressBookEntry>,
): ResolveResult {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || entries.length === 0) return { kind: 'miss' };

  const byName = entries.filter(e => e.name.toLowerCase() === q);
  const byPrefix = byName.length > 0 ? byName : entries.filter(e => e.name.toLowerCase().startsWith(q));
  const bySubstr = byPrefix.length > 0 ? byPrefix : entries.filter(e => e.name.toLowerCase().includes(q));
  if (bySubstr.length === 0) return { kind: 'miss' };

  // Group by name so "Mom" with 2 numbers still shows as one hit-with-options.
  const synthetic: MessageContact[] = bySubstr.map(e => ({
    handle: handleKeyToDialable(e.handle_key),
    display: e.name,
    last_message: '',
    last_ts: 0,
    message_count: 0,
    is_imessage: true,
    unread_count: 0,
  }));
  return narrow(synthetic);
}

/**
 * AddressBook keys are normalised (leading `1` stripped, all digits). Turn
 * back into a form Messages.app accepts. For US / NANP we re-prepend `+1`
 * to produce E.164; emails already round-trip unchanged.
 */
function handleKeyToDialable(key: string): string {
  if (key.includes('@')) return key;
  if (/^\d+$/.test(key)) {
    if (key.length === 10) return `+1${key}`;
    if (key.length === 11 && key.startsWith('1')) return `+${key}`;
    return `+${key}`;
  }
  return key;
}

function digitsOnly(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) out += s[i];
  }
  return out;
}

/** Whether a `chat_identifier` (stored as `handle` on MessageContact) is a group chat. */
export function isGroupChatIdentifier(handle: string): boolean {
  // Apple's synthetic group-chat ids start with `chat` followed by digits.
  // 1:1 chats use the peer's phone/email as the identifier instead.
  return /^chat\d+$/i.test(handle);
}
