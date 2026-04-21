// Web tools — gives the AI first-class access to the public internet.
//
// These four tools pair with `src-tauri/src/tools_web.rs`:
//   web_fetch          — fetch a URL and return its readable body
//   web_search         — DuckDuckGo HTML search with Brave fallback
//   web_extract_links  — list every <a href> on a page (resolved)
//   web_extract_title  — return the page's <title> (or <h1> fallback)
//
// Usage: `import './lib/tools.web';` — self-registers on import (mirrors
// the tools.terminals.ts pattern).
//
// Why read-only by design
// -----------------------
// None of these tools write to the user's machine or trigger side
// effects on third parties. A GET request is functionally equivalent
// to the user pasting a URL into their browser, so `dangerous: false`
// across the board. If anyone later adds a POST-capable web tool
// (form submit, webhook trigger), gate it with `dangerous: true`.

import { registerTool, type Tool, type ToolResult } from './tools';
import { invokeSafe } from './tauri';

// ---------------------------------------------------------------------------
// Local validation helpers (kept inline so this module stays self-contained,
// matching the tools.terminals.ts convention — we don't reach into the
// builtins folder for shared utilities).
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

function optionalInt(
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

// URLs coming from an LLM are semi-trustworthy at best — validate shape
// up-front so a typoed "htp://example.com" fails fast with a helpful
// message instead of a generic reqwest error.
function validateHttpUrl(raw: string): string | ParseError {
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) {
    return { message: `"url" must start with http:// or https:// and contain no whitespace` };
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Output bounds (mirrors the Rust side). Declared here so the JSON schema
// can expose the ceiling to the planner.
// ---------------------------------------------------------------------------

const FETCH_DEFAULT_MAX_CHARS = 4_000;
const FETCH_HARD_MAX_CHARS = 12_000;
const LINKS_DEFAULT_MAX = 30;
const LINKS_HARD_MAX = 200;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const webFetchTool: Tool = {
  schema: {
    name: 'web_fetch',
    description:
      'GET a URL and return its readable body. HTML pages are stripped of scripts/styles and whitespace-collapsed into reading text; JSON responses are pretty-printed; other content-types are returned verbatim. Output is truncated to max_chars with a "[truncated at N chars]" marker when longer.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to fetch.',
        },
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: FETCH_HARD_MAX_CHARS,
          description: `Max characters of body text to return (default ${FETCH_DEFAULT_MAX_CHARS}, hard ceiling ${FETCH_HARD_MAX_CHARS}).`,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('web_fetch', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['url', 'max_chars']);
    if (unknown) return validationFailure(started, unknown.message);

    const urlIn = requireString(input, 'url');
    if (isParseError(urlIn)) return validationFailure(started, urlIn.message);
    const url = validateHttpUrl(urlIn);
    if (isParseError(url)) return validationFailure(started, url.message);

    const maxCharsIn = optionalInt(input, 'max_chars');
    if (isParseError(maxCharsIn)) return validationFailure(started, maxCharsIn.message);

    const body = await invokeSafe<string>('web_fetch', {
      url,
      maxChars: maxCharsIn,
    });
    if (body === null) {
      return {
        ok: false,
        content: `web_fetch("${url}") failed (backend unavailable or threw).`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('web_fetch', started, 'after');
    return {
      ok: true,
      content: body,
      data: { url, chars: body.length },
      latency_ms: Date.now() - started,
    };
  },
};

const webSearchTool: Tool = {
  schema: {
    name: 'tool_web_search',
    description:
      'Search the public web for a query and return up to 8 results (title, URL, snippet) as a numbered list. Scrapes DuckDuckGo\'s HTML endpoint; transparently falls back to Brave Search if DuckDuckGo blocks or returns nothing.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query text (natural language or keywords).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('tool_web_search', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['query']);
    if (unknown) return validationFailure(started, unknown.message);
    const query = requireString(input, 'query');
    if (isParseError(query)) return validationFailure(started, query.message);

    const rendered = await invokeSafe<string>('tool_web_search', { query });
    if (rendered === null) {
      return {
        ok: false,
        content: `tool_web_search("${query}") failed (backend unavailable or threw).`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('tool_web_search', started, 'after');
    return {
      ok: true,
      content: rendered,
      data: { query },
      latency_ms: Date.now() - started,
    };
  },
};

const webExtractLinksTool: Tool = {
  schema: {
    name: 'web_extract_links',
    description:
      'Fetch a URL and list up to max_links <a href> entries with their anchor text, resolved to absolute URLs (against the final post-redirect location). Useful for navigating a site without fetching every page.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to scan.',
        },
        max_links: {
          type: 'integer',
          minimum: 1,
          maximum: LINKS_HARD_MAX,
          description: `Maximum links to return (default ${LINKS_DEFAULT_MAX}, hard ceiling ${LINKS_HARD_MAX}).`,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('web_extract_links', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['url', 'max_links']);
    if (unknown) return validationFailure(started, unknown.message);

    const urlIn = requireString(input, 'url');
    if (isParseError(urlIn)) return validationFailure(started, urlIn.message);
    const url = validateHttpUrl(urlIn);
    if (isParseError(url)) return validationFailure(started, url.message);

    const maxLinksIn = optionalInt(input, 'max_links');
    if (isParseError(maxLinksIn)) return validationFailure(started, maxLinksIn.message);

    const body = await invokeSafe<string>('web_extract_links', {
      url,
      maxLinks: maxLinksIn,
    });
    if (body === null) {
      return {
        ok: false,
        content: `web_extract_links("${url}") failed (backend unavailable or threw).`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('web_extract_links', started, 'after');
    return {
      ok: true,
      content: body,
      data: { url },
      latency_ms: Date.now() - started,
    };
  },
};

const webExtractTitleTool: Tool = {
  schema: {
    name: 'web_extract_title',
    description:
      'Fetch a URL and return its <title> text (or the first <h1> as a fallback for SPAs with empty <title>). Lightweight — useful before committing to a full web_fetch.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to fetch.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('web_extract_title', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['url']);
    if (unknown) return validationFailure(started, unknown.message);

    const urlIn = requireString(input, 'url');
    if (isParseError(urlIn)) return validationFailure(started, urlIn.message);
    const url = validateHttpUrl(urlIn);
    if (isParseError(url)) return validationFailure(started, url.message);

    const title = await invokeSafe<string>('web_extract_title', { url });
    if (title === null) {
      return {
        ok: false,
        content: `web_extract_title("${url}") failed (backend unavailable or threw).`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('web_extract_title', started, 'after');
    return {
      ok: true,
      content: title,
      data: { url, title },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

[
  webFetchTool,
  webSearchTool,
  webExtractLinksTool,
  webExtractTitleTool,
].forEach(registerTool);
