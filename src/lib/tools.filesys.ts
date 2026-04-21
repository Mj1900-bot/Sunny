// Filesystem tools: read/write/edit/rename/mkdir/exists. Usage:
// `import './tools.filesys';` — self-registers on import.
//
// Each tool wraps a matching Tauri command (`file_write`, `file_read_text`,
// …) via `invokeSafe`, keeping all heavy lifting (path resolution, atomic
// writes, size caps, byte-accurate counts) on the Rust side. This file only
// enforces the agent-facing JSON-schema contract, crafts the one-line
// human-readable `content` string, and decides what belongs in `data`.
//
// Display vs. data split:
//   • `content` — a short, human-readable one-liner describing the outcome.
//     Never the raw bytes of a file; the `file_read_text` preview is capped
//     at 400 characters with an ellipsis.
//   • `data`    — structured, machine-consumable payload (full text, byte
//     counts, stat info). Callers that need the full bytes read `data`.

import { invokeSafe } from './tauri';
import { registerTool, type Tool, type ToolResult } from './tools';

// ---------------------------------------------------------------------------
// Backend response shapes — mirrors of the Rust structs we expect.
// ---------------------------------------------------------------------------

type WriteResponse = {
  readonly path: string;
  readonly bytes_written: number;
  readonly created: boolean;
};

type AppendResponse = {
  readonly path: string;
  readonly bytes_appended: number;
  readonly total_bytes: number;
};

type ReadResponse = {
  readonly path: string;
  readonly content: string;
  readonly bytes_read: number;
  readonly truncated: boolean;
};

type EditResponse = {
  readonly path: string;
  readonly replacements: number;
  readonly bytes_before: number;
  readonly bytes_after: number;
};

type DeleteResponse = {
  readonly path: string;
};

type RenameResponse = {
  readonly from: string;
  readonly to: string;
};

type MkdirResponse = {
  readonly path: string;
  readonly created: boolean;
  readonly recursive: boolean;
};

type ExistsResponse = {
  readonly path: string;
  readonly exists: boolean;
  readonly is_file: boolean;
  readonly is_dir: boolean;
  readonly size: number;
  readonly modified_secs: number;
};

// ---------------------------------------------------------------------------
// Validation helpers — strict, no unknown fields, no dependencies.
// ---------------------------------------------------------------------------

type ValidationError = { readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidationError<T>(v: T | ValidationError): v is ValidationError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in (v as Record<string, unknown>) &&
    typeof (v as ValidationError).error === 'string'
  );
}

function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
): ValidationError | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      return { error: `unknown field "${key}"` };
    }
  }
  return null;
}

function requirePath(
  obj: Record<string, unknown>,
  key: string,
): string | ValidationError {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: `"${key}" must be a non-empty string` };
  }
  return value;
}

function requireStringField(
  obj: Record<string, unknown>,
  key: string,
): string | ValidationError {
  const value = obj[key];
  if (typeof value !== 'string') {
    return { error: `"${key}" must be a string` };
  }
  return value;
}

function optionalBool(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined | ValidationError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'boolean') {
    return { error: `"${key}" must be a boolean if provided` };
  }
  return value;
}

function optionalPositiveInt(
  obj: Record<string, unknown>,
  key: string,
): number | undefined | ValidationError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return { error: `"${key}" must be a non-negative integer if provided` };
  }
  return value;
}

// ---------------------------------------------------------------------------
// Small presentation helpers.
// ---------------------------------------------------------------------------

const PREVIEW_CAP = 400;

function previewContent(text: string): string {
  if (text.length <= PREVIEW_CAP) return text;
  return `${text.slice(0, PREVIEW_CAP)}…`;
}

function formatRelativeAge(modifiedSecs: number): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, nowSecs - modifiedSecs);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function failure(started: number, message: string): ToolResult {
  return {
    ok: false,
    content: message,
    latency_ms: Math.round(performance.now() - started),
  };
}

function invalid(started: number, error: string): ToolResult {
  return failure(started, `Invalid tool input: ${error}`);
}

function aborted(started: number, name: string): ToolResult {
  return failure(started, `${name} aborted`);
}

// ---------------------------------------------------------------------------
// Tool: file_write
// ---------------------------------------------------------------------------

const fileWriteTool: Tool = {
  schema: {
    name: 'file_write',
    description:
      'Write (or overwrite) a file with the given UTF-8 content. If `create_dirs` is true, missing parent directories are created.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'File contents (UTF-8)' },
        create_dirs: {
          type: 'boolean',
          description: 'Create missing parent directories (default false)',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknownFields(input, ['path', 'content', 'create_dirs']);
    if (unknown) return invalid(started, unknown.error);

    const path = requirePath(input, 'path');
    if (isValidationError(path)) return invalid(started, path.error);
    const content = requireStringField(input, 'content');
    if (isValidationError(content)) return invalid(started, content.error);
    const createDirs = optionalBool(input, 'create_dirs');
    if (isValidationError(createDirs)) return invalid(started, createDirs.error);

    if (signal.aborted) return aborted(started, 'file_write');
    const result = await invokeSafe<WriteResponse>('file_write', {
      path,
      content,
      createDirs: createDirs ?? false,
    });
    if (signal.aborted) return aborted(started, 'file_write');
    if (!result) return failure(started, `file_write failed for ${path}`);

    const suffix = result.created ? ' (created)' : ' (overwritten)';
    return {
      ok: true,
      content: `wrote ${result.bytes_written} bytes to ${result.path}${suffix}`,
      data: result,
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: file_append
// ---------------------------------------------------------------------------

const fileAppendTool: Tool = {
  schema: {
    name: 'file_append',
    description: 'Append UTF-8 content to an existing file (creating it if missing).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'Content to append (UTF-8)' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknownFields(input, ['path', 'content']);
    if (unknown) return invalid(started, unknown.error);

    const path = requirePath(input, 'path');
    if (isValidationError(path)) return invalid(started, path.error);
    const content = requireStringField(input, 'content');
    if (isValidationError(content)) return invalid(started, content.error);

    if (signal.aborted) return aborted(started, 'file_append');
    const result = await invokeSafe<AppendResponse>('file_append', { path, content });
    if (signal.aborted) return aborted(started, 'file_append');
    if (!result) return failure(started, `file_append failed for ${path}`);

    return {
      ok: true,
      content: `appended ${result.bytes_appended} bytes to ${result.path} (total ${result.total_bytes})`,
      data: result,
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: file_read_text
// ---------------------------------------------------------------------------

const fileReadTextTool: Tool = {
  schema: {
    name: 'file_read_text',
    description:
      'Read a UTF-8 text file. Full contents go to `data.content`; the tool `content` string carries a short status line plus a 400-char preview.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        max_bytes: {
          type: 'integer',
          minimum: 0,
          description: 'Optional read cap (bytes); the backend may also enforce a hard limit',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknownFields(input, ['path', 'max_bytes']);
    if (unknown) return invalid(started, unknown.error);

    const path = requirePath(input, 'path');
    if (isValidationError(path)) return invalid(started, path.error);
    const maxBytes = optionalPositiveInt(input, 'max_bytes');
    if (isValidationError(maxBytes)) return invalid(started, maxBytes.error);

    if (signal.aborted) return aborted(started, 'file_read_text');
    const result = await invokeSafe<ReadResponse>('file_read_text', {
      path,
      maxBytes,
    });
    if (signal.aborted) return aborted(started, 'file_read_text');
    if (!result) return failure(started, `file_read_text failed for ${path}`);

    const header = `read ${result.bytes_read} bytes from ${result.path}${result.truncated ? ' (truncated)' : ''}`;
    const preview = previewContent(result.content);
    const body = preview.length > 0 ? `${header}\n${preview}` : header;

    return {
      ok: true,
      content: body,
      data: result,
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: file_edit
// ---------------------------------------------------------------------------

const fileEditTool: Tool = {
  schema: {
    name: 'file_edit',
    description:
      'Find-and-replace within a UTF-8 text file. If `expect_count` is omitted, the backend default (1) applies — the operation fails unless the find-string appears exactly that many times.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        find: { type: 'string', description: 'Literal string to search for' },
        replace: { type: 'string', description: 'Replacement string' },
        expect_count: {
          type: 'integer',
          minimum: 0,
          description: 'Required number of occurrences (default 1 on the backend)',
        },
      },
      required: ['path', 'find', 'replace'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknownFields(input, ['path', 'find', 'replace', 'expect_count']);
    if (unknown) return invalid(started, unknown.error);

    const path = requirePath(input, 'path');
    if (isValidationError(path)) return invalid(started, path.error);
    const find = requireStringField(input, 'find');
    if (isValidationError(find)) return invalid(started, find.error);
    if (find.length === 0) return invalid(started, '"find" must be a non-empty string');
    const replace = requireStringField(input, 'replace');
    if (isValidationError(replace)) return invalid(started, replace.error);
    const expectCount = optionalPositiveInt(input, 'expect_count');
    if (isValidationError(expectCount)) return invalid(started, expectCount.error);

    if (signal.aborted) return aborted(started, 'file_edit');
    // Pass `null` when omitted so the Rust default of 1 applies unambiguously.
    const result = await invokeSafe<EditResponse>('file_edit', {
      path,
      find,
      replace,
      expectCount: expectCount ?? null,
    });
    if (signal.aborted) return aborted(started, 'file_edit');
    if (!result) return failure(started, `file_edit failed for ${path}`);

    const plural = result.replacements === 1 ? 'occurrence' : 'occurrences';
    return {
      ok: true,
      content: `replaced ${result.replacements} ${plural} in ${result.path} (${result.bytes_before} → ${result.bytes_after} bytes)`,
      data: result,
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: file_delete
// ---------------------------------------------------------------------------

const fileDeleteTool: Tool = {
  schema: {
    name: 'file_delete',
    description: 'Delete a file. Irreversible.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknownFields(input, ['path']);
    if (unknown) return invalid(started, unknown.error);

    const path = requirePath(input, 'path');
    if (isValidationError(path)) return invalid(started, path.error);

    if (signal.aborted) return aborted(started, 'file_delete');
    const result = await invokeSafe<DeleteResponse>('file_delete', { path });
    if (signal.aborted) return aborted(started, 'file_delete');
    if (!result) return failure(started, `file_delete failed for ${path}`);

    return {
      ok: true,
      content: `deleted ${result.path}`,
      data: result,
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: file_rename
// ---------------------------------------------------------------------------

const fileRenameTool: Tool = {
  schema: {
    name: 'file_rename',
    description: 'Rename or move a file or directory.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Absolute source path' },
        to: { type: 'string', description: 'Absolute destination path' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknownFields(input, ['from', 'to']);
    if (unknown) return invalid(started, unknown.error);

    const from = requirePath(input, 'from');
    if (isValidationError(from)) return invalid(started, from.error);
    const to = requirePath(input, 'to');
    if (isValidationError(to)) return invalid(started, to.error);

    if (signal.aborted) return aborted(started, 'file_rename');
    const result = await invokeSafe<RenameResponse>('file_rename', { from, to });
    if (signal.aborted) return aborted(started, 'file_rename');
    if (!result) return failure(started, `file_rename failed for ${from} → ${to}`);

    return {
      ok: true,
      content: `renamed ${result.from} → ${result.to}`,
      data: result,
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: file_mkdir
// ---------------------------------------------------------------------------

const fileMkdirTool: Tool = {
  schema: {
    name: 'file_mkdir',
    description:
      'Create a directory. Set `recursive` to true to create all missing parents (like `mkdir -p`).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path' },
        recursive: {
          type: 'boolean',
          description: 'Create missing parent directories (default false)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknownFields(input, ['path', 'recursive']);
    if (unknown) return invalid(started, unknown.error);

    const path = requirePath(input, 'path');
    if (isValidationError(path)) return invalid(started, path.error);
    const recursive = optionalBool(input, 'recursive');
    if (isValidationError(recursive)) return invalid(started, recursive.error);

    if (signal.aborted) return aborted(started, 'file_mkdir');
    const result = await invokeSafe<MkdirResponse>('file_mkdir', {
      path,
      recursive: recursive ?? false,
    });
    if (signal.aborted) return aborted(started, 'file_mkdir');
    if (!result) return failure(started, `file_mkdir failed for ${path}`);

    const flag = result.recursive ? ' (recursive)' : '';
    const verb = result.created ? 'created' : 'exists';
    return {
      ok: true,
      content: `${verb} ${result.path}${flag}`,
      data: result,
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: file_exists
// ---------------------------------------------------------------------------

const fileExistsTool: Tool = {
  schema: {
    name: 'file_exists',
    description:
      'Stat a path. Returns existence plus (when present) size and modified-time metadata.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    if (!isRecord(input)) return invalid(started, 'expected an object');
    const unknown = rejectUnknownFields(input, ['path']);
    if (unknown) return invalid(started, unknown.error);

    const path = requirePath(input, 'path');
    if (isValidationError(path)) return invalid(started, path.error);

    if (signal.aborted) return aborted(started, 'file_exists');
    const result = await invokeSafe<ExistsResponse>('file_exists', { path });
    if (signal.aborted) return aborted(started, 'file_exists');
    if (!result) return failure(started, `file_exists failed for ${path}`);

    if (!result.exists) {
      return {
        ok: true,
        content: `${result.path} does not exist`,
        data: result,
        latency_ms: Math.round(performance.now() - started),
      };
    }

    const kind = result.is_dir ? 'directory' : result.is_file ? 'file' : 'entry';
    const age = formatRelativeAge(result.modified_secs);
    const sizeLabel = result.is_file ? `${result.size}-byte ` : '';
    return {
      ok: true,
      content: `${result.path} is a ${sizeLabel}${kind}, modified ${age}`,
      data: result,
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Self-register at module load.
// ---------------------------------------------------------------------------

registerTool(fileWriteTool);
registerTool(fileAppendTool);
registerTool(fileReadTextTool);
registerTool(fileEditTool);
registerTool(fileDeleteTool);
registerTool(fileRenameTool);
registerTool(fileMkdirTool);
registerTool(fileExistsTool);
