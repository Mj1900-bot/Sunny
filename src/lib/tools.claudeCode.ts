// Drive Claude Code through a PTY.
//
// Self-registering: importing this module as a side-effect adds the
// `claude_code_run` tool to the shared registry in ./tools.ts.
//
// The tool opens a PTY via the pre-existing `pty_agent_*` Tauri commands,
// launches the `claude` CLI, sends a prompt, watches output for completion
// markers, auto-confirms dangerous prompts (the tool itself is already
// gated by the ConfirmGate via `dangerous: true`), and returns the full
// captured transcript.

import { registerTool, type Tool, type ToolResult } from './tools';
import { invokeSafe } from './tauri';

// ---------------------------------------------------------------------------
// Light-weight validation helpers (kept local to stay self-contained).
// ---------------------------------------------------------------------------

type ParseError = { readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParseError(v: unknown): v is ParseError {
  return isRecord(v) && typeof (v as Record<string, unknown>).message === 'string'
    && !('length' in (v as object));
}

function requireString(obj: Record<string, unknown>, key: string): string | ParseError {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    return { message: `"${key}" must be a non-empty string` };
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'string') {
    return { message: `"${key}" must be a string if provided` };
  }
  return value;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { message: `"${key}" must be a number if provided` };
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

// ---------------------------------------------------------------------------
// Defaults.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 900;          // 15 minutes overall budget
const MAX_TIMEOUT_SEC = 3600;             // never more than 1 hour
const DEFAULT_CLAUDE_BIN = 'claude';
const DEFAULT_CWD = '~';
const DEFAULT_COLS = 140;
const DEFAULT_ROWS = 40;
const DEFAULT_SHELL = '/bin/zsh';

// How long (ms) without new output before we consider Claude "idle-done".
const IDLE_DONE_MS = 30_000;
// How often (ms) to poll the PTY buffer while watching.
const CHECK_INTERVAL_MS = 1_500;
// Read a new buffer diff at least this often even if nothing happens.
const READ_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Backend response shapes (mirror tools.ptyAgent.ts).
// ---------------------------------------------------------------------------

type PtyOpenResult = {
  id: string;
  pid?: number;
};

type PtyWaitResult = {
  matched: boolean;
  offset?: number;
  elapsed_ms?: number;
};

type PtyReadResult = {
  bytes: string;
  next_offset?: number;
  bytes_len?: number;
};

type PtyStopResult = {
  id: string;
  exit_code?: number | null;
  signal?: string | null;
};

// Final state classification.
type FinalState =
  | 'completed'
  | 'idle_done'
  | 'timeout'
  | 'aborted'
  | 'launch_failed'
  | 'error';

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

function hashStr(s: string): string {
  // Fast, stable-ish non-crypto hash — enough for id uniqueness alongside the
  // high-resolution timestamp.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  return h.toString(36);
}

function slice(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

// Heuristic completion markers — any of these appearing in the freshly-read
// diff means Claude Code finished answering.
const COMPLETION_MARKERS: ReadonlyArray<string> = [
  'Task complete',
  'task complete',
  '\u2713',          // ✓
  '\u23FA',          // ⏺ (start of reply block)
];

// Heuristic confirmation prompts — Claude/CLI asking "Do you want to ...".
const CONFIRMATION_MARKERS: ReadonlyArray<RegExp> = [
  /Do you want to [^?\n]*\?/i,
  /\(y\/n\)\s*$/i,
  /\[y\/N\]\s*$/i,
  /\[Y\/n\]\s*$/i,
  /Continue\?\s*$/i,
  /Proceed\?\s*$/i,
];

// Heuristic error indicators — recorded but do not abort the loop.
const ERROR_MARKERS: ReadonlyArray<RegExp> = [
  /\bError:\s.+/i,
  /\bFailed to\s.+/i,
];

function findFirstMatch(text: string, patterns: ReadonlyArray<RegExp>): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

function containsAny(text: string, markers: ReadonlyArray<string>): boolean {
  for (const m of markers) {
    if (text.includes(m)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Abort-aware sleep.
// ---------------------------------------------------------------------------

function sleep(ms: number, signal: AbortSignal): Promise<'ok' | 'aborted'> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('ok');
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve('aborted');
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// PTY read helper — returns the full buffer text and the next_offset to pass
// back in the next call (so we only see fresh bytes each time).
// ---------------------------------------------------------------------------

async function readBuffer(
  id: string,
  fromOffset: number,
): Promise<{ chunk: string; nextOffset: number } | null> {
  const res = await invokeSafe<PtyReadResult>('pty_agent_read_buffer', {
    id,
    from_offset: fromOffset,
  });
  if (!res) return null;
  const chunk = typeof res.bytes === 'string' ? res.bytes : '';
  const bytesLen =
    typeof res.bytes_len === 'number'
      ? res.bytes_len
      : new TextEncoder().encode(chunk).length;
  const nextOffset =
    typeof res.next_offset === 'number' ? res.next_offset : fromOffset + bytesLen;
  return { chunk, nextOffset };
}

// ---------------------------------------------------------------------------
// awaitIdle — polls read_buffer, returns when no new bytes appear for quietMs.
// ---------------------------------------------------------------------------

async function awaitIdle(
  id: string,
  fromOffset: number,
  quietMs: number,
  checkInterval: number,
  signal: AbortSignal,
  maxMs: number,
): Promise<{ nextOffset: number; idle: boolean; aborted: boolean }> {
  const started = Date.now();
  let lastGrowth = Date.now();
  let offset = fromOffset;
  while (true) {
    if (signal.aborted) return { nextOffset: offset, idle: false, aborted: true };
    const now = Date.now();
    if (now - started > maxMs) return { nextOffset: offset, idle: false, aborted: false };
    const slept = await sleep(checkInterval, signal);
    if (slept === 'aborted') return { nextOffset: offset, idle: false, aborted: true };
    const res = await readBuffer(id, offset);
    if (!res) continue;
    if (res.nextOffset > offset) {
      offset = res.nextOffset;
      lastGrowth = Date.now();
      continue;
    }
    if (Date.now() - lastGrowth >= quietMs) {
      return { nextOffset: offset, idle: true, aborted: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Safe stop — never throws, never blocks abort.
// ---------------------------------------------------------------------------

async function stopPty(id: string): Promise<void> {
  try {
    await invokeSafe<PtyStopResult>('pty_agent_stop', { id });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// The tool.
// ---------------------------------------------------------------------------

const claudeCodeRunTool: Tool = {
  schema: {
    name: 'claude_code_run',
    description:
      'Drive the `claude` CLI through a PTY: cd to cwd, launch Claude Code, send a prompt, watch for completion, return the transcript.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt to send to Claude Code.' },
        cwd: {
          type: 'string',
          description: 'Working directory to cd into before launching (default "~").',
        },
        timeout_sec: {
          type: 'number',
          minimum: 10,
          maximum: MAX_TIMEOUT_SEC,
          description: `Overall timeout (default ${DEFAULT_TIMEOUT_SEC}s, max ${MAX_TIMEOUT_SEC}s).`,
        },
        claude_bin: {
          type: 'string',
          description: `Claude Code binary name / path (default "${DEFAULT_CLAUDE_BIN}").`,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();

    // --- validate ---------------------------------------------------------
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['prompt', 'cwd', 'timeout_sec', 'claude_bin']);
    if (unknown) return validationFailure(started, unknown.message);

    const prompt = requireString(input, 'prompt');
    if (isParseError(prompt)) return validationFailure(started, prompt.message);

    const cwdIn = optionalString(input, 'cwd');
    if (isParseError(cwdIn)) return validationFailure(started, cwdIn.message);
    const cwd = cwdIn ?? DEFAULT_CWD;

    const timeoutIn = optionalNumber(input, 'timeout_sec');
    if (isParseError(timeoutIn)) return validationFailure(started, timeoutIn.message);
    const timeoutSec = Math.min(
      MAX_TIMEOUT_SEC,
      Math.max(10, Math.trunc(timeoutIn ?? DEFAULT_TIMEOUT_SEC)),
    );

    const claudeBinIn = optionalString(input, 'claude_bin');
    if (isParseError(claudeBinIn)) return validationFailure(started, claudeBinIn.message);
    const claudeBin = claudeBinIn ?? DEFAULT_CLAUDE_BIN;

    // --- abort early ------------------------------------------------------
    if (signal.aborted) {
      return {
        ok: false,
        content: 'aborted',
        latency_ms: Date.now() - started,
      };
    }

    // --- build a unique pty id -------------------------------------------
    const nanos = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? Math.trunc(performance.now() * 1000)
      : Date.now() * 1000;
    const id = `claude-${nanos}-${hashStr(prompt).slice(0, 6)}`;

    // --- open pty ---------------------------------------------------------
    const open = await invokeSafe<PtyOpenResult>('pty_agent_open', {
      id,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      shell: DEFAULT_SHELL,
    });
    if (signal.aborted) {
      await stopPty(id);
      return { ok: false, content: 'aborted', latency_ms: Date.now() - started };
    }
    if (!open) {
      return {
        ok: false,
        content: `failed to open pty "${id}"`,
        latency_ms: Date.now() - started,
      };
    }

    // Helper: wrap every further invokeSafe with abort short-circuit.
    const aborted = (): ToolResult => ({
      ok: false,
      content: 'aborted',
      latency_ms: Date.now() - started,
    });

    try {
      // --- wait for initial shell prompt --------------------------------
      const firstPrompt = await invokeSafe<PtyWaitResult>('pty_agent_wait_for', {
        id,
        pattern: '\\$ $',
        timeout_sec: 8,
      });
      if (signal.aborted) { await stopPty(id); return aborted(); }
      // Non-fatal if the prompt pattern didn't match — some shells render
      // exotic prompts. We continue anyway.
      void firstPrompt;

      // --- cd into working directory ------------------------------------
      await invokeSafe<unknown>('pty_agent_send_line', {
        id,
        text: `cd ${JSON.stringify(cwd)}`,
        press_enter: true,
      });
      if (signal.aborted) { await stopPty(id); return aborted(); }

      await invokeSafe<PtyWaitResult>('pty_agent_wait_for', {
        id,
        pattern: '\\$ $',
        timeout_sec: 8,
      });
      if (signal.aborted) { await stopPty(id); return aborted(); }

      // Read everything produced so far and remember the offset — from here
      // on we only care about new bytes emitted by `claude`.
      const pre = await readBuffer(id, 0);
      let offset = pre?.nextOffset ?? 0;
      let transcript = pre?.chunk ?? '';

      // --- launch Claude Code -------------------------------------------
      await invokeSafe<unknown>('pty_agent_send_line', {
        id,
        text: claudeBin,
        press_enter: true,
      });
      if (signal.aborted) { await stopPty(id); return aborted(); }

      const readyWait = await invokeSafe<PtyWaitResult>('pty_agent_wait_for', {
        id,
        // `│` is Claude's interactive input frame, `>` is the bare prompt.
        pattern: '(\\│|>)\\s*$',
        timeout_sec: 15,
      });
      if (signal.aborted) { await stopPty(id); return aborted(); }
      if (!readyWait || !readyWait.matched) {
        // Couldn't detect Claude's input indicator. Capture whatever we have.
        const tail = await readBuffer(id, offset);
        if (tail) {
          transcript += tail.chunk;
          offset = tail.nextOffset;
        }
        await stopPty(id);
        return {
          ok: false,
          content: `Claude Code did not present an input indicator within 15s`,
          data: {
            transcript,
            final_state: 'launch_failed' as FinalState,
            error: 'launch timeout',
          },
          latency_ms: Date.now() - started,
        };
      }

      // --- send the prompt ---------------------------------------------
      await invokeSafe<unknown>('pty_agent_send_line', {
        id,
        text: prompt,
        press_enter: true,
      });
      if (signal.aborted) { await stopPty(id); return aborted(); }

      // --- watch loop ---------------------------------------------------
      const deadline = started + timeoutSec * 1000;
      let finalState: FinalState = 'timeout';
      let lastError: string | null = null;
      let sawAnyResponse = false;
      let totalBytes = 0;
      let lastReadAt = Date.now();
      let lastGrowthAt = Date.now();

      while (Date.now() < deadline) {
        if (signal.aborted) {
          finalState = 'aborted';
          break;
        }

        const slept = await sleep(CHECK_INTERVAL_MS, signal);
        if (slept === 'aborted') {
          finalState = 'aborted';
          break;
        }

        // Read a buffer diff periodically (or when we think something new
        // might be there).
        if (Date.now() - lastReadAt < READ_INTERVAL_MS) continue;
        lastReadAt = Date.now();

        const diff = await readBuffer(id, offset);
        if (!diff) continue;
        if (diff.chunk.length > 0) {
          transcript += diff.chunk;
          offset = diff.nextOffset;
          totalBytes += new TextEncoder().encode(diff.chunk).length;
          lastGrowthAt = Date.now();
          sawAnyResponse = true;

          // --- error indicators (record, keep watching) ----------------
          if (lastError === null) {
            const errMatch = findFirstMatch(diff.chunk, ERROR_MARKERS);
            if (errMatch) lastError = errMatch;
          }

          // --- confirmation prompts ------------------------------------
          if (findFirstMatch(diff.chunk, CONFIRMATION_MARKERS)) {
            await invokeSafe<unknown>('pty_agent_send_line', {
              id,
              text: 'yes',
              press_enter: true,
            });
            if (signal.aborted) {
              finalState = 'aborted';
              break;
            }
            // After confirming, reset idle timer; keep watching.
            lastGrowthAt = Date.now();
            continue;
          }

          // --- explicit completion markers -----------------------------
          if (containsAny(diff.chunk, COMPLETION_MARKERS)) {
            // Still wait a short idle window so we capture trailing output.
            const tail = await awaitIdle(id, offset, 2_000, 500, signal, 8_000);
            if (tail.aborted) {
              finalState = 'aborted';
              break;
            }
            if (tail.nextOffset > offset) {
              const extra = await readBuffer(id, offset);
              if (extra) {
                transcript += extra.chunk;
                offset = extra.nextOffset;
                totalBytes += new TextEncoder().encode(extra.chunk).length;
              }
            }
            finalState = 'completed';
            break;
          }
        }

        // --- idle heuristic: no new bytes for IDLE_DONE_MS after at
        // least one response means Claude is done even without a marker.
        if (
          sawAnyResponse &&
          Date.now() - lastGrowthAt >= IDLE_DONE_MS
        ) {
          finalState = 'idle_done';
          break;
        }
      }

      if (finalState === 'aborted') {
        await stopPty(id);
        return {
          ok: false,
          content: 'aborted',
          data: {
            transcript: slice(transcript),
            final_state: 'aborted' as FinalState,
            error: lastError,
          },
          latency_ms: Date.now() - started,
        };
      }

      // Final drain of whatever's left in the buffer.
      const drain = await readBuffer(id, offset);
      if (drain && drain.chunk.length > 0) {
        transcript += drain.chunk;
        offset = drain.nextOffset;
        totalBytes += new TextEncoder().encode(drain.chunk).length;
      }

      await stopPty(id);

      const elapsedSec = Math.round((Date.now() - started) / 100) / 10;
      const ok = finalState === 'completed' || finalState === 'idle_done';

      return {
        ok,
        content: `Claude Code ran for ${elapsedSec}s, emitted ${totalBytes} bytes (state: ${finalState}${lastError ? `, first_error: ${lastError}` : ''})`,
        data: {
          transcript,
          preview: slice(transcript),
          final_state: finalState,
          error: lastError,
          id,
          elapsed_ms: Date.now() - started,
          bytes: totalBytes,
        },
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      await stopPty(id);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        content: `claude_code_run failed: ${msg}`,
        data: { final_state: 'error' as FinalState, error: msg },
        latency_ms: Date.now() - started,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Self-registration.
// ---------------------------------------------------------------------------

registerTool(claudeCodeRunTool);
