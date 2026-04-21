// PTY-driver tools — lets the SUNNY agent open, drive, and observe interactive
// pseudo-terminals (e.g. for running `claude`, REPLs, SSH sessions).
//
// Self-registering: importing this module as a side-effect adds the six
// `pty_agent_*` tools to the shared registry in ./tools.ts.

import { registerTool, type Tool, type ToolResult } from './tools';
import { invokeSafe } from './tauri';

// ---------------------------------------------------------------------------
// Tiny local copies of the validation helpers from tools.ts. Kept inline so
// this module stays self-contained and doesn't require exporting internals
// from tools.ts.
// ---------------------------------------------------------------------------

type ParseError = { readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParseError(v: unknown): v is ParseError {
  return isRecord(v) && typeof (v as Record<string, unknown>).message === 'string'
    && !('length' in (v as object));
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

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
): number | ParseError {
  const value = obj[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { message: `"${key}" must be a number` };
  }
  return value;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { message: `"${key}" must be a number if provided` };
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
// Defaults & clamps.
// ---------------------------------------------------------------------------

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const DEFAULT_SHELL = '/bin/zsh';
const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 600;

function clampTimeout(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.max(1, Math.trunc(n)), MAX_TIMEOUT_SEC);
}

// ---------------------------------------------------------------------------
// Backend response shapes (best-effort; unknown fields are ignored).
// ---------------------------------------------------------------------------

type PtyOpenResult = {
  id: string;
  pid?: number;
  cols?: number;
  rows?: number;
  shell?: string;
};

type PtySendResult = {
  bytes_written?: number;
  offset?: number;
};

type PtyWaitResult = {
  matched: boolean;
  offset?: number;
  elapsed_ms?: number;
  pattern?: string;
  excerpt?: string;
};

type PtyReadResult = {
  bytes: string;
  from_offset?: number;
  next_offset?: number;
  bytes_len?: number;
};

type PtyStopResult = {
  id: string;
  exit_code?: number | null;
  signal?: string | null;
};

// ---------------------------------------------------------------------------
// Tools.
// ---------------------------------------------------------------------------

const ptyAgentOpenTool: Tool = {
  schema: {
    name: 'pty_agent_open',
    description:
      'Open a new pseudo-terminal under a given id. Spawns an interactive shell the agent can drive.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Caller-chosen PTY id (unique).' },
        cols: { type: 'integer', minimum: 1, description: `Terminal columns (default ${DEFAULT_COLS}).` },
        rows: { type: 'integer', minimum: 1, description: `Terminal rows (default ${DEFAULT_ROWS}).` },
        shell: { type: 'string', description: `Shell to spawn (default "${DEFAULT_SHELL}").` },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id', 'cols', 'rows', 'shell']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    const colsIn = optionalNumber(input, 'cols');
    if (isParseError(colsIn)) return validationFailure(started, colsIn.message);
    const rowsIn = optionalNumber(input, 'rows');
    if (isParseError(rowsIn)) return validationFailure(started, rowsIn.message);
    const shellIn = optionalString(input, 'shell');
    if (isParseError(shellIn)) return validationFailure(started, shellIn.message);

    const cols = colsIn ?? DEFAULT_COLS;
    const rows = rowsIn ?? DEFAULT_ROWS;
    const shell = shellIn ?? DEFAULT_SHELL;

    if (signal.aborted) return abortedResult('pty_agent_open', started, 'before');
    const result = await invokeSafe<PtyOpenResult>('pty_agent_open', { id, cols, rows, shell });
    if (signal.aborted) return abortedResult('pty_agent_open', started, 'after');
    if (!result) {
      return {
        ok: false,
        content: `failed to open pty "${id}"`,
        latency_ms: Date.now() - started,
      };
    }
    const pidStr = result.pid !== undefined ? ` pid=${result.pid}` : '';
    return {
      ok: true,
      content: `opened pty "${id}" (${cols}x${rows}, shell=${shell}${pidStr})`,
      data: result,
      latency_ms: Date.now() - started,
    };
  },
};

const ptyAgentSendLineTool: Tool = {
  schema: {
    name: 'pty_agent_send_line',
    description:
      'Send text to an open pty. By default appends a newline (press_enter=true); set press_enter=false to send raw bytes only.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'PTY id to target.' },
        text: { type: 'string', description: 'Text to send.' },
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

    if (signal.aborted) return abortedResult('pty_agent_send_line', started, 'before');
    const result = await invokeSafe<PtySendResult>('pty_agent_send_line', {
      id,
      text: textRaw,
      press_enter: pressEnter,
    });
    if (signal.aborted) return abortedResult('pty_agent_send_line', started, 'after');
    if (!result) {
      return {
        ok: false,
        content: `failed to send to pty "${id}"`,
        latency_ms: Date.now() - started,
      };
    }
    const bytesWritten =
      typeof result.bytes_written === 'number'
        ? result.bytes_written
        : new TextEncoder().encode(textRaw + (pressEnter ? '\n' : '')).length;
    return {
      ok: true,
      content: `sent ${bytesWritten} bytes to pty "${id}"${pressEnter ? ' (+enter)' : ''}`,
      data: result,
      latency_ms: Date.now() - started,
    };
  },
};

const ptyAgentWaitForTool: Tool = {
  schema: {
    name: 'pty_agent_wait_for',
    description:
      'Wait until the pty output matches a regex (or timeout). Returns the match offset and elapsed time. Does NOT consume the buffer.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'PTY id to watch.' },
        pattern: { type: 'string', description: 'Regular expression to search for in pty output.' },
        timeout_sec: {
          type: 'number',
          minimum: 1,
          maximum: MAX_TIMEOUT_SEC,
          description: `Max seconds to wait (clamped 1..${MAX_TIMEOUT_SEC}, default ${DEFAULT_TIMEOUT_SEC}).`,
        },
        since_offset: {
          type: 'integer',
          minimum: 0,
          description: 'Start scanning at this byte offset in the buffer (default 0).',
        },
      },
      required: ['id', 'pattern', 'timeout_sec'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id', 'pattern', 'timeout_sec', 'since_offset']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    const pattern = requireString(input, 'pattern');
    if (isParseError(pattern)) return validationFailure(started, pattern.message);
    const timeoutSecRaw = requireNumber(input, 'timeout_sec');
    if (isParseError(timeoutSecRaw)) return validationFailure(started, timeoutSecRaw.message);
    const sinceOffsetIn = optionalNumber(input, 'since_offset');
    if (isParseError(sinceOffsetIn)) return validationFailure(started, sinceOffsetIn.message);
    if (sinceOffsetIn !== undefined && (!Number.isInteger(sinceOffsetIn) || sinceOffsetIn < 0)) {
      return validationFailure(started, '"since_offset" must be a non-negative integer');
    }

    const timeoutSec = clampTimeout(timeoutSecRaw);

    if (signal.aborted) return abortedResult('pty_agent_wait_for', started, 'before');
    const result = await invokeSafe<PtyWaitResult>('pty_agent_wait_for', {
      id,
      pattern,
      timeout_sec: timeoutSec,
      since_offset: sinceOffsetIn,
    });
    if (signal.aborted) return abortedResult('pty_agent_wait_for', started, 'after');
    if (!result) {
      return {
        ok: false,
        content: `wait_for failed on pty "${id}"`,
        latency_ms: Date.now() - started,
      };
    }
    const elapsedMs = typeof result.elapsed_ms === 'number' ? result.elapsed_ms : Date.now() - started;
    if (result.matched) {
      const offsetStr = typeof result.offset === 'number' ? ` at offset ${result.offset}` : '';
      return {
        ok: true,
        content: `matched /${pattern}/${offsetStr} (elapsed ${elapsedMs}ms)`,
        data: result,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: false,
      content: `timed out after ${timeoutSec}s waiting for /${pattern}/ on pty "${id}" (elapsed ${elapsedMs}ms)`,
      data: result,
      latency_ms: Date.now() - started,
    };
  },
};

const ptyAgentReadBufferTool: Tool = {
  schema: {
    name: 'pty_agent_read_buffer',
    description:
      'Read bytes from a pty\'s scrollback buffer starting at from_offset (default 0). Non-destructive.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'PTY id to read.' },
        from_offset: {
          type: 'integer',
          minimum: 0,
          description: 'Byte offset to start reading from (default 0).',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id', 'from_offset']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    const fromOffsetIn = optionalNumber(input, 'from_offset');
    if (isParseError(fromOffsetIn)) return validationFailure(started, fromOffsetIn.message);
    if (fromOffsetIn !== undefined && (!Number.isInteger(fromOffsetIn) || fromOffsetIn < 0)) {
      return validationFailure(started, '"from_offset" must be a non-negative integer');
    }
    const fromOffset = fromOffsetIn ?? 0;

    if (signal.aborted) return abortedResult('pty_agent_read_buffer', started, 'before');
    const result = await invokeSafe<PtyReadResult>('pty_agent_read_buffer', {
      id,
      from_offset: fromOffset,
    });
    if (signal.aborted) return abortedResult('pty_agent_read_buffer', started, 'after');
    if (!result) {
      return {
        ok: false,
        content: `failed to read buffer for pty "${id}"`,
        latency_ms: Date.now() - started,
      };
    }
    const bytesLen =
      typeof result.bytes_len === 'number'
        ? result.bytes_len
        : typeof result.bytes === 'string'
        ? new TextEncoder().encode(result.bytes).length
        : 0;
    return {
      ok: true,
      content: `read ${bytesLen} bytes starting at offset ${fromOffset}`,
      data: result,
      latency_ms: Date.now() - started,
    };
  },
};

const ptyAgentClearBufferTool: Tool = {
  schema: {
    name: 'pty_agent_clear_buffer',
    description: 'Clear a pty\'s scrollback buffer. The underlying process is unaffected.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'PTY id whose buffer to clear.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);

    if (signal.aborted) return abortedResult('pty_agent_clear_buffer', started, 'before');
    await invokeSafe<void>('pty_agent_clear_buffer', { id });
    if (signal.aborted) return abortedResult('pty_agent_clear_buffer', started, 'after');
    return {
      ok: true,
      content: `cleared buffer for pty "${id}"`,
      data: { id },
      latency_ms: Date.now() - started,
    };
  },
};

const ptyAgentStopTool: Tool = {
  schema: {
    name: 'pty_agent_stop',
    description: 'Kill the pty\'s child process and release its resources.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'PTY id to stop.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);

    if (signal.aborted) return abortedResult('pty_agent_stop', started, 'before');
    const result = await invokeSafe<PtyStopResult>('pty_agent_stop', { id });
    if (signal.aborted) return abortedResult('pty_agent_stop', started, 'after');
    if (!result) {
      return {
        ok: false,
        content: `failed to stop pty "${id}"`,
        latency_ms: Date.now() - started,
      };
    }
    const exitStr =
      result.exit_code === null || result.exit_code === undefined
        ? result.signal
          ? ` (signal ${result.signal})`
          : ''
        : ` (exit ${result.exit_code})`;
    return {
      ok: true,
      content: `stopped pty "${id}"${exitStr}`,
      data: result,
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Self-registration — importing this module is enough.
// ---------------------------------------------------------------------------

[
  ptyAgentOpenTool,
  ptyAgentSendLineTool,
  ptyAgentWaitForTool,
  ptyAgentReadBufferTool,
  ptyAgentClearBufferTool,
  ptyAgentStopTool,
].forEach(registerTool);
