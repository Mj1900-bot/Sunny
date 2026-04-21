// Compute tools — deterministic math, time, regex, encoding, and hashing
// helpers. Usage: `import './lib/tools.compute';` — self-registers on import.
//
// Every tool here mirrors a pure Rust Tauri command (see
// `src-tauri/src/tools_compute.rs`). The Rust side does all the real work:
// this file is just the agent-facing schema, input validation, and the
// one-line human-readable `content` result string.
//
// Tools provided:
//   calc             — arithmetic expression evaluator
//   convert_units    — length / mass / temp / time / speed / data / energy
//   timezone_now     — current time in a named IANA tz
//   timezone_convert — convert a local time from one tz to another
//   date_diff        — humanized delta between two ISO-8601 stamps
//   date_add         — ISO-8601 + `Nd Nh Nm Ns` → new ISO-8601
//   regex_match      — find regex matches
//   regex_replace    — replace via regex
//   json_query       — JSONPath-lite (`$.a.b[0].c`)
//   hash_text        — sha256 / sha1 / md5 hex digest
//   uuid_new         — fresh UUIDv4
//   base64_encode    — standard base64
//   base64_decode    — reverse of the above
//
// All of these are pure and side-effect-free, so `dangerous: false` for
// every single tool.

import { invoke } from './tauri';
import { registerTool, type Tool, type ToolResult } from './tools';

// ---------------------------------------------------------------------------
// Local validation helpers — self-contained so this module has no
// cross-imports into the builtin tools folder.
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

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
): number | ParseError {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { message: `"${key}" must be a finite number` };
  }
  return value;
}

// Reserved helper for future compute tools that take optional strings; kept
// here so the validation helper family stays self-contained.
function _optionalString(
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
// Silence unused-var in strict TS builds without changing the exported surface.
void _optionalString;

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

function failure(started: number, message: string): ToolResult {
  return {
    ok: false,
    content: message,
    latency_ms: Date.now() - started,
  };
}

function invalid(started: number, reason: string): ToolResult {
  return failure(started, `Invalid tool input: ${reason}`);
}

function aborted(name: string, started: number): ToolResult {
  return failure(started, `Tool "${name}" aborted`);
}

/// Shared invoke helper — surfaces the Rust `Err(String)` verbatim so the
/// agent sees "calc: division by zero" instead of a generic "failed".
async function callCompute(
  cmd: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    const out = await invoke<string>(cmd, args);
    return { ok: true, value: out };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// calc
// ---------------------------------------------------------------------------

const calcTool: Tool = {
  schema: {
    name: 'calc',
    description:
      'Evaluate an arithmetic expression deterministically. Supports + - * / % ^, parentheses, unary minus, and the functions sqrt, abs, sin, cos, tan, ln, log, exp, floor, ceil, round (plus the constants pi and e). Returns the result with thousands separators so the LLM does not have to format digits by hand.',
    input_schema: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: 'Arithmetic expression, e.g. "123 * 456" or "sqrt(2) * pi".' },
      },
      required: ['expr'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('calc', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['expr']);
    if (unknown) return invalid(started, unknown.message);
    const expr = requireString(input, 'expr');
    if (isParseError(expr)) return invalid(started, expr.message);

    const res = await callCompute('calc', { expr });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { expr, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// convert_units
// ---------------------------------------------------------------------------

const convertUnitsTool: Tool = {
  schema: {
    name: 'convert_units',
    description:
      'Convert a numeric value between units of the same physical class. Supported classes: length (m, km, mi, ft, in, yd, cm, mm, nm), mass (g, kg, lb, oz, t), temperature (c, f, k), time (s, ms, min, h, d, wk, yr), speed (mps, kph, mph, knots, fps), data (b, kb, mb, gb, tb, kib, mib, gib, tib), and energy (j, kj, cal, kcal, wh, kwh). Unit names are case-insensitive and accept common aliases (e.g. "kilometers", "celsius", "miles_per_hour").',
    input_schema: {
      type: 'object',
      properties: {
        value: { type: 'number', description: 'Numeric value to convert.' },
        from: { type: 'string', description: 'Source unit.' },
        to: { type: 'string', description: 'Target unit (must be in the same class as `from`).' },
      },
      required: ['value', 'from', 'to'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('convert_units', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['value', 'from', 'to']);
    if (unknown) return invalid(started, unknown.message);
    const value = requireNumber(input, 'value');
    if (isParseError(value)) return invalid(started, value.message);
    const from = requireString(input, 'from');
    if (isParseError(from)) return invalid(started, from.message);
    const to = requireString(input, 'to');
    if (isParseError(to)) return invalid(started, to.message);

    const res = await callCompute('convert_units', { value, from, to });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { value, from, to, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// timezone_now
// ---------------------------------------------------------------------------

const timezoneNowTool: Tool = {
  schema: {
    name: 'timezone_now',
    description:
      'Return the current wall-clock time in the given IANA timezone (e.g. "Asia/Tokyo", "America/Los_Angeles", "UTC"). Output format: "13:42:05 JST, Monday 18 April 2026 (UTC+9)".',
    input_schema: {
      type: 'object',
      properties: {
        tz: { type: 'string', description: 'IANA timezone identifier.' },
      },
      required: ['tz'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('timezone_now', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['tz']);
    if (unknown) return invalid(started, unknown.message);
    const tz = requireString(input, 'tz');
    if (isParseError(tz)) return invalid(started, tz.message);

    const res = await callCompute('timezone_now', { tz });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { tz, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// timezone_convert
// ---------------------------------------------------------------------------

const timezoneConvertTool: Tool = {
  schema: {
    name: 'timezone_convert',
    description:
      'Convert a naive local time (ISO-8601 like "2026-04-18T13:42:05") from one IANA timezone to another. Accepts fully-qualified offset-bearing stamps too (e.g. "2026-04-18T13:42:05Z"), in which case `from_tz` is ignored.',
    input_schema: {
      type: 'object',
      properties: {
        time_iso: { type: 'string', description: 'ISO-8601 local or offset-bearing timestamp.' },
        from_tz: { type: 'string', description: 'Source IANA timezone.' },
        to_tz: { type: 'string', description: 'Target IANA timezone.' },
      },
      required: ['time_iso', 'from_tz', 'to_tz'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('timezone_convert', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['time_iso', 'from_tz', 'to_tz']);
    if (unknown) return invalid(started, unknown.message);
    const timeIso = requireString(input, 'time_iso');
    if (isParseError(timeIso)) return invalid(started, timeIso.message);
    const fromTz = requireString(input, 'from_tz');
    if (isParseError(fromTz)) return invalid(started, fromTz.message);
    const toTz = requireString(input, 'to_tz');
    if (isParseError(toTz)) return invalid(started, toTz.message);

    const res = await callCompute('timezone_convert', {
      timeIso,
      fromTz,
      toTz,
    });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { time_iso: timeIso, from_tz: fromTz, to_tz: toTz, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// date_diff
// ---------------------------------------------------------------------------

const dateDiffTool: Tool = {
  schema: {
    name: 'date_diff',
    description:
      'Compute the humanized delta between two ISO-8601 timestamps. Accepts full offset-bearing stamps ("2026-04-18T10:00:00Z") and bare local forms ("2026-04-18 10:00:00", "2026-04-18"). Returns a phrase like "b is 2 days, 4 hours, 13 minutes later than a".',
    input_schema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'First ISO-8601 timestamp.' },
        b: { type: 'string', description: 'Second ISO-8601 timestamp.' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('date_diff', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['a', 'b']);
    if (unknown) return invalid(started, unknown.message);
    const a = requireString(input, 'a');
    if (isParseError(a)) return invalid(started, a.message);
    const b = requireString(input, 'b');
    if (isParseError(b)) return invalid(started, b.message);

    const res = await callCompute('date_diff', { a, b });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { a, b, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// date_add
// ---------------------------------------------------------------------------

const dateAddTool: Tool = {
  schema: {
    name: 'date_add',
    description:
      'Add a delta (e.g. "3d 4h", "-1h 30m", "45s") to an ISO-8601 timestamp. Delta tokens are Nd / Nh / Nm / Ns for days/hours/minutes/seconds, whitespace-separated, with an optional leading "-" to subtract. Returns the new timestamp in RFC 3339 form.',
    input_schema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base ISO-8601 timestamp.' },
        delta: { type: 'string', description: 'Duration expression like "3d 4h" or "-1h 30m".' },
      },
      required: ['base', 'delta'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('date_add', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['base', 'delta']);
    if (unknown) return invalid(started, unknown.message);
    const base = requireString(input, 'base');
    if (isParseError(base)) return invalid(started, base.message);
    const delta = requireString(input, 'delta');
    if (isParseError(delta)) return invalid(started, delta.message);

    const res = await callCompute('date_add', { base, delta });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { base, delta, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// regex_match
// ---------------------------------------------------------------------------

const regexMatchTool: Tool = {
  schema: {
    name: 'regex_match',
    description:
      'Find regex matches in a string. Uses Rust `regex` syntax (RE2-compatible — no lookaround). When `global` is true (default) every match is returned numbered 1..N; when false only the first match is returned. Response is "no matches" when the pattern is not found.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to search.' },
        pattern: { type: 'string', description: 'Regular expression.' },
        global: { type: 'boolean', description: 'Return all matches (default true) vs first only.' },
      },
      required: ['text', 'pattern'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('regex_match', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['text', 'pattern', 'global']);
    if (unknown) return invalid(started, unknown.message);
    const textRaw = input['text'];
    if (typeof textRaw !== 'string') return invalid(started, '"text" must be a string');
    const pattern = requireString(input, 'pattern');
    if (isParseError(pattern)) return invalid(started, pattern.message);
    const globalIn = optionalBoolean(input, 'global');
    if (isParseError(globalIn)) return invalid(started, globalIn.message);

    const args: Record<string, unknown> = { text: textRaw, pattern };
    if (globalIn !== undefined) args.global = globalIn;

    const res = await callCompute('regex_match', args);
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { pattern, global: globalIn ?? true, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// regex_replace
// ---------------------------------------------------------------------------

const regexReplaceTool: Tool = {
  schema: {
    name: 'regex_replace',
    description:
      'Replace every regex match in `text` with `replacement`. The replacement string can reference capture groups as $1, $2, ... (Rust `regex` syntax). Returns the transformed text.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Input text.' },
        pattern: { type: 'string', description: 'Regular expression.' },
        replacement: { type: 'string', description: 'Replacement text (supports $1, $2, ...).' },
      },
      required: ['text', 'pattern', 'replacement'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('regex_replace', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['text', 'pattern', 'replacement']);
    if (unknown) return invalid(started, unknown.message);
    const textRaw = input['text'];
    if (typeof textRaw !== 'string') return invalid(started, '"text" must be a string');
    const pattern = requireString(input, 'pattern');
    if (isParseError(pattern)) return invalid(started, pattern.message);
    const replacementRaw = input['replacement'];
    if (typeof replacementRaw !== 'string') {
      return invalid(started, '"replacement" must be a string');
    }

    const res = await callCompute('regex_replace', {
      text: textRaw,
      pattern,
      replacement: replacementRaw,
    });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { pattern, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// json_query
// ---------------------------------------------------------------------------

const jsonQueryTool: Tool = {
  schema: {
    name: 'json_query',
    description:
      'Extract a value from a JSON string using JSONPath-lite. Supported syntax: `$.a.b[0].c` (leading $ is optional), with both dot and bracket accessors. Brackets accept integer indices or quoted keys ("with.dots"). Filters, wildcards, and recursive descent are intentionally rejected. Returns the selected value pretty-printed.',
    input_schema: {
      type: 'object',
      properties: {
        json_str: { type: 'string', description: 'JSON document as a string.' },
        path: { type: 'string', description: 'JSONPath-lite expression, e.g. "$.users[0].name".' },
      },
      required: ['json_str', 'path'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('json_query', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['json_str', 'path']);
    if (unknown) return invalid(started, unknown.message);
    const jsonStr = requireString(input, 'json_str');
    if (isParseError(jsonStr)) return invalid(started, jsonStr.message);
    const path = requireString(input, 'path');
    if (isParseError(path)) return invalid(started, path.message);

    const res = await callCompute('json_query', { jsonStr, path });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { path, result: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// hash_text
// ---------------------------------------------------------------------------

const hashTextTool: Tool = {
  schema: {
    name: 'hash_text',
    description:
      'Compute the hex digest of a UTF-8 string using sha256, sha1, or md5. Case-insensitive algo name.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Input text to hash.' },
        algo: {
          type: 'string',
          description: 'Digest algorithm: "sha256", "sha1", or "md5".',
        },
      },
      required: ['text', 'algo'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('hash_text', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['text', 'algo']);
    if (unknown) return invalid(started, unknown.message);
    const textRaw = input['text'];
    if (typeof textRaw !== 'string') return invalid(started, '"text" must be a string');
    const algo = requireString(input, 'algo');
    if (isParseError(algo)) return invalid(started, algo.message);

    const res = await callCompute('hash_text', { text: textRaw, algo });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: `${algo.toLowerCase()}: ${res.value}`,
      data: { algo, hex: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// uuid_new
// ---------------------------------------------------------------------------

const uuidNewTool: Tool = {
  schema: {
    name: 'uuid_new',
    description: 'Generate a fresh random (v4) UUID as a canonical 36-character string.',
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
    if (signal.aborted) return aborted('uuid_new', started);
    const res = await callCompute('uuid_new', {});
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { uuid: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// base64_encode / base64_decode
// ---------------------------------------------------------------------------

const base64EncodeTool: Tool = {
  schema: {
    name: 'base64_encode',
    description: 'Encode a UTF-8 string to standard base64 (no URL-safe variant).',
    input_schema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Text to encode.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('base64_encode', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['input']);
    if (unknown) return invalid(started, unknown.message);
    const raw = input['input'];
    if (typeof raw !== 'string') return invalid(started, '"input" must be a string');

    const res = await callCompute('base64_encode', { input: raw });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { encoded: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

const base64DecodeTool: Tool = {
  schema: {
    name: 'base64_decode',
    description: 'Decode a standard-base64 string back to UTF-8. Whitespace is tolerated; invalid bytes produce a parse error.',
    input_schema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Base64-encoded text.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return aborted('base64_decode', started);
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknown(input, ['input']);
    if (unknown) return invalid(started, unknown.message);
    const raw = input['input'];
    if (typeof raw !== 'string') return invalid(started, '"input" must be a string');

    const res = await callCompute('base64_decode', { input: raw });
    if (!res.ok) return failure(started, (res as { ok: false; error: string }).error);
    return {
      ok: true,
      content: res.value,
      data: { decoded: res.value },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

[
  calcTool,
  convertUnitsTool,
  timezoneNowTool,
  timezoneConvertTool,
  dateDiffTool,
  dateAddTool,
  regexMatchTool,
  regexReplaceTool,
  jsonQueryTool,
  hashTextTool,
  uuidNewTool,
  base64EncodeTool,
  base64DecodeTool,
].forEach(registerTool);
