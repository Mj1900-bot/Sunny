// Delegation tools — let a running agent spawn helper sub-agents.
//
// These are the bridge between the ReAct loop (agentLoop.ts) and the
// sub-agent worker (../../subAgents.ts + ../../../store/subAgents.ts).
// Without them the agent has no idea the sub-agent machinery exists; it
// tries to do everything in a single monolithic loop and hits the step
// cap on complex fan-out tasks (e.g. "audit deps in all 10 repos").
//
// Tools exposed:
//   • spawn_subagent      — queue one child; optional `wait` blocks for result
//   • spawn_parallel      — queue N children in one call; optional `wait`
//     blocks for all results aggregated in the same tool return
//   • subagent_status     — cheap non-blocking read of one run
//   • subagent_wait       — block up to timeout on one run
//   • subagent_wait_all   — block up to timeout on many runs; return
//     per-child status+answer (partial results on timeout)
//   • subagent_abort      — cancel one child
//   • subagent_list       — fleet overview with status/parent filters
//
// Safety ledger:
//   • Depth cap (MAX_DEPTH = 3) blocks runaway recursion. The parent
//     label carries "@depth:N" segments; parseParentDepth reads the
//     max and caps the next spawn.
//   • Concurrency cap lives in the subagents store (default 4). Excess
//     spawns queue, they don't fail.
//   • Cancel cascade: when a parent run's AbortSignal fires, every
//     child it spawned is aborted too. That prevents orphaned children
//     from hogging the worker when the user hits "stop" on a run.

import { useSubAgents, type SubAgentRun, type SubAgentStatus } from '../../../store/subAgents';
import {
  abortedResult,
  isParseError,
  isRecord,
  optionalNumber,
  optionalString,
  optionalStringArray,
  rejectUnknown,
  requireString,
  requireStringArray,
  truncate,
  validationFailure,
} from '../parse';
import type { Tool, ToolResult } from '../types';

// ---------------------------------------------------------------------------
// Run-context plumbing. `runAgent` owns one AbortSignal per invocation; we
// use it as the identity key in a WeakMap so that concurrent runs don't
// clobber each other's parent/depth (module globals are single-threaded
// in JS, but async tool calls can still interleave across `await`s).
// If no context is registered for a signal, we assume depth 0 — i.e. a
// human-initiated run is the root.
// ---------------------------------------------------------------------------

const MAX_DEPTH = 3;

export type ParentCtx = {
  /** Label prefix for descendant runs, e.g. "agent", "daemon:<id>@depth:1". */
  readonly label: string;
  /** How deep this run sits in the delegation tree (0 = root). */
  readonly depth: number;
  /** The parent run's outer AbortSignal. Used to cascade aborts through
   *  the child fleet when the parent is cancelled. */
  readonly parentSignal: AbortSignal;
};

// Keyed on the per-tool-invocation signal; populated by runAgent before
// every runTool and cleared in the finally block.
const SIGNAL_CONTEXT = new WeakMap<AbortSignal, ParentCtx>();

// Keyed on the parent's outer run signal. Tracks every child the run
// has ever spawned so we can cancel them all when the parent aborts.
// Using a Set so duplicate registration is harmless.
const RUN_CHILDREN = new WeakMap<AbortSignal, Set<string>>();
// And a parallel tally of signals we've already hooked — re-hooking the
// same abort listener would double-abort children. Not strictly needed
// with `once: true`, but cheap defence in depth.
const HOOKED_SIGNALS = new WeakSet<AbortSignal>();

/** Register the parent/depth for an in-flight runAgent invocation. */
export function registerRunContext(signal: AbortSignal, ctx: ParentCtx): void {
  SIGNAL_CONTEXT.set(signal, ctx);

  // First time we see this parent's outer signal: set up the cascade.
  const outer = ctx.parentSignal;
  if (!HOOKED_SIGNALS.has(outer)) {
    HOOKED_SIGNALS.add(outer);
    if (!RUN_CHILDREN.has(outer)) {
      RUN_CHILDREN.set(outer, new Set<string>());
    }
    if (!outer.aborted) {
      outer.addEventListener(
        'abort',
        () => {
          const ids = RUN_CHILDREN.get(outer);
          if (!ids || ids.size === 0) return;
          const { abort } = useSubAgents.getState();
          for (const id of ids) {
            try {
              abort(id);
            } catch (err) {
              console.warn('[delegation] cascade abort failed for', id, err);
            }
          }
          ids.clear();
        },
        { once: true },
      );
    }
  }
}

/** Remove a signal's context when its runAgent terminates. */
export function clearRunContext(signal: AbortSignal): void {
  SIGNAL_CONTEXT.delete(signal);
}

function readParent(signal: AbortSignal): ParentCtx | null {
  return SIGNAL_CONTEXT.get(signal) ?? null;
}

/**
 * Parse a parent label like "agent@depth:2" or "daemon:xyz@depth:1" and
 * return the derived depth. Used by the sub-agent worker when it picks
 * up a queued run and needs to know what depth this child lives at.
 */
export function parseParentDepth(parent: string | null): number {
  if (!parent) return 0;
  const m = parent.match(/@depth:(\d+)\b[^@]*$/);
  if (!m) return 0;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? Math.min(MAX_DEPTH, Math.max(0, n)) : 0;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<SubAgentStatus> = new Set([
  'done',
  'aborted',
  'error',
  'max_steps',
]);

function isTerminal(status: SubAgentStatus): boolean {
  return TERMINAL.has(status);
}

function findRun(id: string): SubAgentRun | null {
  const runs = useSubAgents.getState().runs;
  return runs.find(r => r.id === id) ?? null;
}

function summariseRun(run: SubAgentRun): string {
  const last = run.steps.length > 0 ? run.steps[run.steps.length - 1] : null;
  const when = last ? new Date(last.at).toISOString().slice(11, 19) : '—';
  const preview = last ? truncate(last.text ?? '', 120) : '(no steps yet)';
  return [
    `[${run.id.slice(0, 8)}] status=${run.status} steps=${run.steps.length} last=${when}`,
    `goal: ${truncate(run.goal, 180)}`,
    `last: ${preview}`,
    run.status === 'done' || run.status === 'error' || run.status === 'max_steps'
      ? `final: ${truncate(run.finalAnswer, 400)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function trackChild(ctx: ParentCtx, id: string): void {
  const set = RUN_CHILDREN.get(ctx.parentSignal);
  if (set) {
    set.add(id);
  } else {
    const fresh = new Set<string>([id]);
    RUN_CHILDREN.set(ctx.parentSignal, fresh);
  }
}

/**
 * Spawn a single child with the proper parent label + depth + tracking.
 * Used by both spawn_subagent (N=1) and spawn_parallel (N>=1).
 */
function spawnChild(
  parent: ParentCtx,
  goal: string,
  nextDepth: number,
): string {
  const parentLabel = `${parent.label}@depth:${nextDepth}`;
  const id = useSubAgents.getState().spawn(goal, parentLabel);
  trackChild(parent, id);
  return id;
}

function friendlyLabelOf(raw: string, fallbackGoal: string): string {
  const text = raw.trim() || fallbackGoal.split(/\s+/).slice(0, 6).join(' ');
  return truncate(text, 80);
}

async function pollUntilTerminal(
  id: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ timedOut: boolean; run: SubAgentRun | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return { timedOut: false, run: findRun(id) };
    const run = findRun(id);
    if (!run) return { timedOut: false, run: null };
    if (isTerminal(run.status)) return { timedOut: false, run };
    if (Date.now() >= deadline) return { timedOut: true, run };
    // Short sleep — sub-agent steps typically take 500ms-5s per ReAct
    // turn, so 500ms polling feels snappy without burning CPU.
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Wait for every id in the set to reach a terminal state or the deadline
 * to elapse. Returns per-id results; timed-out runs are flagged.
 *
 * We poll a single "any progress?" loop rather than N independent
 * `pollUntilTerminal` calls so the polling cadence adapts — a quiet
 * fleet wakes us at 500ms, a busy one immediately as each child lands.
 */
async function waitAllTerminal(
  ids: ReadonlyArray<string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<
  ReadonlyArray<{ id: string; run: SubAgentRun | null; timedOut: boolean }>
> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(ids);
  const out = new Map<
    string,
    { id: string; run: SubAgentRun | null; timedOut: boolean }
  >();

  for (;;) {
    if (signal.aborted) break;
    for (const id of [...pending]) {
      const run = findRun(id);
      if (!run) {
        out.set(id, { id, run: null, timedOut: false });
        pending.delete(id);
        continue;
      }
      if (isTerminal(run.status)) {
        out.set(id, { id, run, timedOut: false });
        pending.delete(id);
      }
    }
    if (pending.size === 0) break;
    if (Date.now() >= deadline) {
      for (const id of pending) {
        out.set(id, { id, run: findRun(id), timedOut: true });
      }
      break;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
  return ids.map(id => out.get(id) ?? { id, run: findRun(id), timedOut: false });
}

// ---------------------------------------------------------------------------
// spawn_subagent — queue a child ReAct run, optionally wait for its result
// ---------------------------------------------------------------------------

export const spawnSubagentTool: Tool = {
  schema: {
    name: 'spawn_subagent',
    description:
      'Spawn one helper sub-agent with its own ReAct loop and the full tool registry. Set `wait: true` to block until it terminates (or `timeout_sec` elapses) and get its final answer; otherwise fire-and-forget and use subagent_wait/subagent_status later. For N parallel spawns, prefer spawn_parallel — it fans out in one call. Max delegation depth is 3.',
    input_schema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'Plain-English goal for the child. Be specific and self-contained — the sub-agent does not inherit your transcript.',
        },
        wait: {
          type: 'boolean',
          description:
            'If true, poll until the child reaches a terminal state (or `timeout_sec` elapses) and return its finalAnswer. Default false (fire-and-forget).',
        },
        timeout_sec: {
          type: 'integer',
          minimum: 5,
          maximum: 1800,
          description:
            'Only used when `wait` is true. Seconds to block before returning a timeout result (default 300, max 1800 = 30 min).',
        },
        label: {
          type: 'string',
          description:
            'Short tag for the ACTIVITY row (e.g. "dep-audit:sunny"). Defaults to the first 6 words of the goal.',
        },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['goal', 'wait', 'timeout_sec', 'label']);
    if (unknown) return validationFailure(started, unknown.message);

    const goal = requireString(input, 'goal');
    if (isParseError(goal)) return validationFailure(started, goal.message);
    if (goal.trim().length < 8) {
      return validationFailure(
        started,
        '"goal" must be at least 8 characters — give the sub-agent something substantive to do',
      );
    }

    const waitRaw = input['wait'];
    const wait = typeof waitRaw === 'boolean' ? waitRaw : false;

    const timeoutIn = optionalNumber(input, 'timeout_sec');
    if (isParseError(timeoutIn)) return validationFailure(started, timeoutIn.message);
    const timeoutSec = Math.min(1800, Math.max(5, Math.trunc(timeoutIn ?? 300)));

    const labelIn = optionalString(input, 'label');
    if (isParseError(labelIn)) return validationFailure(started, labelIn.message);

    const parent = readParent(signal);
    if (!parent) {
      // No parent context means delegation was called outside a runAgent
      // invocation — programmer error. Fail loud.
      return {
        ok: false,
        content:
          'spawn_subagent called outside a runAgent context — delegation tools only work inside an agent run.',
        latency_ms: Date.now() - started,
      };
    }
    if (parent.depth >= MAX_DEPTH) {
      return {
        ok: false,
        content:
          `spawn_subagent refused: delegation depth ${parent.depth} >= max ${MAX_DEPTH}. ` +
          `Do the work yourself at this level instead of nesting another layer.`,
        latency_ms: Date.now() - started,
      };
    }

    const nextDepth = parent.depth + 1;
    if (signal.aborted) return abortedResult('spawn_subagent', started, 'before');
    const id = spawnChild(parent, goal, nextDepth);

    const friendlyLabel = friendlyLabelOf(labelIn ?? '', goal);

    if (!wait) {
      const body = [
        `spawned sub-agent ${id.slice(0, 8)} — ${friendlyLabel}`,
        `(queued; parent chain depth=${nextDepth}/${MAX_DEPTH})`,
        `Poll with subagent_status id:"${id}" or block with subagent_wait id:"${id}".`,
      ].join('\n');
      return {
        ok: true,
        content: body,
        data: { id, depth: nextDepth, wait: false },
        latency_ms: Date.now() - started,
      };
    }

    const { timedOut, run } = await pollUntilTerminal(id, timeoutSec * 1000, signal);
    if (signal.aborted) return abortedResult('spawn_subagent', started, 'after');

    if (!run) {
      return {
        ok: false,
        content: `sub-agent ${id.slice(0, 8)} disappeared from the store`,
        latency_ms: Date.now() - started,
      };
    }

    if (timedOut) {
      return {
        ok: false,
        content:
          `sub-agent ${id.slice(0, 8)} still ${run.status} after ${timeoutSec}s timeout. ` +
          `Keep polling with subagent_status id:"${id}", wait longer with subagent_wait, ` +
          `or cancel with subagent_abort.`,
        data: { id, status: run.status, timedOut: true },
        latency_ms: Date.now() - started,
      };
    }

    const ok = run.status === 'done';
    return {
      ok,
      content:
        `sub-agent ${id.slice(0, 8)} finished with status=${run.status}\n` +
        `final: ${truncate(run.finalAnswer, 2000)}`,
      data: {
        id,
        status: run.status,
        finalAnswer: run.finalAnswer,
        steps: run.steps.length,
      },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// spawn_parallel — one-call fan-out. The big ergonomic win: the agent can
// spin up ten helpers and collect ten results in a single tool round-trip
// instead of eleven (one spawn × 10 + one wait_all).
// ---------------------------------------------------------------------------

export const spawnParallelTool: Tool = {
  schema: {
    name: 'spawn_parallel',
    description:
      'Spawn many sub-agents at once with independent goals, optionally block on all of them, and return per-child results. This is the preferred fan-out primitive: one tool call replaces N spawn_subagent + N subagent_wait calls. When `wait` is true (default), the tool returns after every child terminates or `timeout_sec` elapses — partial results are included for timed-out children so you can still make progress. Respects the concurrency cap and the MAX_DEPTH=3 recursion cap.',
    input_schema: {
      type: 'object',
      properties: {
        goals: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Array of 1-12 plain-English goals, one per sub-agent. Each must be self-contained (>=8 chars).',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional parallel array of short labels for the ACTIVITY rows. Must have the same length as `goals` if provided.',
        },
        wait: {
          type: 'boolean',
          description:
            'Block until every child terminates or `timeout_sec` elapses. Default true — that is the point of this tool. Set to false to fire-and-forget all N children at once and get just the ids back.',
        },
        timeout_sec: {
          type: 'integer',
          minimum: 10,
          maximum: 1800,
          description:
            'Max seconds to block when `wait` is true (default 600, max 1800). Applied across the whole fan-out, not per child.',
        },
      },
      required: ['goals'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['goals', 'labels', 'wait', 'timeout_sec']);
    if (unknown) return validationFailure(started, unknown.message);

    const goalsIn = requireStringArray(input, 'goals');
    if (isParseError(goalsIn)) return validationFailure(started, goalsIn.message);
    if (goalsIn.length > 12) {
      return validationFailure(
        started,
        `"goals" has ${goalsIn.length} entries; max 12 per call — break the batch up`,
      );
    }
    for (const g of goalsIn) {
      if (g.trim().length < 8) {
        return validationFailure(
          started,
          'every goal must be at least 8 characters — give each sub-agent something substantive to do',
        );
      }
    }

    const labelsIn = optionalStringArray(input, 'labels');
    if (isParseError(labelsIn)) return validationFailure(started, labelsIn.message);
    if (labelsIn && labelsIn.length !== goalsIn.length) {
      return validationFailure(
        started,
        `"labels" length ${labelsIn.length} must equal "goals" length ${goalsIn.length}`,
      );
    }

    const waitRaw = input['wait'];
    const wait = typeof waitRaw === 'boolean' ? waitRaw : true;

    const timeoutIn = optionalNumber(input, 'timeout_sec');
    if (isParseError(timeoutIn)) return validationFailure(started, timeoutIn.message);
    const timeoutSec = Math.min(1800, Math.max(10, Math.trunc(timeoutIn ?? 600)));

    const parent = readParent(signal);
    if (!parent) {
      return {
        ok: false,
        content: 'spawn_parallel called outside a runAgent context',
        latency_ms: Date.now() - started,
      };
    }
    if (parent.depth >= MAX_DEPTH) {
      return {
        ok: false,
        content:
          `spawn_parallel refused: delegation depth ${parent.depth} >= max ${MAX_DEPTH}. ` +
          `Do the N items yourself at this level instead of another nested fan-out.`,
        latency_ms: Date.now() - started,
      };
    }

    if (signal.aborted) return abortedResult('spawn_parallel', started, 'before');

    // Spawn all N in a synchronous burst so the worker sees them as a batch.
    const nextDepth = parent.depth + 1;
    const ids: string[] = [];
    for (let i = 0; i < goalsIn.length; i += 1) {
      const id = spawnChild(parent, goalsIn[i], nextDepth);
      ids.push(id);
    }

    if (!wait) {
      const lines = ids.map(
        (id, i) =>
          `  ${i + 1}. ${id.slice(0, 8)} — ${friendlyLabelOf(labelsIn?.[i] ?? '', goalsIn[i])}`,
      );
      return {
        ok: true,
        content: `spawned ${ids.length} sub-agents (queued; depth=${nextDepth}/${MAX_DEPTH}):\n${lines.join('\n')}\nCollect results with subagent_wait_all ids:<the array above>.`,
        data: { ids, depth: nextDepth, wait: false },
        latency_ms: Date.now() - started,
      };
    }

    const results = await waitAllTerminal(ids, timeoutSec * 1000, signal);
    if (signal.aborted) return abortedResult('spawn_parallel', started, 'after');

    let doneCount = 0;
    let errorCount = 0;
    let timedOutCount = 0;
    const body: string[] = [];
    const data: Array<{
      id: string;
      status: SubAgentStatus | null;
      finalAnswer: string | null;
      steps: number;
      timedOut: boolean;
      label?: string;
    }> = [];

    for (let i = 0; i < results.length; i += 1) {
      const { id, run, timedOut } = results[i];
      const label = friendlyLabelOf(labelsIn?.[i] ?? '', goalsIn[i]);
      if (timedOut) timedOutCount += 1;
      if (run?.status === 'done') doneCount += 1;
      if (run?.status === 'error' || run?.status === 'max_steps') errorCount += 1;

      data.push({
        id,
        status: run?.status ?? null,
        finalAnswer: run && isTerminal(run.status) ? run.finalAnswer : null,
        steps: run?.steps.length ?? 0,
        timedOut,
        label,
      });

      const header = `[${i + 1}/${results.length}] ${id.slice(0, 8)} · ${label} · ${timedOut ? 'TIMEOUT (' : ''}${run?.status ?? 'vanished'}${timedOut ? ')' : ''}`;
      const answer =
        run && isTerminal(run.status)
          ? truncate(run.finalAnswer, 1400)
          : run
            ? `(still ${run.status} after ${timeoutSec}s — ${run.steps.length} steps)`
            : '(run vanished from store)';
      body.push(`${header}\n${answer}`);
    }

    const header =
      `spawn_parallel: ${ids.length} spawned · ${doneCount} done · ${errorCount} error · ${timedOutCount} timed out`;
    return {
      ok: errorCount === 0 && timedOutCount === 0,
      content: truncate([header, '', ...body].join('\n\n')),
      data: { ids, results: data, doneCount, errorCount, timedOutCount },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// subagent_status — cheap read of a single run's state
// ---------------------------------------------------------------------------

export const subagentStatusTool: Tool = {
  schema: {
    name: 'subagent_status',
    description:
      'Inspect a spawned sub-agent by id. Returns status, step count, last-step preview, and (when terminal) the final answer. Cheap — no polling; reads from the in-memory store.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sub-agent run id returned by spawn_subagent.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('subagent_status', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id']);
    if (unknown) return validationFailure(started, unknown.message);

    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);

    const run = findRun(id);
    if (!run) {
      return {
        ok: false,
        content: `no sub-agent with id starting ${id.slice(0, 8)} — already cleared?`,
        latency_ms: Date.now() - started,
      };
    }

    return {
      ok: true,
      content: summariseRun(run),
      data: {
        id: run.id,
        status: run.status,
        steps: run.steps.length,
        finalAnswer: isTerminal(run.status) ? run.finalAnswer : null,
        parent: run.parent,
      },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// subagent_wait — block until a run terminates (or timeout)
// ---------------------------------------------------------------------------

export const subagentWaitTool: Tool = {
  schema: {
    name: 'subagent_wait',
    description:
      'Block until ONE sub-agent reaches a terminal state (done/error/aborted/max_steps) or `timeout_sec` elapses. For many ids use subagent_wait_all — one call is much cheaper than looping.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sub-agent run id.' },
        timeout_sec: {
          type: 'integer',
          minimum: 5,
          maximum: 1800,
          description: 'Max seconds to block before returning a timeout result (default 120).',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id', 'timeout_sec']);
    if (unknown) return validationFailure(started, unknown.message);

    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);

    const timeoutIn = optionalNumber(input, 'timeout_sec');
    if (isParseError(timeoutIn)) return validationFailure(started, timeoutIn.message);
    const timeoutSec = Math.min(1800, Math.max(5, Math.trunc(timeoutIn ?? 120)));

    if (signal.aborted) return abortedResult('subagent_wait', started, 'before');
    const existing = findRun(id);
    if (!existing) {
      return {
        ok: false,
        content: `no sub-agent with id starting ${id.slice(0, 8)}`,
        latency_ms: Date.now() - started,
      };
    }
    if (isTerminal(existing.status)) {
      return {
        ok: existing.status === 'done',
        content: summariseRun(existing),
        data: {
          id: existing.id,
          status: existing.status,
          finalAnswer: existing.finalAnswer,
          steps: existing.steps.length,
        },
        latency_ms: Date.now() - started,
      };
    }

    const { timedOut, run } = await pollUntilTerminal(id, timeoutSec * 1000, signal);
    if (signal.aborted) return abortedResult('subagent_wait', started, 'after');
    if (!run) {
      return {
        ok: false,
        content: `sub-agent ${id.slice(0, 8)} vanished from the store`,
        latency_ms: Date.now() - started,
      };
    }
    if (timedOut) {
      return {
        ok: false,
        content:
          `sub-agent ${id.slice(0, 8)} still ${run.status} after ${timeoutSec}s. ` +
          `It's still making progress — call subagent_wait again or let it finish in the background.`,
        data: { id, status: run.status, timedOut: true },
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: run.status === 'done',
      content: summariseRun(run),
      data: {
        id: run.id,
        status: run.status,
        finalAnswer: run.finalAnswer,
        steps: run.steps.length,
      },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// subagent_wait_all — block until a whole fleet terminates (or timeout)
// ---------------------------------------------------------------------------

export const subagentWaitAllTool: Tool = {
  schema: {
    name: 'subagent_wait_all',
    description:
      'Block until every sub-agent in `ids` reaches a terminal state or `timeout_sec` elapses. Returns per-child status + final answer in the SAME order as the input ids. Timed-out children are included with `timedOut: true` so the parent can still make progress on the ones that finished.',
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Sub-agent run ids to wait on (1-16).',
        },
        timeout_sec: {
          type: 'integer',
          minimum: 10,
          maximum: 1800,
          description: 'Total seconds to block across the whole fleet (default 300).',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['ids', 'timeout_sec']);
    if (unknown) return validationFailure(started, unknown.message);

    const ids = requireStringArray(input, 'ids');
    if (isParseError(ids)) return validationFailure(started, ids.message);
    if (ids.length > 16) {
      return validationFailure(
        started,
        `"ids" has ${ids.length} entries; max 16 per call`,
      );
    }

    const timeoutIn = optionalNumber(input, 'timeout_sec');
    if (isParseError(timeoutIn)) return validationFailure(started, timeoutIn.message);
    const timeoutSec = Math.min(1800, Math.max(10, Math.trunc(timeoutIn ?? 300)));

    if (signal.aborted) return abortedResult('subagent_wait_all', started, 'before');
    const results = await waitAllTerminal(ids, timeoutSec * 1000, signal);
    if (signal.aborted) return abortedResult('subagent_wait_all', started, 'after');

    let doneCount = 0;
    let errorCount = 0;
    let timedOutCount = 0;
    const body: string[] = [];
    const data: Array<{
      id: string;
      status: SubAgentStatus | null;
      finalAnswer: string | null;
      steps: number;
      timedOut: boolean;
    }> = [];

    for (let i = 0; i < results.length; i += 1) {
      const { id, run, timedOut } = results[i];
      if (timedOut) timedOutCount += 1;
      if (run?.status === 'done') doneCount += 1;
      if (run?.status === 'error' || run?.status === 'max_steps') errorCount += 1;
      data.push({
        id,
        status: run?.status ?? null,
        finalAnswer: run && isTerminal(run.status) ? run.finalAnswer : null,
        steps: run?.steps.length ?? 0,
        timedOut,
      });
      const header = `[${i + 1}/${results.length}] ${id.slice(0, 8)} · ${timedOut ? 'TIMEOUT (' : ''}${run?.status ?? 'vanished'}${timedOut ? ')' : ''}`;
      const answer =
        run && isTerminal(run.status)
          ? truncate(run.finalAnswer, 1400)
          : run
            ? `(still ${run.status} after ${timeoutSec}s — ${run.steps.length} steps)`
            : '(run vanished from store)';
      body.push(`${header}\n${answer}`);
    }

    return {
      ok: errorCount === 0 && timedOutCount === 0,
      content: truncate(
        `${ids.length} waited · ${doneCount} done · ${errorCount} error · ${timedOutCount} timed out\n\n${body.join('\n\n')}`,
      ),
      data: { results: data, doneCount, errorCount, timedOutCount },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// subagent_abort — cancel a running sub-agent
// ---------------------------------------------------------------------------

export const subagentAbortTool: Tool = {
  schema: {
    name: 'subagent_abort',
    description:
      'Cancel a queued or running sub-agent. Terminal runs are left untouched. The run flips to status=aborted; its AbortController fires so any in-flight tool call unwinds cleanly.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sub-agent run id.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('subagent_abort', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id']);
    if (unknown) return validationFailure(started, unknown.message);

    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);

    const run = findRun(id);
    if (!run) {
      return {
        ok: false,
        content: `no sub-agent with id starting ${id.slice(0, 8)}`,
        latency_ms: Date.now() - started,
      };
    }
    if (isTerminal(run.status)) {
      return {
        ok: true,
        content: `sub-agent ${id.slice(0, 8)} already ${run.status} — nothing to abort`,
        data: { id, status: run.status, aborted: false },
        latency_ms: Date.now() - started,
      };
    }

    useSubAgents.getState().abort(id);
    return {
      ok: true,
      content: `aborted sub-agent ${id.slice(0, 8)} (was ${run.status})`,
      data: { id, status: 'aborted', aborted: true },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// subagent_list — see the fleet I've spawned
// ---------------------------------------------------------------------------

export const subagentListTool: Tool = {
  schema: {
    name: 'subagent_list',
    description:
      'List recent sub-agents from the shared store, newest first. Optional `status` filter restricts to one status. Use this to get an overview of your fleet before waiting on individual runs.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum rows to return (default 20).',
        },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'done', 'aborted', 'error', 'max_steps'],
          description: 'Restrict to runs in a given terminal/active status.',
        },
        parent: {
          type: 'string',
          description:
            'Restrict to runs whose parent label starts with this prefix (e.g. "agent" or "daemon:abc").',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('subagent_list', started, 'before');

    let limit = 20;
    let status: SubAgentStatus | undefined;
    let parent: string | undefined;

    if (input !== undefined && input !== null) {
      if (!isRecord(input)) return validationFailure(started, 'expected an object');
      const unknown = rejectUnknown(input, ['limit', 'status', 'parent']);
      if (unknown) return validationFailure(started, unknown.message);
      const limitIn = optionalNumber(input, 'limit');
      if (isParseError(limitIn)) return validationFailure(started, limitIn.message);
      if (limitIn !== undefined) {
        limit = Math.min(100, Math.max(1, Math.trunc(limitIn)));
      }
      const statusIn = optionalString(input, 'status');
      if (isParseError(statusIn)) return validationFailure(started, statusIn.message);
      if (statusIn !== undefined) status = statusIn as SubAgentStatus;
      const parentIn = optionalString(input, 'parent');
      if (isParseError(parentIn)) return validationFailure(started, parentIn.message);
      if (parentIn !== undefined) parent = parentIn;
    }

    let runs = [...useSubAgents.getState().runs].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    if (status) runs = runs.filter(r => r.status === status);
    if (parent) runs = runs.filter(r => (r.parent ?? '').startsWith(parent!));
    runs = runs.slice(0, limit);

    if (runs.length === 0) {
      return {
        ok: true,
        content: 'no sub-agents match your filter',
        data: { count: 0, runs: [] },
        latency_ms: Date.now() - started,
      };
    }

    const lines = runs.map(r => {
      const age = Math.round((Date.now() - r.createdAt) / 1000);
      return `[${r.id.slice(0, 8)}] ${r.status.padEnd(9)} steps=${r.steps.length.toString().padStart(2)} age=${age}s — ${truncate(r.goal, 100)}`;
    });
    return {
      ok: true,
      content: truncate(
        `${runs.length} sub-agent${runs.length === 1 ? '' : 's'}${status ? ` (status=${status})` : ''}${parent ? ` (parent=${parent}…)` : ''}\n${lines.join('\n')}`,
      ),
      data: {
        count: runs.length,
        runs: runs.map(r => ({
          id: r.id,
          status: r.status,
          steps: r.steps.length,
          parent: r.parent,
          createdAt: r.createdAt,
          endedAt: r.endedAt,
        })),
      },
      latency_ms: Date.now() - started,
    };
  },
};
