// macOS Control tools — AppleScript-driven bindings for Mail, Calendar,
// Notes, Messages, Reminders, Shortcuts and basic app control. Registering
// these lets the agent loop handle requests like "send this email", "what's
// on my calendar today", or "remind me to call Mom at 3" via voice, without
// any per-command glue code sprinkled across the frontend.
//
// Usage: `import './lib/tools.macos';` — self-registers on import.
//
// # Permissions (one-time per scripted app)
//
// SUNNY.app needs Automation permissions for each target app under
// System Settings → Privacy & Security → Automation → Sunny:
//   • Mail, Calendar, Notes, Messages, Reminders, Shortcuts, Finder
// macOS prompts on first use; the Rust layer surfaces denials with a
// human-readable hint pointing back to this pane.
//
// # Danger classification
//
// Read-only (dangerous: false):
//   mail_list_unread, calendar_today, calendar_upcoming, notes_search,
//   reminders_today
// Side-effectful (dangerous: true — requires ConfirmGate):
//   mail_send, imessage_send, calendar_create_event, notes_create,
//   reminders_add, app_launch, app_quit, shortcut_run, finder_reveal
//
// # Display vs data split
//
// Every tool returns a short `content` string suitable for speaking back to
// the user. `data` carries the raw Rust return value (already a string here
// because every Tauri command in this module returns `Result<String, …>`)
// so callers that want the structured payload still have it.

import { registerTool, type Tool, type ToolResult } from './tools';
import { invokeSafe } from './tauri';

// ---------------------------------------------------------------------------
// Local validation helpers — self-contained, no cross-module imports.
// ---------------------------------------------------------------------------

type ParseError = { readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParseError(v: unknown): v is ParseError {
  return (
    isRecord(v) &&
    typeof (v as Record<string, unknown>).message === 'string' &&
    !('length' in (v as object))
  );
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
): string | ParseError {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    return { message: `"${key}" must be a non-empty string` };
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'string') {
    return { message: `"${key}" must be a string if provided` };
  }
  return value;
}

function optionalUint(
  obj: Record<string, unknown>,
  key: string,
): number | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { message: `"${key}" must be a non-negative integer if provided` };
  }
  return value;
}

function rejectUnknown(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
): ParseError | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      return { message: `unknown field "${key}"` };
    }
  }
  return null;
}

function validationFailure(started: number, reason: string): ToolResult {
  return {
    ok: false,
    content: `Invalid tool input: ${reason}`,
    latency_ms: Date.now() - started,
  };
}

function abortedResult(name: string, started: number, when: 'before' | 'after'): ToolResult {
  return {
    ok: false,
    content: `Tool "${name}" aborted ${when} invocation`,
    latency_ms: Date.now() - started,
  };
}

/// Centralised invoke wrapper — every command in this module returns
/// `Result<String, String>`, so the TS side either gets a string (success)
/// or an exception via invokeSafe's internal try/catch → null. We can't
/// distinguish "Rust Err" from "invokeSafe logged and swallowed" without
/// going around invokeSafe, so we use the raw `invoke` via a thin shim
/// to preserve the error message. Falling back to invokeSafe is kept as a
/// last-ditch net.
async function callMacCommand(
  cmd: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    // Dynamic import so this module stays tree-shakeable in non-Tauri builds
    // (the Vite browser test harness). `@tauri-apps/api/core` exposes
    // `invoke`, which rejects when Rust returns Err — unlike invokeSafe,
    // which resolves to null and eats the message.
    const mod = (await import('@tauri-apps/api/core')) as {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
    const value = await mod.invoke<string>(cmd, args);
    return { ok: true, value: value ?? '' };
  } catch (err) {
    // In a non-Tauri environment the dynamic import fails; fall back to
    // invokeSafe so tests / storybook don't explode.
    const fallback = await invokeSafe<string>(cmd, args, '');
    if (fallback === null) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    // invokeSafe succeeded — but if it returned the fallback because there
    // was no Tauri host, that's still effectively "not connected". Return
    // the original error so the caller sees why.
    if (fallback === '') {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: true, value: fallback };
  }
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

const mailListUnreadTool: Tool = {
  schema: {
    name: 'mail_list_unread',
    description:
      'List the newest unread emails across every Mail.app INBOX. Returns a numbered block formatted as "N. From <sender> (<date>): <subject>" — one per line — suitable for speaking back to the user. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of messages to return (default 10).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('mail_list_unread', started, 'before');
    if (input !== undefined && !isRecord(input)) {
      return validationFailure(started, 'expected an object');
    }
    const obj = isRecord(input) ? input : {};
    const unknown = rejectUnknown(obj, ['limit']);
    if (unknown) return validationFailure(started, unknown.message);
    const limitIn = optionalUint(obj, 'limit');
    if (isParseError(limitIn)) return validationFailure(started, limitIn.message);

    const result = await callMacCommand('mail_list_unread', { limit: limitIn ?? null });
    if (!result.ok) {
      return {
        ok: false,
        content: `mail_list_unread failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: result.value,
      data: { text: result.value },
      latency_ms: Date.now() - started,
    };
  },
};

const mailSendTool: Tool = {
  schema: {
    name: 'mail_send',
    description:
      'Compose and send an email through Mail.app. Requires Automation permission for Mail. DANGEROUS — the message is delivered immediately; the orchestrator should confirm with the user before invocation.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Primary recipient email address.',
        },
        subject: { type: 'string', description: 'Subject line (required).' },
        body: { type: 'string', description: 'Plain-text body. Newlines preserved.' },
        cc: {
          type: 'string',
          description: 'Optional CC recipient email address.',
        },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('mail_send', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['to', 'subject', 'body', 'cc']);
    if (unknown) return validationFailure(started, unknown.message);
    const to = requireString(input, 'to');
    if (isParseError(to)) return validationFailure(started, to.message);
    const subject = requireString(input, 'subject');
    if (isParseError(subject)) return validationFailure(started, subject.message);
    const bodyRaw = input['body'];
    if (typeof bodyRaw !== 'string') {
      return validationFailure(started, '"body" must be a string');
    }
    const ccIn = optionalString(input, 'cc');
    if (isParseError(ccIn)) return validationFailure(started, ccIn.message);

    const result = await callMacCommand('mail_send', {
      to,
      subject,
      body: bodyRaw,
      cc: ccIn ?? null,
    });
    if (!result.ok) {
      return {
        ok: false,
        content: `mail_send failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('mail_send', started, 'after');
    return {
      ok: true,
      content: result.value,
      data: { to, subject, cc: ccIn ?? null },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const calendarTodayTool: Tool = {
  schema: {
    name: 'calendar_today',
    description:
      'List every event on every calendar for today, formatted as "HH:MM – HH:MM <title> (<calendar>)" one per line, sorted by start time. Read-only.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (_input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('calendar_today', started, 'before');
    const result = await callMacCommand('calendar_today', {});
    if (!result.ok) {
      return {
        ok: false,
        content: `calendar_today failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: result.value,
      data: { text: result.value },
      latency_ms: Date.now() - started,
    };
  },
};

const calendarUpcomingTool: Tool = {
  schema: {
    name: 'calendar_upcoming',
    description:
      'List events for the next N days across every calendar. Default window is 3 days. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: 'Forward window in days (default 3, max 30).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('calendar_upcoming', started, 'before');
    if (input !== undefined && !isRecord(input)) {
      return validationFailure(started, 'expected an object');
    }
    const obj = isRecord(input) ? input : {};
    const unknown = rejectUnknown(obj, ['days']);
    if (unknown) return validationFailure(started, unknown.message);
    const daysIn = optionalUint(obj, 'days');
    if (isParseError(daysIn)) return validationFailure(started, daysIn.message);

    const result = await callMacCommand('calendar_upcoming', { days: daysIn ?? null });
    if (!result.ok) {
      return {
        ok: false,
        content: `calendar_upcoming failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: result.value,
      data: { text: result.value, days: daysIn ?? 3 },
      latency_ms: Date.now() - started,
    };
  },
};

const calendarCreateEventTool: Tool = {
  schema: {
    name: 'calendar_create_event',
    description:
      'Create a new calendar event. `start` and `end` are ISO-8601 timestamps (e.g. "2026-04-18T14:30:00"). `calendar` defaults to "Calendar". DANGEROUS — persists to the user\'s calendar store immediately.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event summary / title.' },
        start: { type: 'string', description: 'ISO-8601 start timestamp.' },
        end: { type: 'string', description: 'ISO-8601 end timestamp.' },
        calendar: {
          type: 'string',
          description: 'Target calendar name (default "Calendar").',
        },
        notes: { type: 'string', description: 'Optional event notes / description.' },
      },
      required: ['title', 'start', 'end'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('calendar_create_event', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['title', 'start', 'end', 'calendar', 'notes']);
    if (unknown) return validationFailure(started, unknown.message);
    const title = requireString(input, 'title');
    if (isParseError(title)) return validationFailure(started, title.message);
    const start = requireString(input, 'start');
    if (isParseError(start)) return validationFailure(started, start.message);
    const end = requireString(input, 'end');
    if (isParseError(end)) return validationFailure(started, end.message);
    const calIn = optionalString(input, 'calendar');
    if (isParseError(calIn)) return validationFailure(started, calIn.message);
    const notesIn = optionalString(input, 'notes');
    if (isParseError(notesIn)) return validationFailure(started, notesIn.message);

    const result = await callMacCommand('tool_calendar_create_event', {
      title,
      start,
      end,
      calendar: calIn ?? null,
      notes: notesIn ?? null,
    });
    if (!result.ok) {
      return {
        ok: false,
        content: `calendar_create_event failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('calendar_create_event', started, 'after');
    return {
      ok: true,
      content: result.value,
      data: { title, start, end, calendar: calIn ?? 'Calendar' },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

const notesCreateTool: Tool = {
  schema: {
    name: 'notes_create',
    description:
      'Create a new note in Notes.app. If `folder` is provided and doesn\'t exist, the folder is created first. DANGEROUS — persists to the Notes database.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title (becomes <h1>).' },
        body: { type: 'string', description: 'Plain-text body; newlines preserved.' },
        folder: {
          type: 'string',
          description: 'Optional folder name; created on demand if missing.',
        },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('notes_create', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['title', 'body', 'folder']);
    if (unknown) return validationFailure(started, unknown.message);
    const title = requireString(input, 'title');
    if (isParseError(title)) return validationFailure(started, title.message);
    const bodyRaw = input['body'];
    if (typeof bodyRaw !== 'string') {
      return validationFailure(started, '"body" must be a string');
    }
    const folderIn = optionalString(input, 'folder');
    if (isParseError(folderIn)) return validationFailure(started, folderIn.message);

    const result = await callMacCommand('notes_create', {
      title,
      body: bodyRaw,
      folder: folderIn ?? null,
    });
    if (!result.ok) {
      return {
        ok: false,
        content: `notes_create failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('notes_create', started, 'after');
    return {
      ok: true,
      content: result.value,
      data: { title, folder: folderIn ?? null },
      latency_ms: Date.now() - started,
    };
  },
};

const notesSearchTool: Tool = {
  schema: {
    name: 'notes_search',
    description:
      'Search Notes.app for notes whose title contains the query. Returns a numbered list of matching titles. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-sensitive substring to match titles against.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum number of results (default 20).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('notes_search', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['query', 'limit']);
    if (unknown) return validationFailure(started, unknown.message);
    const query = requireString(input, 'query');
    if (isParseError(query)) return validationFailure(started, query.message);
    const limitIn = optionalUint(input, 'limit');
    if (isParseError(limitIn)) return validationFailure(started, limitIn.message);

    const result = await callMacCommand('notes_search', {
      query,
      limit: limitIn ?? null,
    });
    if (!result.ok) {
      return {
        ok: false,
        content: `notes_search failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: result.value,
      data: { text: result.value, query },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// iMessage
// ---------------------------------------------------------------------------

const imessageSendTool: Tool = {
  schema: {
    name: 'imessage_send',
    description:
      'Send a message through Messages.app over iMessage. Recipient may be a phone number (+ and digits) or an email. DANGEROUS — delivered immediately and cannot be recalled.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Phone number ("+16045551234") or email address.',
        },
        body: { type: 'string', description: 'Message body (UTF-8, newlines allowed).' },
      },
      required: ['recipient', 'body'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('imessage_send', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['recipient', 'body']);
    if (unknown) return validationFailure(started, unknown.message);
    const recipient = requireString(input, 'recipient');
    if (isParseError(recipient)) return validationFailure(started, recipient.message);
    const bodyRaw = input['body'];
    if (typeof bodyRaw !== 'string' || bodyRaw.length === 0) {
      return validationFailure(started, '"body" must be a non-empty string');
    }

    const result = await callMacCommand('imessage_send', { recipient, body: bodyRaw });
    if (!result.ok) {
      return {
        ok: false,
        content: `imessage_send failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('imessage_send', started, 'after');
    return {
      ok: true,
      content: result.value,
      data: { recipient },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

const remindersAddTool: Tool = {
  schema: {
    name: 'reminders_add',
    description:
      'Add a reminder to Reminders.app. If `list` is provided and doesn\'t exist, it\'s created. `due` is an optional ISO-8601 timestamp. DANGEROUS — persists to the reminders store.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Reminder title (required).' },
        due: {
          type: 'string',
          description: 'Optional ISO-8601 due date (e.g. "2026-04-18T15:00:00").',
        },
        list: {
          type: 'string',
          description: 'Optional target list name. Created if missing. Defaults to the user\'s default list.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('reminders_add', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['title', 'due', 'list']);
    if (unknown) return validationFailure(started, unknown.message);
    const title = requireString(input, 'title');
    if (isParseError(title)) return validationFailure(started, title.message);
    const dueIn = optionalString(input, 'due');
    if (isParseError(dueIn)) return validationFailure(started, dueIn.message);
    const listIn = optionalString(input, 'list');
    if (isParseError(listIn)) return validationFailure(started, listIn.message);

    const result = await callMacCommand('reminders_add', {
      title,
      due: dueIn ?? null,
      list: listIn ?? null,
    });
    if (!result.ok) {
      return {
        ok: false,
        content: `reminders_add failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('reminders_add', started, 'after');
    return {
      ok: true,
      content: result.value,
      data: { title, due: dueIn ?? null, list: listIn ?? null },
      latency_ms: Date.now() - started,
    };
  },
};

const remindersTodayTool: Tool = {
  schema: {
    name: 'reminders_today',
    description:
      'List incomplete reminders whose due date is today, across every list. Read-only.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (_input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('reminders_today', started, 'before');
    const result = await callMacCommand('reminders_today', {});
    if (!result.ok) {
      return {
        ok: false,
        content: `reminders_today failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: result.value,
      data: { text: result.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Apps + Shortcuts
// ---------------------------------------------------------------------------

const appLaunchTool: Tool = {
  schema: {
    name: 'app_launch',
    description:
      'Activate (launch or bring to front) a macOS application by name. DANGEROUS — changes the user\'s foreground context.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Application name (e.g. "Safari", "Xcode").' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('app_launch', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['name']);
    if (unknown) return validationFailure(started, unknown.message);
    const name = requireString(input, 'name');
    if (isParseError(name)) return validationFailure(started, name.message);

    const result = await callMacCommand('app_launch', { name });
    if (!result.ok) {
      return {
        ok: false,
        content: `app_launch failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: result.value,
      data: { name },
      latency_ms: Date.now() - started,
    };
  },
};

const appQuitTool: Tool = {
  schema: {
    name: 'app_quit',
    description:
      'Gracefully quit a macOS application by name. DANGEROUS — unsaved work in the target app may be lost.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Application name (e.g. "Safari").' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('app_quit', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['name']);
    if (unknown) return validationFailure(started, unknown.message);
    const name = requireString(input, 'name');
    if (isParseError(name)) return validationFailure(started, name.message);

    const result = await callMacCommand('app_quit', { name });
    if (!result.ok) {
      return {
        ok: false,
        content: `app_quit failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: result.value,
      data: { name },
      latency_ms: Date.now() - started,
    };
  },
};

const shortcutRunTool: Tool = {
  schema: {
    name: 'shortcut_run',
    description:
      'Run a macOS Shortcut by name. Optionally pipe `input` to the shortcut as its "Shortcut Input". Returns the shortcut\'s stdout (or empty string). DANGEROUS — shortcuts can do anything the user can do.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact Shortcut name as it appears in Shortcuts.app.' },
        input: {
          type: 'string',
          description: 'Optional input text piped to the shortcut on stdin.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('shortcut_run', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['name', 'input']);
    if (unknown) return validationFailure(started, unknown.message);
    const name = requireString(input, 'name');
    if (isParseError(name)) return validationFailure(started, name.message);
    const inputIn = optionalString(input, 'input');
    if (isParseError(inputIn)) return validationFailure(started, inputIn.message);

    const result = await callMacCommand('shortcut_run', {
      name,
      input: inputIn ?? null,
    });
    if (!result.ok) {
      return {
        ok: false,
        content: `shortcut_run failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('shortcut_run', started, 'after');
    return {
      ok: true,
      content: result.value,
      data: { name, output: result.value },
      latency_ms: Date.now() - started,
    };
  },
};

const finderRevealTool: Tool = {
  schema: {
    name: 'finder_reveal',
    description:
      'Open Finder and highlight the file or folder at `path`. DANGEROUS — switches the user\'s foreground context to Finder.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute filesystem path to reveal.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('finder_reveal', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['path']);
    if (unknown) return validationFailure(started, unknown.message);
    const path = requireString(input, 'path');
    if (isParseError(path)) return validationFailure(started, path.message);

    const result = await callMacCommand('finder_reveal', { path });
    if (!result.ok) {
      return {
        ok: false,
        content: `finder_reveal failed: ${(result as { ok: false; error: string }).error}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: result.value,
      data: { path },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

[
  mailListUnreadTool,
  mailSendTool,
  calendarTodayTool,
  calendarUpcomingTool,
  calendarCreateEventTool,
  notesCreateTool,
  notesSearchTool,
  imessageSendTool,
  remindersAddTool,
  remindersTodayTool,
  appLaunchTool,
  appQuitTool,
  shortcutRunTool,
  finderRevealTool,
].forEach(registerTool);
