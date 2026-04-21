// Terminals tools — let the AI see and drive the same user-facing
// terminals that are rendered in the HUD and the multi-terminal overlay.
//
// These are distinct from the `pty_agent_*` family (which opens private,
// headless PTYs just for the agent). This family targets the store of
// sessions the USER is also looking at, so "anything the user can do the
// AI can do too" becomes literally true.
//
// Usage: `import './lib/tools.terminals';` — self-registers on import.
//
// Tools provided:
//   terminals_list   — enumerate every visible terminal (dashboard + overlay)
//   terminal_spawn   — open a new overlay tile (optionally running a cmd)
//   terminal_send    — type into a terminal (by stable id)
//   terminal_read    — read the recent output ring buffer
//   terminal_close   — close an overlay terminal (dashboard ones are pinned)
//
// Every terminal identity the AI handles is the *stable app-level id*
// (e.g. "dash:shell", "user:3"). The backend `sessionId` is nonce'd per
// mount and is intentionally not exposed — it'd go stale between turns.

import { registerTool, type Tool, type ToolResult } from './tools';
import { invokeSafe } from './tauri';
import {
  getTerminal,
  listTerminals,
  useTerminals,
  TERMINALS_OPEN_EVENT,
  type TerminalsOpenDetail,
} from '../store/terminals';

// ---------------------------------------------------------------------------
// Local validation helpers (kept inline so this module stays self-contained
// and doesn't cross-import from the builtin tools folder).
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

function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'boolean') {
    return { message: `"${key}" must be a boolean if provided` };
  }
  return value;
}

function optionalInt(
  obj: Record<string, unknown>,
  key: string,
): number | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { message: `"${key}" must be an integer if provided` };
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

// ---------------------------------------------------------------------------
// Wait-for-session: terminal_spawn and (rarely) terminal_send can be called
// before a freshly-added terminal's PtyTerminal component has resolved its
// backend sessionId. Poll the store briefly so the AI doesn't have to.
// ---------------------------------------------------------------------------

async function waitForSessionId(appId: string, timeoutMs = 5_000): Promise<string | null> {
  const started = Date.now();
  const POLL = 50;
  for (;;) {
    const session = getTerminal(appId);
    if (session?.sessionId) return session.sessionId;
    if (!session) return null; // removed while we were waiting
    if (Date.now() - started > timeoutMs) return null;
    await new Promise<void>(r => setTimeout(r, POLL));
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const OUTPUT_TAIL_DEFAULT = 2_000;
const OUTPUT_TAIL_MAX = 16_000;

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.trunc(value));
}

function renderSessionSummary(): string {
  const sessions = listTerminals();
  if (sessions.length === 0) return 'No terminals are open.';
  return sessions
    .map(s => {
      const parts = [
        `- ${s.id} (${s.origin})`,
        `title="${s.title}"`,
        s.running ? `running="${s.running}"` : null,
        s.cwd ? `cwd="${s.cwd}"` : null,
        s.sessionId ? 'live' : 'pending',
        `buffered=${s.output.length}B`,
      ].filter(Boolean);
      return parts.join(' · ');
    })
    .join('\n');
}

const terminalsListTool: Tool = {
  schema: {
    name: 'terminals_list',
    description:
      'List every user-visible terminal (dashboard HUD tiles and workspace overlay tiles). Returns each terminal\'s stable id, title, current working directory, running command hint, and how many bytes of recent output are buffered. Use the returned id with terminal_send / terminal_read / terminal_close.',
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
    if (signal.aborted) return abortedResult('terminals_list', started, 'before');
    const sessions = listTerminals();
    const summary = renderSessionSummary();
    return {
      ok: true,
      content: summary,
      data: sessions.map(s => ({
        id: s.id,
        origin: s.origin,
        title: s.title,
        cwd: s.cwd,
        running: s.running,
        sessionId: s.sessionId,
        output_bytes: s.output.length,
        created_at: s.created_at,
      })),
      latency_ms: Date.now() - started,
    };
  },
};

const terminalSpawnTool: Tool = {
  schema: {
    name: 'terminal_spawn',
    description:
      'Open a new terminal in the multi-terminal workspace overlay. The overlay opens automatically, the new tile is focused, and an optional command is typed in once the shell is ready. Returns the stable id of the created terminal.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Optional human-readable title. If omitted, the sidebar auto-populates from the shell as OSC titles arrive.',
        },
        command: {
          type: 'string',
          description:
            'Optional command to run as soon as the shell is ready (executed as if the user had typed it and pressed enter).',
        },
        focus: {
          type: 'boolean',
          description: 'Focus the new tile in the overlay (default true).',
        },
        fullscreen: {
          type: 'boolean',
          description: 'Open the new tile in fullscreen-within-overlay (default false).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (input !== undefined && !isRecord(input)) {
      return validationFailure(started, 'expected an object');
    }
    const obj = isRecord(input) ? input : {};
    const unknown = rejectUnknown(obj, ['title', 'command', 'focus', 'fullscreen']);
    if (unknown) return validationFailure(started, unknown.message);

    const titleIn = optionalString(obj, 'title');
    if (isParseError(titleIn)) return validationFailure(started, titleIn.message);
    const commandIn = optionalString(obj, 'command');
    if (isParseError(commandIn)) return validationFailure(started, commandIn.message);
    const focusIn = optionalBoolean(obj, 'focus');
    if (isParseError(focusIn)) return validationFailure(started, focusIn.message);
    const fullscreenIn = optionalBoolean(obj, 'fullscreen');
    if (isParseError(fullscreenIn)) return validationFailure(started, fullscreenIn.message);

    const store = useTerminals.getState();
    const newId = store.add({
      origin: 'overlay',
      title: titleIn,
      titlePinned: Boolean(titleIn),
    });
    if (focusIn !== false) store.setFocused(newId);

    // Open the overlay so the user sees what the AI just did. The overlay
    // will consume the initial command after the PTY is ready.
    const detail: TerminalsOpenDetail = {
      focusId: newId,
      fullscreen: fullscreenIn,
      initialCommand: commandIn,
    };
    window.dispatchEvent(new CustomEvent<TerminalsOpenDetail>(TERMINALS_OPEN_EVENT, { detail }));

    if (signal.aborted) return abortedResult('terminal_spawn', started, 'after');

    return {
      ok: true,
      content: `Spawned terminal "${newId}"${commandIn ? ` and queued: ${commandIn}` : ''}.`,
      data: { id: newId, command: commandIn ?? null },
      latency_ms: Date.now() - started,
    };
  },
};

const terminalSendTool: Tool = {
  schema: {
    name: 'terminal_send',
    description:
      'Type text into a user-visible terminal as if the human had pressed those keys. By default a trailing newline is added (press_enter=true) so the command executes; set press_enter=false to inject raw bytes (e.g. ANSI control sequences, tab-completion, Ctrl-C via "\\u0003").',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Stable terminal id returned by terminals_list / terminal_spawn (e.g. "dash:shell", "user:3").',
        },
        text: {
          type: 'string',
          description: 'Text to send. May be empty if press_enter=true (just hits return).',
        },
        press_enter: {
          type: 'boolean',
          description: 'Append a trailing newline after text (default true).',
        },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id', 'text', 'press_enter']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    const textRaw = input['text'];
    if (typeof textRaw !== 'string') {
      return validationFailure(started, '"text" must be a string');
    }
    const pressEnterIn = optionalBoolean(input, 'press_enter');
    if (isParseError(pressEnterIn)) return validationFailure(started, pressEnterIn.message);
    const pressEnter = pressEnterIn ?? true;

    const sessionId = await waitForSessionId(id, 5_000);
    if (sessionId === null) {
      return {
        ok: false,
        content: `Terminal "${id}" is not open or has no live backend session.`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('terminal_send', started, 'before');

    const payload = pressEnter ? `${textRaw}\n` : textRaw;
    try {
      await invokeSafe<void>('pty_write', { id: sessionId, data: payload });
    } catch (err) {
      return {
        ok: false,
        content: `pty_write failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('terminal_send', started, 'after');

    const bytes = new TextEncoder().encode(payload).length;
    return {
      ok: true,
      content: `Sent ${bytes} bytes to terminal "${id}"${pressEnter ? ' (+enter)' : ''}.`,
      data: { id, bytes, press_enter: pressEnter },
      latency_ms: Date.now() - started,
    };
  },
};

const terminalReadTool: Tool = {
  schema: {
    name: 'terminal_read',
    description:
      "Return the most recent ANSI-stripped output from a terminal (up to 16,000 characters). Non-destructive — reading doesn't consume the buffer.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable terminal id.' },
        tail_chars: {
          type: 'integer',
          minimum: 1,
          maximum: OUTPUT_TAIL_MAX,
          description: `Return at most this many trailing characters (default ${OUTPUT_TAIL_DEFAULT}, max ${OUTPUT_TAIL_MAX}).`,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('terminal_read', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id', 'tail_chars']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    const tailIn = optionalInt(input, 'tail_chars');
    if (isParseError(tailIn)) return validationFailure(started, tailIn.message);
    const tail = clampInt(tailIn, OUTPUT_TAIL_DEFAULT, OUTPUT_TAIL_MAX);

    const session = getTerminal(id);
    if (!session) {
      return {
        ok: false,
        content: `Unknown terminal "${id}".`,
        latency_ms: Date.now() - started,
      };
    }
    const full = session.output;
    const body = full.length <= tail ? full : full.slice(full.length - tail);
    const header =
      `terminal ${id} · title="${session.title}"` +
      (session.cwd ? ` · cwd="${session.cwd}"` : '') +
      (session.running ? ` · running="${session.running}"` : '') +
      ` · ${session.output.length} bytes buffered`;
    return {
      ok: true,
      content: `${header}\n---\n${body}`,
      data: {
        id,
        title: session.title,
        cwd: session.cwd,
        running: session.running,
        total_bytes: session.output.length,
        returned_bytes: body.length,
        text: body,
      },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// terminal_wait_for — the AI equivalent of "wait until the prompt comes
// back" or "wait for compilation to finish". Polls the ring buffer on
// a short interval looking for a regex match, so the agent can send a
// command and reliably read the result without guessing at timings.
// ---------------------------------------------------------------------------

const WAIT_DEFAULT_SEC = 20;
const WAIT_MAX_SEC = 300;

const terminalWaitForTool: Tool = {
  schema: {
    name: 'terminal_wait_for',
    description:
      'Poll a terminal\'s output buffer until a regex matches (or the timeout elapses). Scans from `since_offset` (default 0) through the end of the ring buffer; useful after terminal_send to wait for a prompt or "done" line before reading. Returns the byte offset of the first match and the surrounding excerpt. Does NOT consume the buffer.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable terminal id.' },
        pattern: {
          type: 'string',
          description:
            'JavaScript-flavored regular expression. Anchors (^, $) match line boundaries when you include the "m" flag via `flags`.',
        },
        flags: {
          type: 'string',
          description:
            'Regex flags. Defaults to "m" (multiline). Case-insensitive with "i", unicode-aware with "u".',
        },
        timeout_sec: {
          type: 'number',
          minimum: 1,
          maximum: WAIT_MAX_SEC,
          description: `Max seconds to wait (clamped 1..${WAIT_MAX_SEC}, default ${WAIT_DEFAULT_SEC}).`,
        },
        since_offset: {
          type: 'integer',
          minimum: 0,
          description: 'Start scanning at this byte offset (default 0 = entire buffer).',
        },
      },
      required: ['id', 'pattern'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('terminal_wait_for', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, [
      'id',
      'pattern',
      'flags',
      'timeout_sec',
      'since_offset',
    ]);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    const pattern = requireString(input, 'pattern');
    if (isParseError(pattern)) return validationFailure(started, pattern.message);
    const flagsIn = optionalString(input, 'flags');
    if (isParseError(flagsIn)) return validationFailure(started, flagsIn.message);
    const timeoutIn = input['timeout_sec'];
    let timeoutSec = WAIT_DEFAULT_SEC;
    if (timeoutIn !== undefined && timeoutIn !== null) {
      if (typeof timeoutIn !== 'number' || !Number.isFinite(timeoutIn) || timeoutIn <= 0) {
        return validationFailure(started, '"timeout_sec" must be a positive number');
      }
      timeoutSec = Math.min(WAIT_MAX_SEC, Math.max(1, timeoutIn));
    }
    const sinceIn = optionalInt(input, 'since_offset');
    if (isParseError(sinceIn)) return validationFailure(started, sinceIn.message);
    const sinceOffset = Math.max(0, sinceIn ?? 0);

    const flags = (flagsIn ?? 'm').replace(/g/g, '');
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (err) {
      return validationFailure(
        started,
        `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const deadline = started + timeoutSec * 1000;
    const POLL_MS = 80;
    for (;;) {
      if (signal.aborted) return abortedResult('terminal_wait_for', started, 'after');
      const session = getTerminal(id);
      if (!session) {
        return {
          ok: false,
          content: `Unknown terminal "${id}".`,
          latency_ms: Date.now() - started,
        };
      }
      const haystack = session.output.slice(sinceOffset);
      // Using `.match()` without /g returns `[match, ...groups]` with
      // `.index` on the result, same data as RegExp.prototype.exec but
      // stateless so we don't have to reset lastIndex between polls.
      const match = haystack.match(regex);
      if (match) {
        const matchStart = sinceOffset + (match.index ?? 0);
        const matched = match[0];
        const excerptStart = Math.max(0, matchStart - 120);
        const excerptEnd = Math.min(session.output.length, matchStart + matched.length + 120);
        const excerpt = session.output.slice(excerptStart, excerptEnd);
        return {
          ok: true,
          content: `matched /${pattern}/${flags} at offset ${matchStart} after ${Date.now() - started}ms`,
          data: {
            id,
            matched: true,
            offset: matchStart,
            match: matched,
            elapsed_ms: Date.now() - started,
            excerpt,
            total_bytes: session.output.length,
          },
          latency_ms: Date.now() - started,
        };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          content: `timed out after ${timeoutSec}s waiting for /${pattern}/${flags} on terminal "${id}"`,
          data: {
            id,
            matched: false,
            elapsed_ms: Date.now() - started,
            total_bytes: session.output.length,
          },
          latency_ms: Date.now() - started,
        };
      }
      await new Promise<void>(r => setTimeout(r, POLL_MS));
    }
  },
};

// ---------------------------------------------------------------------------
// terminals_focus — switch the overlay's focused tile and (optionally)
// open the overlay. Lightweight counterpart to terminal_spawn for when
// the AI wants to "bring this terminal to the user's attention".
// ---------------------------------------------------------------------------

const terminalsFocusTool: Tool = {
  schema: {
    name: 'terminals_focus',
    description:
      'Focus a specific terminal in the multi-terminal workspace overlay. Opens the overlay if it\'s closed. Useful after terminal_send when you want the user to watch the output live.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable terminal id to focus.' },
        fullscreen: {
          type: 'boolean',
          description: 'Display the tile in fullscreen-within-overlay mode (default false).',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('terminals_focus', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id', 'fullscreen']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    const fullscreenIn = optionalBoolean(input, 'fullscreen');
    if (isParseError(fullscreenIn)) return validationFailure(started, fullscreenIn.message);

    const session = getTerminal(id);
    if (!session) {
      return {
        ok: false,
        content: `Unknown terminal "${id}".`,
        latency_ms: Date.now() - started,
      };
    }

    useTerminals.getState().setFocused(id);
    if (session.origin === 'overlay') {
      window.dispatchEvent(
        new CustomEvent<TerminalsOpenDetail>(TERMINALS_OPEN_EVENT, {
          detail: { focusId: id, fullscreen: fullscreenIn ?? false },
        }),
      );
    }

    return {
      ok: true,
      content: `Focused terminal "${id}" (${session.origin}).`,
      data: { id, origin: session.origin },
      latency_ms: Date.now() - started,
    };
  },
};

const terminalCloseTool: Tool = {
  schema: {
    name: 'terminal_close',
    description:
      'Close a workspace-overlay terminal. Dashboard terminals ("dash:*") are permanent and cannot be closed through this tool.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable terminal id.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('terminal_close', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);

    const session = getTerminal(id);
    if (!session) {
      return {
        ok: false,
        content: `Unknown terminal "${id}".`,
        latency_ms: Date.now() - started,
      };
    }
    if (session.origin === 'dashboard') {
      return {
        ok: false,
        content: `Refusing to close dashboard terminal "${id}" — they are permanent HUD tiles.`,
        latency_ms: Date.now() - started,
      };
    }
    useTerminals.getState().remove(id);
    return {
      ok: true,
      content: `Closed terminal "${id}".`,
      data: { id },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

[
  terminalsListTool,
  terminalSpawnTool,
  terminalSendTool,
  terminalReadTool,
  terminalWaitForTool,
  terminalsFocusTool,
  terminalCloseTool,
].forEach(registerTool);
