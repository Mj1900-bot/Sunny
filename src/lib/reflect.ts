/**
 * Reflection pass — metacognitive writeback after every agent run.
 *
 * SUNNY's cognitive loop has four phases:
 *
 *   perception → memory → action (agent loop) → REFLECTION ──┐
 *       ▲                                                    │
 *       └────────────────────────────────────────────────────┘
 *
 * Reflection is the feedback edge. When a run completes (done / error /
 * max_steps — not aborted), this module ships the (goal, steps, answer)
 * tuple to a cheap LLM with a structured-extraction prompt. The result is:
 *
 *   • A concise one-line outcome — always written as an episodic row
 *     (kind='reflection') so the consolidator can audit decisions.
 *   • An optional durable "lesson" — written DIRECTLY to the semantic
 *     table (source='reflection') so the next run's context pack can
 *     retrieve it goal-matched. Bypasses the 15-min consolidator tick
 *     because a lesson worth remembering shouldn't wait an hour.
 *   • `wasted_tool_indices` — which steps produced no useful signal.
 *     Surfaced in run history; feeds future A/B of tool-selection prompts.
 *   • A followup suggestion — the agent may propose "next time you ask X,
 *     consider Y" so the UI can offer it on the next related run.
 *
 * Design constraints:
 *   • Fire-and-forget from the caller's perspective — reflection latency
 *     must never block the user-visible answer.
 *   • Degrades silently. No LLM available → no reflection, no error.
 *   • Minimum-run guard — single-step runs and tiny goals aren't worth a
 *     reflection round-trip.
 *   • Uses the same `chat` IPC that runAgent does, so provider routing
 *     (OpenClaw / Ollama / Anthropic) is already correct.
 */

import { invokeSafe, isTauri } from './tauri';
import type { AgentStep } from './agentLoop';
import { pushInsight } from '../store/insights';
import { chatFor } from './modelRouter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReflectionStatus = 'done' | 'error' | 'max_steps';

export type RunReflection = {
  readonly goal: string;
  readonly status: ReflectionStatus;
  readonly success: boolean;
  readonly outcome: string;
  readonly lesson: string | null;
  readonly wasted_tool_indices: ReadonlyArray<number>;
  readonly followup: string | null;
  readonly analyzed_at: number;
};

export type ReflectOptions = {
  readonly goal: string;
  readonly steps: ReadonlyArray<AgentStep>;
  readonly finalAnswer: string;
  readonly status: ReflectionStatus;
  /** Optional override for tests / dry runs. Defaults to the user's config. */
  readonly provider?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Guards — skip reflection when it's definitely not worth a model call.
// ---------------------------------------------------------------------------

const MIN_GOAL_LENGTH = 8;
const MIN_STEP_COUNT = 2;
const MIN_ANSWER_LENGTH = 10;

function shouldSkip(opts: ReflectOptions): string | null {
  const goal = opts.goal.trim();
  if (goal.length < MIN_GOAL_LENGTH) return 'goal too short';
  if (opts.steps.length < MIN_STEP_COUNT && opts.status === 'done') {
    // Single-step answers are usually "hi" / "what's the time" and don't
    // reward a reflection pass. We still reflect on short runs that
    // errored or hit max_steps — those are exactly the cases a lesson
    // might save the next run.
    return 'run too short';
  }
  if (opts.finalAnswer.trim().length < MIN_ANSWER_LENGTH && opts.status === 'done') {
    return 'answer too short';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings — mirror the key view.ts persists to.
// ---------------------------------------------------------------------------

type PersistedSettings = {
  readonly provider?: string;
  readonly model?: string;
  /** Explicit opt-out. Defaults to enabled; user can disable in Settings. */
  readonly reflectionsEnabled?: boolean;
};

function readSettings(): PersistedSettings {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem('sunny.settings.v1');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      reflectionsEnabled:
        typeof parsed.reflectionsEnabled === 'boolean' ? parsed.reflectionsEnabled : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run a reflection pass and persist results. Returns the parsed reflection
 * for testing / UI display, or `null` when skipped. Never throws — every
 * failure path logs at debug and returns null.
 *
 * Callers typically `void reflectOnRun(...)` without awaiting; the user's
 * answer is already on screen and this just writes to memory in the
 * background.
 */
export async function reflectOnRun(opts: ReflectOptions): Promise<RunReflection | null> {
  if (!isTauri) return null;
  const settings = readSettings();
  if (settings.reflectionsEnabled === false) return null;

  const skipReason = shouldSkip(opts);
  if (skipReason) {
    // Debug-only — don't flood the console on simple "hi" runs.
    return null;
  }

  const prompt = buildReflectionPrompt(opts);
  // Route reflection to the cheap model — this is a structured JSON
  // extraction, not user-facing reasoning. Override kept available for
  // tests via opts.{provider,model}.
  const routeOverride =
    opts.provider && opts.model ? { provider: opts.provider, model: opts.model } : undefined;
  const raw = await chatFor('reflection', prompt, { routeOverride });
  if (!raw) return null;

  const parsed = parseReflection(raw);
  if (!parsed) {
    // The model returned prose or malformed JSON. Still record a bare
    // episodic row so the run history is complete — just skip the lesson.
    await writeEpisodicAuditOnly(opts);
    return null;
  }

  const full: RunReflection = {
    goal: opts.goal,
    status: opts.status,
    success: parsed.success,
    outcome: parsed.outcome,
    lesson: parsed.lesson,
    wasted_tool_indices: parsed.wasted_tool_indices,
    followup: parsed.followup,
    analyzed_at: Date.now(),
  };

  await writeReflection(full, opts);
  return full;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

// Cap per-step text so one verbose tool output can't dominate the context
// window. Reflection prompts need to be terse — we're paying for a model
// call per run and the value is in the lesson, not the verbatim trace.
const STEP_TEXT_CAP = 240;
const TOTAL_STEPS_CAP = 3_000;

function summariseSteps(steps: ReadonlyArray<AgentStep>): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const line = formatStep(i, s);
    total += line.length;
    if (total > TOTAL_STEPS_CAP) {
      lines.push(`  … (${steps.length - i} more steps truncated)`);
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function formatStep(index: number, step: AgentStep): string {
  const ix = String(index).padStart(2, '0');
  switch (step.kind) {
    case 'tool_call': {
      const input = step.toolInput !== undefined ? JSON.stringify(step.toolInput) : '{}';
      const clipped = input.length > 120 ? `${input.slice(0, 117)}…` : input;
      return `  ${ix}. tool_call ${step.toolName ?? '?'} ${clipped}`;
    }
    case 'tool_result': {
      const ok = step.toolOutput?.ok ? 'ok' : 'err';
      const content = step.toolOutput?.content ?? '';
      const clipped = content.length > STEP_TEXT_CAP ? `${content.slice(0, STEP_TEXT_CAP - 1)}…` : content;
      return `  ${ix}. tool_result ${step.toolName ?? '?'} [${ok}] ${clipped}`;
    }
    case 'message':
    case 'plan':
      return `  ${ix}. ${step.kind} ${truncate(step.text, STEP_TEXT_CAP)}`;
    case 'error':
      return `  ${ix}. error ${truncate(step.text, STEP_TEXT_CAP)}`;
  }
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1)}…`;
}

function buildReflectionPrompt(opts: ReflectOptions): string {
  const statusLine =
    opts.status === 'done'
      ? 'The run reached a final answer.'
      : opts.status === 'max_steps'
        ? 'The run hit the step budget WITHOUT a final answer.'
        : 'The run errored and could not produce a final answer.';

  return [
    "You are SUNNY's metacognitive critic. You read a just-finished agent",
    'run and extract useful insight. Your output trains the next run, so',
    'be precise and honest.',
    '',
    statusLine,
    '',
    `USER GOAL: ${opts.goal}`,
    '',
    'STEPS:',
    summariseSteps(opts.steps),
    '',
    `FINAL ANSWER: ${truncate(opts.finalAnswer, 1200)}`,
    '',
    'OUTPUT FORMAT — a single JSON object, NOTHING else:',
    '{',
    '  "success": <boolean — true only if the goal was meaningfully achieved>,',
    '  "outcome": "<one concise sentence describing what actually happened>",',
    '  "lesson":  "<one durable insight worth remembering across future runs,',
    '              OR null if nothing generalisable>",',
    '  "wasted_tool_indices": [<0-based indices of steps that produced no',
    '              useful information for the final answer>],',
    '  "followup": "<concrete next-action the user might want, OR null>"',
    '}',
    '',
    'Rules:',
    '- Emit JSON only. No markdown, no commentary, no fences.',
    '- Be honest: if the run failed, do not sugar-coat. Failure is data.',
    '- Lesson must be durable. Transient facts ("the file had 3 lines")',
    '  are NOT lessons. User preferences, reliable approaches, dead-end',
    '  patterns ARE lessons. If nothing qualifies, return null.',
    '- Lessons should be phrased as imperatives or preferences, starting',
    '  with a verb or "Sunny prefers / tends to / wants …".',
    '',
    'JSON:',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing — handles code-fenced replies + prose-wrapped JSON.
// ---------------------------------------------------------------------------

type ParsedReflection = {
  readonly success: boolean;
  readonly outcome: string;
  readonly lesson: string | null;
  readonly wasted_tool_indices: ReadonlyArray<number>;
  readonly followup: string | null;
};

function parseReflection(raw: string): ParsedReflection | null {
  const trimmed = raw.trim();
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const direct = safeParseReflection(fenceStripped);
  if (direct) return direct;

  const salvaged = extractLargestObject(fenceStripped);
  if (salvaged) {
    const retry = safeParseReflection(salvaged);
    if (retry) return retry;
  }
  return null;
}

function safeParseReflection(raw: string): ParsedReflection | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;

    const outcome = typeof rec.outcome === 'string' ? rec.outcome.trim() : '';
    if (!outcome) return null;

    const success = typeof rec.success === 'boolean' ? rec.success : false;

    const lessonRaw = rec.lesson;
    const lesson =
      typeof lessonRaw === 'string' && lessonRaw.trim().length > 0 ? lessonRaw.trim() : null;

    const followupRaw = rec.followup;
    const followup =
      typeof followupRaw === 'string' && followupRaw.trim().length > 0
        ? followupRaw.trim()
        : null;

    const indices = Array.isArray(rec.wasted_tool_indices)
      ? rec.wasted_tool_indices.filter(
          (n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0,
        )
      : [];

    return { success, outcome, lesson, wasted_tool_indices: indices, followup };
  } catch {
    return null;
  }
}

function extractLargestObject(raw: string): string | null {
  let best: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < raw.length; j += 1) {
      const ch = raw[j];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = raw.slice(i, j + 1);
          if (!best || candidate.length > best.length) best = candidate;
          break;
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Write path — episodic audit row (always) + semantic lesson (conditional).
// ---------------------------------------------------------------------------

async function writeReflection(r: RunReflection, opts: ReflectOptions): Promise<void> {
  // Compact the reflection into a single human-readable line that FTS can
  // index well. The full structured payload rides along in `meta` for
  // later drill-down without re-parsing the text.
  const auditText = [
    `goal: ${opts.goal}`,
    `outcome: ${r.outcome}`,
    `success: ${r.success}`,
    r.lesson ? `lesson: ${r.lesson}` : null,
    r.followup ? `followup: ${r.followup}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const tags = ['reflection', r.status, r.success ? 'success' : 'failure'];
  if (r.lesson) tags.push('has-lesson');

  await invokeSafe('memory_episodic_add', {
    kind: 'reflection',
    text: auditText,
    tags,
    meta: {
      status: r.status,
      success: r.success,
      wasted_tool_indices: r.wasted_tool_indices,
      followup: r.followup,
      step_count: opts.steps.length,
      analyzed_at: r.analyzed_at,
    },
  });

  // Durable lessons get promoted straight into semantic memory so the next
  // run's context pack can retrieve them goal-matched. We do NOT wait for
  // the 15-min consolidator — a lesson is too valuable to delay.
  if (r.lesson) {
    const stored = await invokeSafe('memory_fact_add', {
      subject: subjectFromLesson(r.lesson),
      text: r.lesson,
      tags: ['lesson', 'reflection', r.status, ...(r.success ? ['success'] : ['failure'])],
      // Lessons from failed runs get lower confidence — they may reflect a
      // single bad model turn rather than a real pattern. The idempotent
      // upsert in semantic.add will bump confidence when the same lesson
      // gets re-asserted on future runs, so durable patterns rise.
      confidence: r.success ? 0.75 : 0.55,
      source: 'reflection',
    });
    if (stored !== null) {
      pushInsight(
        'memory_lesson',
        'Learned a lesson',
        r.lesson.length > 120 ? `${r.lesson.slice(0, 117)}…` : r.lesson,
        { goal: opts.goal, status: r.status, success: r.success },
      );
    }
  }
}

/**
 * Write ONLY the audit row (no semantic lesson). Used when the model reply
 * couldn't be parsed — we still want the run history to be complete.
 */
async function writeEpisodicAuditOnly(opts: ReflectOptions): Promise<void> {
  const tags = ['reflection', opts.status, 'unparseable'];
  await invokeSafe('memory_episodic_add', {
    kind: 'reflection',
    text: `goal: ${opts.goal}\noutcome: reflection model reply could not be parsed`,
    tags,
    meta: {
      status: opts.status,
      step_count: opts.steps.length,
      analyzed_at: Date.now(),
    },
  });
}

/**
 * Derive an ontology-ish subject key from a lesson sentence. Best-effort —
 * lessons the model phrased like "Sunny prefers X" land under
 * `user.preference`, "When …, do Y" lands under `pattern`, anything else
 * stays subject-less (which is fine — FTS + embedding retrieval still find
 * them by text).
 */
function subjectFromLesson(lesson: string): string {
  const low = lesson.toLowerCase().trimStart();
  if (low.startsWith('sunny prefers') || low.startsWith('sunny tends to')) {
    return 'user.preference';
  }
  if (low.startsWith('sunny wants') || low.startsWith("sunny doesn't want")) {
    return 'user.preference';
  }
  if (low.startsWith('when ') || low.startsWith('if ')) return 'pattern';
  if (low.startsWith('always ') || low.startsWith('never ')) return 'pattern';
  if (low.startsWith('avoid ') || low.startsWith('prefer ')) return 'pattern';
  return '';
}

// ---------------------------------------------------------------------------
// Test-only exports — the prompt builder and parser are pure and worth
// unit-testing. We re-export through a `__internal` namespace so consumers
// can't accidentally depend on them.
// ---------------------------------------------------------------------------

export const __internal = {
  buildReflectionPrompt,
  parseReflection,
  summariseSteps,
  subjectFromLesson,
  shouldSkip,
};
