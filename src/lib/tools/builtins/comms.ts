// Comms — send iMessage / SMS, place calls, list chats, fetch conversations.
//
// All side-effectful tools here are `dangerous: true`. The agent loop routes
// those through the existing ConfirmGate, so the user approves the exact
// `to` + `body` (or recipient + call mode) before we fire.
//
// `text_contact` and `call_contact` are "smart" wrappers that resolve a fuzzy
// name like "Sunny" to a handle via `src/lib/contacts.ts`. When the name is
// ambiguous, the tool RETURNS the list of candidates instead of dialing — the
// agent then asks the user to pick. This keeps humans in the loop without
// forcing the AI to memorise handles.

import { invokeSafe } from '../../tauri';
import {
  resolveContact,
  invalidateContactsCache,
  isGroupChatIdentifier,
} from '../../contacts';
import type { MessageContact } from '../../../pages/ContactsPage/types';
import {
  enumOf,
  isParseError,
  isRecord,
  optionalNumber,
  optionalString,
  requireString,
  truncate,
  validationFailure,
} from '../parse';
import type { Tool } from '../types';

// ---------------------------------------------------------------------------
// Shared types + helpers
// ---------------------------------------------------------------------------

type ConversationMessage = {
  rowid: number;
  text: string;
  ts: number;
  from_me: boolean;
  sender: string | null;
  is_imessage: boolean;
  has_attachment: boolean;
};

type ChatSummary = {
  id: string;
  display_name: string;
  participants: ReadonlyArray<string>;
  last_message_preview: string;
  last_message_ts: number;
  unread: boolean;
};

const CALL_MODES = ['phone', 'facetime_audio', 'facetime_video'] as const;
type CallMode = (typeof CALL_MODES)[number];

const CALL_MODE_COMMAND: Record<CallMode, string> = {
  phone: 'messaging_call_phone',
  facetime_audio: 'messaging_facetime_audio',
  facetime_video: 'messaging_facetime_video',
};

const CALL_MODE_LABEL: Record<CallMode, string> = {
  phone: 'phone call',
  facetime_audio: 'FaceTime audio call',
  facetime_video: 'FaceTime video call',
};

function summariseCandidates(contacts: ReadonlyArray<MessageContact>): string {
  return contacts
    .map((c, i) => `${i + 1}. ${c.display} — ${c.handle}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// resolve_contact — name → handle, read-only
// ---------------------------------------------------------------------------

export const resolveContactTool: Tool = {
  schema: {
    name: 'resolve_contact',
    description:
      'Look up a contact\u2019s handle from a fuzzy name. Read-only. Returns the matched handle, a list of candidates on ambiguity, or a miss. Use before text_contact / call_contact when the user is vague ("Mom", "the plumber") so you can confirm who they mean.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Fuzzy name or handle.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const name = requireString(input, 'name');
    if (isParseError(name)) return validationFailure(started, name.message);
    const resolved = await resolveContact(name);
    if (resolved.kind === 'miss') {
      return {
        ok: false,
        content: `No contact matching "${name}".`,
        latency_ms: Date.now() - started,
      };
    }
    if (resolved.kind === 'ambiguous') {
      return {
        ok: true,
        content:
          `"${name}" matched ${resolved.contacts.length} contacts:\n` +
          summariseCandidates(resolved.contacts),
        data: { ambiguous: true, candidates: resolved.contacts },
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `Matched ${resolved.contact.display} (${resolved.contact.handle}).`,
      data: resolved.contact,
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// send_imessage — direct handle send
// ---------------------------------------------------------------------------

export const sendImessageTool: Tool = {
  schema: {
    name: 'send_imessage',
    description:
      'Send an iMessage to a specific handle (phone in E.164 like "+16045551234" or an email). Use `text_contact` instead when you only have a name.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient handle — phone number or email registered with iMessage.',
        },
        body: { type: 'string', description: 'Message body to send.' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const to = requireString(input, 'to');
    if (isParseError(to)) return validationFailure(started, to.message);
    const body = requireString(input, 'body');
    if (isParseError(body)) return validationFailure(started, body.message);

    const err = await invokeMessaging('messaging_send_imessage', { to, body });
    if (err) {
      return { ok: false, content: `send_imessage failed: ${err}`, latency_ms: Date.now() - started };
    }
    invalidateContactsCache();
    return {
      ok: true,
      content: `Sent iMessage to ${to} (${body.length} chars).`,
      data: { to, body },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// send_sms — direct handle send via SMS relay
// ---------------------------------------------------------------------------

export const sendSmsTool: Tool = {
  schema: {
    name: 'send_sms',
    description:
      'Send an SMS via the paired iPhone (Text Message Forwarding). Prefer `send_imessage` when the recipient is registered with iMessage.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient phone number.' },
        body: { type: 'string', description: 'Message body to send.' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const to = requireString(input, 'to');
    if (isParseError(to)) return validationFailure(started, to.message);
    const body = requireString(input, 'body');
    if (isParseError(body)) return validationFailure(started, body.message);

    const err = await invokeMessaging('messaging_send_sms', { to, body });
    if (err) {
      return { ok: false, content: `send_sms failed: ${err}`, latency_ms: Date.now() - started };
    }
    invalidateContactsCache();
    return {
      ok: true,
      content: `Sent SMS to ${to} (${body.length} chars).`,
      data: { to, body },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// text_contact — name → handle → send
// ---------------------------------------------------------------------------

export const textContactTool: Tool = {
  schema: {
    name: 'text_contact',
    description:
      'Text a contact by name. Resolves the name against recent conversations; if multiple matches are found, RETURNS the candidate list so you can ask the user to choose.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Fuzzy name or handle of the contact.' },
        body: { type: 'string', description: 'Message body to send.' },
        service: {
          type: 'string',
          enum: ['imessage', 'sms'],
          description: 'Delivery service. Defaults to iMessage.',
        },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const name = requireString(input, 'name');
    if (isParseError(name)) return validationFailure(started, name.message);
    const body = requireString(input, 'body');
    if (isParseError(body)) return validationFailure(started, body.message);
    const serviceRaw = optionalString(input, 'service');
    if (isParseError(serviceRaw)) return validationFailure(started, serviceRaw.message);
    const service: 'imessage' | 'sms' = serviceRaw === 'sms' ? 'sms' : 'imessage';

    const resolved = await resolveContact(name);
    if (resolved.kind === 'miss') {
      return {
        ok: false,
        content: `No contact matching "${name}". Ask the user to specify a phone/email, or call list_chats first.`,
        latency_ms: Date.now() - started,
      };
    }
    if (resolved.kind === 'ambiguous') {
      return {
        // `ok:true` so the agent keeps the data for a follow-up turn — this
        // isn't a failure, just a need for more input.
        ok: true,
        content:
          `"${name}" matched ${resolved.contacts.length} contacts — ask the user which one:\n` +
          summariseCandidates(resolved.contacts),
        data: { ambiguous: true, candidates: resolved.contacts },
        latency_ms: Date.now() - started,
      };
    }

    const { contact } = resolved;
    if (isGroupChatIdentifier(contact.handle)) {
      return {
        ok: false,
        content: `"${contact.display}" is a group chat — use send_imessage with a specific participant's handle, or open Messages.app.`,
        latency_ms: Date.now() - started,
      };
    }

    const command = service === 'sms' ? 'messaging_send_sms' : 'messaging_send_imessage';
    const err = await invokeMessaging(command, { to: contact.handle, body });
    if (err) {
      return {
        ok: false,
        content: `text_contact (${contact.display}) failed: ${err}`,
        latency_ms: Date.now() - started,
      };
    }
    invalidateContactsCache();
    return {
      ok: true,
      content: `Sent ${service === 'sms' ? 'SMS' : 'iMessage'} to ${contact.display} (${contact.handle}).`,
      data: { service, handle: contact.handle, display: contact.display },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// call_contact — name or handle → tel / facetime URL
// ---------------------------------------------------------------------------

export const callContactTool: Tool = {
  schema: {
    name: 'call_contact',
    description:
      'Place a phone, FaceTime audio, or FaceTime video call to a contact by name or handle. Phone calls route through the paired iPhone via Continuity.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Fuzzy name or direct handle.' },
        mode: {
          type: 'string',
          enum: [...CALL_MODES],
          description: 'Call modality: phone (cellular via iPhone), facetime_audio, or facetime_video.',
        },
      },
      required: ['name', 'mode'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const name = requireString(input, 'name');
    if (isParseError(name)) return validationFailure(started, name.message);
    const modeStr = enumOf(input, 'mode', CALL_MODES);
    if (isParseError(modeStr)) return validationFailure(started, modeStr.message);
    const mode = modeStr as CallMode;

    const resolved = await resolveContact(name);
    if (resolved.kind === 'miss') {
      return {
        ok: false,
        content: `No contact matching "${name}".`,
        latency_ms: Date.now() - started,
      };
    }
    if (resolved.kind === 'ambiguous') {
      return {
        ok: true,
        content:
          `"${name}" matched ${resolved.contacts.length} contacts — ask the user which one:\n` +
          summariseCandidates(resolved.contacts),
        data: { ambiguous: true, candidates: resolved.contacts },
        latency_ms: Date.now() - started,
      };
    }
    const { contact } = resolved;
    if (isGroupChatIdentifier(contact.handle)) {
      return {
        ok: false,
        content: `"${contact.display}" is a group chat — URL-scheme calls only work for individual handles.`,
        latency_ms: Date.now() - started,
      };
    }

    const err = await invokeMessaging(CALL_MODE_COMMAND[mode], { to: contact.handle });
    if (err) {
      return {
        ok: false,
        content: `${CALL_MODE_LABEL[mode]} to ${contact.display} failed: ${err}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `Placed ${CALL_MODE_LABEL[mode]} to ${contact.display} (${contact.handle}).`,
      data: { mode, handle: contact.handle, display: contact.display },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// list_chats — recent conversations (read-only)
// ---------------------------------------------------------------------------

export const listChatsTool: Tool = {
  schema: {
    name: 'list_chats',
    description:
      'List recent conversations from iMessage with participants and last-message previews. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of chats to return (default 50).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, _signal) => {
    const started = Date.now();
    const limit = isRecord(input) ? optionalNumber(input, 'limit') : undefined;
    if (isParseError(limit)) return validationFailure(started, limit.message);

    const rows = await invokeSafe<ReadonlyArray<ChatSummary>>('messaging_list_chats', { limit }, []);
    const list = rows ?? [];
    if (list.length === 0) {
      return {
        ok: true,
        content: 'No chats available — chat.db may be empty or Full Disk Access not granted.',
        data: [],
        latency_ms: Date.now() - started,
      };
    }
    const rendered = list
      .map(c => {
        const unreadTag = c.unread ? ' [UNREAD]' : '';
        const parts = c.participants.length > 0 ? ` · ${c.participants.join(', ')}` : '';
        return `${c.display_name}${unreadTag}${parts}\n  ${c.last_message_preview || '—'}`;
      })
      .join('\n\n');
    return {
      ok: true,
      content: truncate(`${list.length} chats:\n\n${rendered}`),
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// fetch_conversation — read messages of one chat
// ---------------------------------------------------------------------------

export const fetchConversationTool: Tool = {
  schema: {
    name: 'fetch_conversation',
    description:
      'Read the last N messages of a single conversation (by chat_identifier or peer handle). Read-only. Use before replying so you know what was said.',
    input_schema: {
      type: 'object',
      properties: {
        chat_identifier: {
          type: 'string',
          description: 'Peer handle (for 1:1) or synthetic `chat<id>` (for groups).',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 30.' },
        since_rowid: {
          type: 'integer',
          minimum: 1,
          description: 'Only return messages with ROWID greater than this.',
        },
      },
      required: ['chat_identifier'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const chatIdentifier = requireString(input, 'chat_identifier');
    if (isParseError(chatIdentifier)) return validationFailure(started, chatIdentifier.message);
    const limit = optionalNumber(input, 'limit');
    if (isParseError(limit)) return validationFailure(started, limit.message);
    const sinceRowid = optionalNumber(input, 'since_rowid');
    if (isParseError(sinceRowid)) return validationFailure(started, sinceRowid.message);

    const rows = await invokeSafe<ReadonlyArray<ConversationMessage>>(
      'messaging_fetch_conversation',
      { chatIdentifier, limit, sinceRowid },
      [],
    );
    const list = rows ?? [];
    if (list.length === 0) {
      return {
        ok: true,
        content: `No messages found in ${chatIdentifier}.`,
        data: [],
        latency_ms: Date.now() - started,
      };
    }
    const rendered = list
      .map(m => {
        const who = m.from_me ? 'me' : m.sender ?? chatIdentifier;
        const attach = m.has_attachment && !m.text ? '[attachment]' : m.text;
        return `[${who}] ${attach}`;
      })
      .join('\n');
    return {
      ok: true,
      content: truncate(`${list.length} messages in ${chatIdentifier}:\n${rendered}`),
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Invoke a messaging command and return an error string on failure or `null`
 * on success. We use `invokeSafe` (which swallows errors to a log) because
 * Tauri `invoke` throws strings here, and we want to surface a clean message
 * to the agent without aborting the whole tool-call layer.
 */
async function invokeMessaging(
  command: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  try {
    const { invoke } = await import('../../tauri');
    await invoke<void>(command, args);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
