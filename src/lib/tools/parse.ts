// Input validation helpers — light-weight, no external deps.

import type { ToolResult } from './types';

export type ParseError = { readonly message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
): string | ParseError {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    return { message: `"${key}" must be a non-empty string` };
  }
  return value;
}

export function optionalString(
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

export function optionalNumber(
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

export function requireNumber(
  obj: Record<string, unknown>,
  key: string,
): number | ParseError {
  const value = obj[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { message: `"${key}" must be a number` };
  }
  return value;
}

export function isParseError(v: unknown): v is ParseError {
  return isRecord(v) && typeof (v as Record<string, unknown>).message === 'string'
    && !('length' in (v as object));
}

export function requireBoolean(
  obj: Record<string, unknown>,
  key: string,
): boolean | ParseError {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    return { message: `"${key}" must be a boolean` };
  }
  return value;
}

export function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | ParseError {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0) {
    return { message: `"${key}" must be a non-empty array of strings` };
  }
  if (!value.every(v => typeof v === 'string' && v.length > 0)) {
    return { message: `"${key}" must contain only non-empty strings` };
  }
  return value as ReadonlyArray<string>;
}

export function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (!Array.isArray(value)) {
    return { message: `"${key}" must be an array of strings if provided` };
  }
  if (!value.every(v => typeof v === 'string')) {
    return { message: `"${key}" must contain only strings` };
  }
  return value as ReadonlyArray<string>;
}

export function requireObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | ParseError {
  const value = obj[key];
  if (!isRecord(value)) {
    return { message: `"${key}" must be an object` };
  }
  return value;
}

export function enumOf(
  obj: Record<string, unknown>,
  key: string,
  values: ReadonlyArray<string>,
): string | ParseError {
  const value = obj[key];
  if (typeof value !== 'string' || !values.includes(value)) {
    return { message: `"${key}" must be one of: ${values.join(', ')}` };
  }
  return value;
}

// Reject unknown fields: returns a ParseError if the record has keys not in the
// allow-list, otherwise returns null (success sentinel).
export function rejectUnknown(
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

export function abortedResult(
  name: string,
  started: number,
  when: 'before' | 'after',
): ToolResult {
  return {
    ok: false,
    content: `Tool "${name}" aborted ${when} invocation`,
    latency_ms: Date.now() - started,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function validationFailure(started: number, reason: string): ToolResult {
  return {
    ok: false,
    content: `Invalid tool input: ${reason}`,
    latency_ms: Date.now() - started,
  };
}

export function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
