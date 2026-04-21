// Browser tools — let SUNNY drive Safari from the agent loop.
//
// All calls go through the matching Tauri commands in `tools_browser.rs`,
// which shell out to `osascript` under the hood. Capabilities covered:
//
//   browser_open            — open a URL (activates Safari, new tab in front window)
//   browser_current_url     — URL of the frontmost tab
//   browser_read_page_text  — document.body.innerText, whitespace-collapsed + truncated
//   browser_tabs_list       — flat list of every tab across every window
//   browser_tab_select      — make a tab (by 1-based index from tabs_list) frontmost
//   browser_back / forward  — history navigation in the current tab
//   browser_close_tab       — close the frontmost tab
//   browser_screenshot      — PNG of the Safari window, returns the tmp file path
//
// Usage: `import './lib/tools.browser';` — self-registers on import.
//
// # Prerequisites (one-time user setup)
//
//   1. Safari → Settings → Advanced → enable "Show Develop menu in menu bar"
//   2. Safari → Develop → enable "Allow JavaScript from Apple Events"
//   3. System Settings → Privacy & Security → Automation → allow Sunny.app
//      to control "Safari" (and "System Events" if screenshot helper needs it).
//
// Without (2), `browser_read_page_text`, `browser_back`, and
// `browser_forward` will fail with an AppleEvent error. We deliberately
// do NOT attempt to toggle the setting programmatically — that would
// require writing to `com.apple.Safari` and relaunching the browser,
// which is a hostile act to perform silently on a user's behalf.
//
// # Danger flags
//
//   dangerous: true  — mutate browser state / steal focus:
//                      browser_open, browser_back, browser_forward,
//                      browser_close_tab, browser_tab_select
//   dangerous: false — read-only or side-effect-free inspection:
//                      browser_current_url, browser_read_page_text,
//                      browser_tabs_list, browser_screenshot
//
// The screenshot writes a file to $TMPDIR but does not mutate the
// browser itself, so we keep it on the safe side for planning.

import { registerTool, type Tool, type ToolResult } from './tools';
import { invoke } from './tauri';

// ---------------------------------------------------------------------------
// Local validation helpers (kept inline to avoid cross-module coupling).
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

function requireString(obj: Record<string, unknown>, key: string): string | ParseError {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    return { message: `"${key}" must be a non-empty string` };
  }
  return value;
}

function optionalInt(obj: Record<string, unknown>, key: string): number | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { message: `"${key}" must be an integer if provided` };
  }
  return value;
}

function requireInt(obj: Record<string, unknown>, key: string): number | ParseError {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { message: `"${key}" must be an integer` };
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

async function invokeString(cmd: string, args?: Record<string, unknown>): Promise<string> {
  const raw = await invoke<string>(cmd, args);
  return typeof raw === 'string' ? raw : String(raw ?? '');
}

// ---------------------------------------------------------------------------
// Constants mirroring the Rust defaults. Keep these in sync with
// src-tauri/src/tools_browser.rs.
// ---------------------------------------------------------------------------

const READ_TEXT_DEFAULT = 6_000;
const READ_TEXT_MAX = 16_000;

// ---------------------------------------------------------------------------
// 1. browser_open
// ---------------------------------------------------------------------------

const browserOpenTool: Tool = {
  schema: {
    name: 'browser_open',
    description:
      'Open a URL in Safari. Activates Safari (launching it if needed), creates a new tab in the frontmost window, and waits up to 8 seconds for the page to finish loading (document.readyState === "complete"). Requires Safari Automation permission.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Absolute URL to open (e.g. "https://example.com/path"). Rejects empty strings and URLs containing ASCII control characters.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['url']);
    if (unknown) return validationFailure(started, unknown.message);
    const url = requireString(input, 'url');
    if (isParseError(url)) return validationFailure(started, url.message);
    if (signal.aborted) return abortedResult('browser_open', started, 'before');

    try {
      const message = await invokeString('browser_open', { url });
      if (signal.aborted) return abortedResult('browser_open', started, 'after');
      return {
        ok: true,
        content: message,
        data: { url, message },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_open failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 2. browser_current_url
// ---------------------------------------------------------------------------

const browserCurrentUrlTool: Tool = {
  schema: {
    name: 'browser_current_url',
    description:
      'Return the URL of the frontmost Safari tab. Errors if Safari is not running or has no open windows.',
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
    if (signal.aborted) return abortedResult('browser_current_url', started, 'before');
    try {
      const url = await invokeString('browser_current_url');
      return {
        ok: true,
        content: url,
        data: { url },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_current_url failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 3. browser_read_page_text
// ---------------------------------------------------------------------------

const browserReadPageTextTool: Tool = {
  schema: {
    name: 'browser_read_page_text',
    description:
      'Read the visible text of the frontmost Safari tab (via document.body.innerText). Whitespace is collapsed; the result is truncated to `max_chars` characters (default 6000, max 16000) with a "[truncated at N chars]" suffix. Requires Safari Develop → "Allow JavaScript from Apple Events" to be enabled.',
    input_schema: {
      type: 'object',
      properties: {
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: READ_TEXT_MAX,
          description: `Upper bound on returned text length (default ${READ_TEXT_DEFAULT}, max ${READ_TEXT_MAX}).`,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (input !== undefined && !isRecord(input)) {
      return validationFailure(started, 'expected an object');
    }
    const obj = isRecord(input) ? input : {};
    const unknown = rejectUnknown(obj, ['max_chars']);
    if (unknown) return validationFailure(started, unknown.message);
    const maxIn = optionalInt(obj, 'max_chars');
    if (isParseError(maxIn)) return validationFailure(started, maxIn.message);
    if (signal.aborted) return abortedResult('browser_read_page_text', started, 'before');

    try {
      const text = await invokeString('browser_read_page_text', {
        maxChars: maxIn ?? null,
      });
      if (signal.aborted) return abortedResult('browser_read_page_text', started, 'after');
      return {
        ok: true,
        content: text,
        data: { text, chars: text.length },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_read_page_text failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 4. browser_tabs_list
// ---------------------------------------------------------------------------

const browserTabsListTool: Tool = {
  schema: {
    name: 'browser_tabs_list',
    description:
      'List every open Safari tab across every window as "<index>. <title> — <url>" lines. The index is 1-based and enumerated front-window-first; pass it back to browser_tab_select to activate a specific tab.',
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
    if (signal.aborted) return abortedResult('browser_tabs_list', started, 'before');
    try {
      const listing = await invokeString('browser_tabs_list');
      return {
        ok: true,
        content: listing,
        data: { listing },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_tabs_list failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 5. browser_tab_select
// ---------------------------------------------------------------------------

const browserTabSelectTool: Tool = {
  schema: {
    name: 'browser_tab_select',
    description:
      "Make the Safari tab at the given 1-based index (as returned by browser_tabs_list) the frontmost tab, bringing its parent window forward. Errors if the index is out of range.",
    input_schema: {
      type: 'object',
      properties: {
        index: {
          type: 'integer',
          minimum: 1,
          description: '1-based tab index from browser_tabs_list.',
        },
      },
      required: ['index'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['index']);
    if (unknown) return validationFailure(started, unknown.message);
    const index = requireInt(input, 'index');
    if (isParseError(index)) return validationFailure(started, index.message);
    if (index < 1) return validationFailure(started, '"index" must be >= 1');
    if (signal.aborted) return abortedResult('browser_tab_select', started, 'before');

    try {
      const message = await invokeString('browser_tab_select', { index });
      if (signal.aborted) return abortedResult('browser_tab_select', started, 'after');
      return {
        ok: true,
        content: message,
        data: { index, message },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_tab_select failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 6. browser_back / browser_forward
// ---------------------------------------------------------------------------

const browserBackTool: Tool = {
  schema: {
    name: 'browser_back',
    description:
      'Navigate the frontmost Safari tab one step back in its history (equivalent to clicking the back button). Requires Safari Develop → "Allow JavaScript from Apple Events".',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (_input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_back', started, 'before');
    try {
      const message = await invokeString('browser_back');
      if (signal.aborted) return abortedResult('browser_back', started, 'after');
      return {
        ok: true,
        content: message,
        data: { message },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_back failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

const browserForwardTool: Tool = {
  schema: {
    name: 'browser_forward',
    description:
      'Navigate the frontmost Safari tab one step forward in its history. Requires Safari Develop → "Allow JavaScript from Apple Events".',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (_input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_forward', started, 'before');
    try {
      const message = await invokeString('browser_forward');
      if (signal.aborted) return abortedResult('browser_forward', started, 'after');
      return {
        ok: true,
        content: message,
        data: { message },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_forward failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 7. browser_close_tab
// ---------------------------------------------------------------------------

const browserCloseTabTool: Tool = {
  schema: {
    name: 'browser_close_tab',
    description:
      'Close the frontmost Safari tab. Safari decides what to do if this was the last tab in the window (follows the user\'s "close button closes window" preference).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (_input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_close_tab', started, 'before');
    try {
      const message = await invokeString('browser_close_tab');
      if (signal.aborted) return abortedResult('browser_close_tab', started, 'after');
      return {
        ok: true,
        content: message,
        data: { message },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_close_tab failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 8. browser_screenshot
// ---------------------------------------------------------------------------

const browserScreenshotTool: Tool = {
  schema: {
    name: 'browser_screenshot',
    description:
      'Capture the frontmost Safari window to a PNG under $TMPDIR and return the absolute file path. Uses the CGWindowID when available and falls back to a full-screen capture if the window id cannot be resolved. The caller is responsible for reading / encoding / previewing the file.',
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
    if (signal.aborted) return abortedResult('browser_screenshot', started, 'before');
    try {
      const path = await invokeString('browser_screenshot');
      if (signal.aborted) return abortedResult('browser_screenshot', started, 'after');
      return {
        ok: true,
        content: `Saved Safari screenshot to ${path}`,
        data: { path },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        content: `browser_screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

[
  browserOpenTool,
  browserCurrentUrlTool,
  browserReadPageTextTool,
  browserTabsListTool,
  browserTabSelectTool,
  browserBackTool,
  browserForwardTool,
  browserCloseTabTool,
  browserScreenshotTool,
].forEach(registerTool);
