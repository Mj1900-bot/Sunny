/**
 * System-1 skill executor.
 *
 * When `MemoryPack.matched_skills[0].score` clears a threshold, we bypass
 * the LLM planning loop entirely and run the skill's deterministic tool
 * sequence. This is the payoff for all the memory/embedding infrastructure:
 * repeated goals become ~instant.
 *
 *   Goal arrives
 *      │
 *      ▼
 *   context pack → matched_skills[0] { skill, score }
 *      │
 *      ▼
 *   score ≥ EXECUTE_THRESHOLD (0.85)  &&  skill.recipe present  ?
 *      │                                      │
 *      │no                                    │yes
 *      ▼                                      ▼
 *   LLM loop (System-2)               runSkill(skill, goal)
 *                                              │
 *                                              ├─ success → bump_use, return
 *                                              │
 *                                              └─ failure → fall back to System-2
 *
 * A skill recipe is a small JSON program:
 *
 *   {
 *     "steps": [
 *       { "kind": "tool", "tool": "<name>", "input": {…}, "saveAs": "events" },
 *       { "kind": "tool", "tool": "<name>", "input": {…} },
 *       { "kind": "answer", "text": "Your day: {{events}}" }
 *     ]
 *   }
 *
 * Template substitution:
 *   • `{{$goal}}`             → the user's original goal text
 *   • `{{$now}}`              → ISO-8601 local time
 *   • `{{$in_1h}}` `{{$in_24h}}` `{{$in_7d}}` → offsets from now
 *   • `{{$today_start}}` `{{$today_end}}` → boundaries of local calendar day
 *   • `{{<saveAs>}}`          → the `content` string of a previous tool result
 *   • `{{<saveAs>.ok}}`       → boolean success flag of a previous tool result
 *
 * Substitution walks strings recursively inside the input object, so
 * nested paths like `{ "req": { "message": "{{$goal}}" } }` work.
 */

import { invokeSafe } from './tauri';
import { runTool, TOOLS, type ToolResult } from './tools';
import type { AgentStep, AgentRunResult } from './agentLoop';
import type { ProceduralSkill } from './contextPack';
import { pushInsight } from '../store/insights';
import { gateToolCall } from './constitution';

// ---------------------------------------------------------------------------
// Validation + trust-class (sprint-9 δ)
//
// Two concerns, neither of which mutates a recipe:
//
//   1. validateRecipe — before we ever run it, confirm every `tool` step
//      still refers to a registered tool and that the input at least
//      satisfies the tool's input_schema shape (required keys present,
//      known primitive types match). This catches "the tool was renamed"
//      / "argument schema tightened" regressions that the executor would
//      otherwise only hit at run-time, after partial side effects.
//
//   2. computeTrustClass — derive a coarse reputation bucket from the
//      skill's own telemetry (uses_count + success_count). Used only as a
//      UX pill; the router still gates on the embedding score.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cosine similarity at which a matched skill is auto-executed. */
export const EXECUTE_THRESHOLD = 0.85;

/** Hard step cap — a recipe may not grow longer than this at runtime. */
const MAX_RECIPE_STEPS = 32;

// ---------------------------------------------------------------------------
// Capability scoping (sprint-10 δ / κ v9 #3)
//
// We warn ONCE per skill-id when it executes without a capability list so the
// console doesn't spam on hot System-1 paths. The set is module-scoped (per
// renderer session) — a new session will re-emit the warning, which is the
// right cadence: "each time this code starts, remind me which skills are
// still ungated".
// ---------------------------------------------------------------------------

const unscopedWarned = new Set<string>();

/** Test-only: lets the suite assert "warn fires exactly once" without
 *  polluting other tests that register the same skill id. Not exported from
 *  the package index. */
export function __resetUnscopedWarnings(): void {
  unscopedWarned.clear();
}

/**
 * Verify that a tool step is permitted by the recipe's capability allowlist.
 *
 *   • `capabilities === undefined`  → legacy "full access" recipe; allow
 *     and (once) warn the console about the unscoped default.
 *   • `capabilities.includes(tool)` → allow.
 *   • otherwise                     → deny.
 *
 * Returning a tagged union keeps the caller's branching obvious at the
 * dispatch site and avoids leaking the warning-bookkeeping out of here.
 */
export function checkCapability(
  skillName: string,
  skillId: string | undefined,
  capabilities: ReadonlyArray<string> | undefined,
  tool: string,
): { allowed: true; reason?: undefined } | { allowed: false; reason: string } {
  if (capabilities === undefined) {
    const key = skillId ?? skillName;
    if (!unscopedWarned.has(key)) {
      unscopedWarned.add(key);
      console.warn(
        `[skillExecutor] skill "${skillName}" has no capability list — full-access default (all registered tools callable).`,
      );
    }
    return { allowed: true };
  }
  if (capabilities.includes(tool)) return { allowed: true };
  return {
    allowed: false,
    reason: `capability_denied: tool "${tool}" is not in skill "${skillName}" capability list (${capabilities.length === 0 ? 'empty' : capabilities.join(', ')})`,
  };
}

// ---------------------------------------------------------------------------
// Recipe types (shape validated defensively at runtime)
// ---------------------------------------------------------------------------

export type ToolRecipeStep = {
  readonly kind: 'tool';
  readonly tool: string;
  readonly input: unknown;
  readonly saveAs?: string;
};

export type AnswerRecipeStep = {
  readonly kind: 'answer';
  readonly text: string;
};

export type RecipeStep = ToolRecipeStep | AnswerRecipeStep;

export type SkillRecipe = {
  readonly steps: ReadonlyArray<RecipeStep>;
  /**
   * Optional capability allowlist — names of tools this skill is permitted
   * to dispatch at run time (sprint-10 δ / κ v9 #3).
   *
   *   • present   → enforce: any `tool` step whose name is NOT in this list
   *                 is rejected at dispatch with a `capability_denied` error,
   *                 regardless of what the registry or constitution say.
   *   • absent    → legacy "full access" default: the skill may call any
   *                 registered tool (a one-shot per-session warn is emitted
   *                 so unscoped skills surface in the console).
   *
   * Auto-populated for new recipes by `skillSynthesis.compileCandidate`
   * (the allowlist equals the unique tool names in the recipe). Legacy
   * recipes synthesized before this field existed stay unscoped — we do
   * not retroactively infer because that would read as "tightened without
   * telling the user".
   */
  readonly capabilities?: ReadonlyArray<string>;
};

/**
 * Error kinds surfaced by the skill executor when a step is rejected
 * before or during dispatch. Exported for tests + future telemetry.
 */
export type SkillErrorKind =
  | 'unknown_tool'
  | 'capability_denied'
  | 'constitution_blocked'
  | 'user_declined'
  | 'tool_failed'
  | 'recipe_shape';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RunSkillOptions = {
  readonly goal: string;
  readonly skill: ProceduralSkill;
  readonly signal?: AbortSignal;
  readonly onStep?: (step: AgentStep) => void;
  readonly confirmDangerous?: (
    toolName: string,
    toolInput: unknown,
  ) => Promise<boolean> | boolean;
};

/**
 * Execute a skill recipe. Emits the same `AgentStep` shape as the LLM
 * loop so the UI renders skill runs identically to planned runs. Returns
 * `null` when the skill has no recipe (caller falls back to System-2).
 *
 * Never throws — every failure path produces an `AgentRunResult` with
 * `status: 'error'` so the caller can decide whether to retry via the LLM.
 */
export async function runSkill(opts: RunSkillOptions): Promise<AgentRunResult | null> {
  const { goal, skill, signal } = opts;

  const recipe = parseRecipe(skill.recipe);
  if (!recipe) return null;

  if (recipe.steps.length === 0) {
    return {
      steps: [],
      finalAnswer: 'Skill recipe was empty.',
      status: 'error',
    };
  }
  if (recipe.steps.length > MAX_RECIPE_STEPS) {
    return {
      steps: [],
      finalAnswer: `Skill recipe exceeds the ${MAX_RECIPE_STEPS}-step safety cap.`,
      status: 'error',
    };
  }

  const steps: AgentStep[] = [];
  const scope = initialScope(goal);

  // Emit a "plan" step up front so the run history clearly shows this
  // run went through System-1 and which skill handled it. This is what
  // lets the user spot "why did it answer so fast? — ah, morning-brief
  // fired."
  emit(opts, steps, {
    id: nextStepId(),
    kind: 'plan',
    text: `System-1: running skill "${skill.name}" (recipe has ${recipe.steps.length} step${recipe.steps.length === 1 ? '' : 's'})`,
    at: Date.now(),
  });

  // User-visible insight — shows a toast + logs to the SUNNY Knows feed.
  // This is the piece that makes "it just matched a learned skill" legible
  // rather than invisible.
  pushInsight(
    'skill_fired',
    `Used skill "${skill.name}"`,
    `${recipe.steps.length} step${recipe.steps.length === 1 ? '' : 's'}, bypassed LLM`,
    { skillId: skill.id, name: skill.name, stepCount: recipe.steps.length },
  );

  if (signal?.aborted) return aborted(steps);

  for (let i = 0; i < recipe.steps.length; i += 1) {
    if (signal?.aborted) return aborted(steps);
    const step = recipe.steps[i];

    if (step.kind === 'answer') {
      const final = resolveTemplate(step.text, scope);
      emit(opts, steps, {
        id: nextStepId(),
        kind: 'message',
        text: final,
        at: Date.now(),
      });
      return { steps, finalAnswer: final, status: 'done' };
    }

    // tool step
    const tool = TOOLS.get(step.tool);
    const substitutedInput = substituteDeep(step.input, scope);

    emit(opts, steps, {
      id: nextStepId(),
      kind: 'tool_call',
      text: `skill calling ${step.tool}`,
      toolName: step.tool,
      toolInput: substitutedInput,
      at: Date.now(),
    });

    if (!tool) {
      const errResult: ToolResult = {
        ok: false,
        content: `Unknown tool "${step.tool}" in skill "${skill.name}"`,
        latency_ms: 0,
      };
      emit(opts, steps, {
        id: nextStepId(),
        kind: 'tool_result',
        text: errResult.content,
        toolName: step.tool,
        toolInput: substitutedInput,
        toolOutput: errResult,
        at: Date.now(),
      });
      return {
        steps,
        finalAnswer: `Skill "${skill.name}" aborted: unknown tool "${step.tool}"`,
        status: 'error',
      };
    }

    // Capability check — sprint-10 δ / κ v9 #3. Runs before the
    // constitution gate so the denial reason is specific ("this skill
    // was never granted X") rather than a generic policy rejection. A
    // malicious or buggy recipe that tries to reach beyond its declared
    // surface is short-circuited here: dispatch never happens, no side
    // effects land, and the recipe aborts cleanly so the caller can
    // (optionally) fall back to System-2 with the LLM in the loop.
    const capCheck = checkCapability(
      skill.name,
      skill.id,
      recipe.capabilities,
      step.tool,
    );
    if (!capCheck.allowed) {
      const denied: ToolResult = {
        ok: false,
        content: capCheck.reason,
        latency_ms: 0,
      };
      emit(opts, steps, {
        id: nextStepId(),
        kind: 'tool_result',
        text: denied.content,
        toolName: step.tool,
        toolInput: substitutedInput,
        toolOutput: denied,
        at: Date.now(),
      });
      return {
        steps,
        finalAnswer: denied.content,
        status: 'aborted',
      };
    }

    // Constitution gate applies to System-1 skills too — a compiled
    // recipe doesn't get a pass. If a prohibition fires we abort the
    // whole recipe (not just this step): subsequent steps may template
    // against the failed output and produce garbage, and "partially run
    // a banned recipe" is worse UX than "run nothing".
    const gate = await gateToolCall(step.tool, substitutedInput);
    if (!gate.allowed) {
      const blocked: ToolResult = {
        ok: false,
        content: `Constitution blocked "${step.tool}": ${gate.reason ?? 'policy'}`,
        latency_ms: 0,
      };
      emit(opts, steps, {
        id: nextStepId(),
        kind: 'tool_result',
        text: blocked.content,
        toolName: step.tool,
        toolInput: substitutedInput,
        toolOutput: blocked,
        at: Date.now(),
      });
      return {
        steps,
        finalAnswer: blocked.content,
        status: 'aborted',
      };
    }

    if (tool.dangerous && opts.confirmDangerous) {
      const allowed = await Promise.resolve(
        opts.confirmDangerous(step.tool, substitutedInput),
      );
      if (!allowed) {
        const declined: ToolResult = {
          ok: false,
          content: `User declined dangerous tool "${step.tool}" in skill`,
          latency_ms: 0,
        };
        emit(opts, steps, {
          id: nextStepId(),
          kind: 'tool_result',
          text: declined.content,
          toolName: step.tool,
          toolInput: substitutedInput,
          toolOutput: declined,
          at: Date.now(),
        });
        return {
          steps,
          finalAnswer: declined.content,
          status: 'aborted',
        };
      }
    }

    const toolSignal = linkSignal(signal);
    let result: ToolResult;
    try {
      result = await runTool(step.tool, substitutedInput, toolSignal.signal);
    } finally {
      toolSignal.dispose();
    }

    emit(opts, steps, {
      id: nextStepId(),
      kind: 'tool_result',
      text: result.content,
      toolName: step.tool,
      toolInput: substitutedInput,
      toolOutput: result,
      at: Date.now(),
    });

    // Stop the recipe on the first failing tool — the next step may
    // template its input against the failed output and produce garbage.
    if (!result.ok) {
      return {
        steps,
        finalAnswer: `Skill "${skill.name}" failed at step ${i + 1}: ${result.content}`,
        status: 'error',
      };
    }

    // Save result under the named slot for later templating.
    if (step.saveAs && step.saveAs.length > 0) {
      scope[step.saveAs] = result;
    }
  }

  // Ran all steps but the last one wasn't an `answer`. Use the last tool
  // result's content as the final answer — this is a common case ("run X,
  // show me the output").
  const last = steps[steps.length - 1];
  const fallback =
    last?.toolOutput?.content ??
    `Skill "${skill.name}" completed without producing a final answer.`;
  emit(opts, steps, {
    id: nextStepId(),
    kind: 'message',
    text: fallback,
    at: Date.now(),
  });
  return { steps, finalAnswer: fallback, status: 'done' };
}

/**
 * After a skill run, bump the use counter so most-used skills rank first
 * in `list_skills`. `success=true` also increments `success_count` — used
 * by the Procedural UI to show "17/20 ok" and (future) by the System-1
 * router to demote skills below a success-rate floor. Best-effort: a
 * failed IPC is logged but not propagated (the agent already returned).
 */
export async function recordSkillUse(skillId: string, success: boolean): Promise<void> {
  const r = await invokeSafe('memory_skill_bump_use', { id: skillId, success });
  if (r === null) {
    console.debug('[skillExecutor] bump_use failed');
  }
}

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

type Scope = Record<string, unknown>;

function initialScope(goal: string): Scope {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '');
  const plus = (mins: number): Date => new Date(now.getTime() + mins * 60_000);

  // Today in local time — helpful for calendar_list_events which wants
  // `YYYY-MM-DDTHH:MM:SS` naïve local.
  const local = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  return {
    $goal: goal,
    $now: iso(now),
    $now_local: local(now),
    $in_1h: iso(plus(60)),
    $in_24h: iso(plus(60 * 24)),
    $in_7d: iso(plus(60 * 24 * 7)),
    $today_start: local(dayStart),
    $today_end: local(dayEnd),
  };
}

// Single token extraction regex. Captures the reference between `{{` and
// `}}`, tolerates whitespace, and is non-greedy to support multiple tokens
// on one line. Not anchored — we'll re-run it on the remaining string.
const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function resolveTemplate(text: string, scope: Scope): string {
  // Reset lastIndex in case this regex instance is reused across calls
  // (it isn't here — TOKEN_RE is a new regex per `replace` call since we
  // use the global flag — but being explicit is cheap).
  return text.replace(TOKEN_RE, (_match, rawRef: string) => {
    const resolved = resolveReference(rawRef.trim(), scope);
    return resolved === undefined ? '' : renderValue(resolved);
  });
}

/**
 * Resolve a `name` or `name.field` reference against the scope. Understands:
 *   • `$goal`, `$now` etc.           → scope[ref]
 *   • `name`                         → scope[name] (if tool result, .content)
 *   • `name.content`                 → tool result content string
 *   • `name.ok`                      → tool result boolean
 *   • `name.data.field.nested`       → JSON path into tool result data
 */
function resolveReference(ref: string, scope: Scope): unknown {
  if (ref.length === 0) return undefined;

  const parts = ref.split('.');
  const root = parts[0];
  const base = scope[root];
  if (base === undefined) return undefined;

  // Bare reference: if it's a tool result, default to `.content`.
  if (parts.length === 1) {
    if (isToolResult(base)) return base.content;
    return base;
  }

  // Walk the dotted path.
  let cur: unknown = base;
  for (let i = 1; i < parts.length; i += 1) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

function isToolResult(v: unknown): v is ToolResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    'ok' in v &&
    'content' in v &&
    typeof (v as ToolResult).content === 'string'
  );
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Recursively substitute template tokens in any string values inside the
 * input tree. Objects / arrays / non-string primitives pass through. This
 * means `{ path: "{{$goal}}" }` and `{ paths: ["{{$goal}}"] }` both work.
 */
export function substituteDeep(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') return resolveTemplate(value, scope);
  if (Array.isArray(value)) return value.map(v => substituteDeep(v, scope));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, scope);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Recipe parsing (tolerant: malformed recipes return null, not throw)
// ---------------------------------------------------------------------------

function parseRecipe(raw: unknown): SkillRecipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const steps = obj.steps;
  if (!Array.isArray(steps)) return null;

  const validSteps: RecipeStep[] = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') return null;
    const rec = s as Record<string, unknown>;
    if (rec.kind === 'tool') {
      if (typeof rec.tool !== 'string' || rec.tool.length === 0) return null;
      const saveAs = typeof rec.saveAs === 'string' ? rec.saveAs : undefined;
      const input = rec.input === undefined ? {} : rec.input;
      validSteps.push({
        kind: 'tool',
        tool: rec.tool,
        input,
        saveAs,
      });
    } else if (rec.kind === 'answer') {
      if (typeof rec.text !== 'string') return null;
      validSteps.push({ kind: 'answer', text: rec.text });
    } else {
      return null;
    }
  }

  // Optional capabilities allowlist (sprint-10 δ / κ v9 #3).
  //   • Must be an array of non-empty strings if present.
  //   • Missing / wrong-shape → treated as "absent" (legacy full access).
  //     We deliberately do NOT return null for a malformed capabilities
  //     field: that would brick an existing-but-slightly-corrupt recipe
  //     rather than just leaving it ungated, which is worse UX.
  let capabilities: ReadonlyArray<string> | undefined;
  const rawCaps = obj.capabilities;
  if (Array.isArray(rawCaps)) {
    const names: string[] = [];
    let ok = true;
    for (const c of rawCaps) {
      if (typeof c !== 'string' || c.length === 0) { ok = false; break; }
      names.push(c);
    }
    if (ok) {
      // De-dupe (preserve first-seen order) so capability checks are O(n)
      // against the smallest possible list.
      const seen = new Set<string>();
      capabilities = names.filter(n => {
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });
    }
  }

  return capabilities === undefined
    ? { steps: validSteps }
    : { steps: validSteps, capabilities };
}

// ---------------------------------------------------------------------------
// Step emission helpers
// ---------------------------------------------------------------------------

let stepCounter = 0;
function nextStepId(): string {
  stepCounter += 1;
  return `sk_${Date.now().toString(36)}_${stepCounter}`;
}

function emit(opts: RunSkillOptions, steps: AgentStep[], step: AgentStep): void {
  steps.push(step);
  try {
    opts.onStep?.(step);
  } catch (err) {
    console.error('[skillExecutor] onStep listener threw:', err);
  }
}

function aborted(steps: AgentStep[]): AgentRunResult {
  return {
    steps,
    finalAnswer: 'Skill run aborted before completion.',
    status: 'aborted',
  };
}

// ---------------------------------------------------------------------------
// AbortSignal linking — same pattern as agentLoop.ts (independent because
// importing across agentLoop ↔ skillExecutor would be a cycle).
// ---------------------------------------------------------------------------

type LinkedSignal = {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
};

function linkSignal(parent: AbortSignal | undefined): LinkedSignal {
  const controller = new AbortController();
  if (!parent) return { signal: controller.signal, dispose: () => undefined };
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => parent.removeEventListener('abort', onAbort),
  };
}

// ---------------------------------------------------------------------------
// Recipe validation — static checks run BEFORE a recipe is ever dispatched.
// ---------------------------------------------------------------------------

export type ValidationIssueKind =
  | 'recipe_shape'
  | 'missing_tool'
  | 'missing_required'
  | 'type_mismatch';

export type ValidationIssue = {
  readonly step: number;
  readonly kind: ValidationIssueKind;
  readonly message: string;
};

export type ValidationResult = {
  readonly valid: boolean;
  /** Unique tool names referenced by the recipe that are not in the registry.
   *  Useful for the UI tooltip on "stale" badges — we can name the offenders
   *  without the caller having to sift through issues. */
  readonly missingTools: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<ValidationIssue>;
};

/**
 * Validate a `SkillRecipe` against the current in-process tool registry.
 *
 * Accepts either a parsed `SkillRecipe` or an unparsed `unknown` (the shape
 * stored on `ProceduralSkill.recipe`) — the latter runs `parseRecipe` first
 * and produces a `recipe_shape` issue if parsing fails.
 *
 * The input-shape check is deliberately lightweight (no full JSON-Schema
 * engine): we verify required keys are present and, when a property carries
 * a primitive `type`, that the supplied value's `typeof` matches. Template
 * tokens (`{{$goal}}`, `{{some.ref}}`) are treated as strings — we can't
 * resolve them without a run context, and rejecting them here would make
 * every templated recipe "invalid".
 */
export function validateRecipe(recipe: SkillRecipe | unknown): ValidationResult {
  const parsed: SkillRecipe | null =
    recipe && typeof recipe === 'object' && 'steps' in (recipe as object) &&
    Array.isArray((recipe as { steps?: unknown }).steps)
      ? parseRecipe(recipe)
      : parseRecipe(recipe);

  if (!parsed) {
    return {
      valid: false,
      missingTools: [],
      issues: [
        {
          step: -1,
          kind: 'recipe_shape',
          message: 'Recipe shape is malformed (missing or invalid steps array).',
        },
      ],
    };
  }

  const issues: ValidationIssue[] = [];
  const missingTools = new Set<string>();

  for (let i = 0; i < parsed.steps.length; i += 1) {
    const step = parsed.steps[i];
    if (step.kind !== 'tool') continue;

    const tool = TOOLS.get(step.tool);
    if (!tool) {
      missingTools.add(step.tool);
      issues.push({
        step: i,
        kind: 'missing_tool',
        message: `Step ${i + 1}: tool "${step.tool}" is not registered.`,
      });
      continue;
    }

    // Shape-check input against the tool's input_schema. Schemas use the
    // subset of JSON-Schema we emit: { type, properties, required }.
    const schema = tool.schema.input_schema;
    const shapeIssues = checkInputShape(step.input, schema, i, step.tool);
    for (const issue of shapeIssues) issues.push(issue);
  }

  return {
    valid: issues.length === 0,
    missingTools: Array.from(missingTools),
    issues,
  };
}

/** Primitive type names the lightweight validator knows how to check. */
const KNOWN_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

/** Check a tool step's input against its declared input_schema.
 *  Returns the issues found at this step; never throws. */
function checkInputShape(
  input: unknown,
  schema: Record<string, unknown>,
  stepIndex: number,
  toolName: string,
): ReadonlyArray<ValidationIssue> {
  const issues: ValidationIssue[] = [];
  if (!schema || typeof schema !== 'object') return issues;

  const required = Array.isArray(schema.required)
    ? (schema.required as ReadonlyArray<unknown>).filter(
        (k): k is string => typeof k === 'string',
      )
    : [];
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {};

  // Input must at minimum be an object once required keys are declared.
  if (required.length > 0 && (!input || typeof input !== 'object' || Array.isArray(input))) {
    issues.push({
      step: stepIndex,
      kind: 'type_mismatch',
      message: `Step ${stepIndex + 1} (${toolName}): expected object input but got ${describe(input)}.`,
    });
    return issues;
  }

  const inputObj =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  for (const key of required) {
    if (!(key in inputObj)) {
      issues.push({
        step: stepIndex,
        kind: 'missing_required',
        message: `Step ${stepIndex + 1} (${toolName}): missing required key "${key}".`,
      });
    }
  }

  // Only check primitive-typed properties when a value is supplied. A
  // missing optional property is fine; a template string is always fine.
  for (const [key, propSpec] of Object.entries(properties)) {
    if (!(key in inputObj)) continue;
    const value = inputObj[key];
    if (isTemplateString(value)) continue;
    if (!propSpec || typeof propSpec !== 'object') continue;
    const declaredType = (propSpec as { type?: unknown }).type;
    if (typeof declaredType !== 'string' || !KNOWN_TYPES.has(declaredType)) continue;
    if (!matchesType(value, declaredType)) {
      issues.push({
        step: stepIndex,
        kind: 'type_mismatch',
        message: `Step ${stepIndex + 1} (${toolName}): "${key}" expected ${declaredType}, got ${describe(value)}.`,
      });
    }
  }

  return issues;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && !Number.isNaN(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:        return true;
  }
}

function isTemplateString(v: unknown): boolean {
  return typeof v === 'string' && /\{\{[^}]+\}\}/.test(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ---------------------------------------------------------------------------
// Trust class — derived reputation bucket for a procedural skill.
// ---------------------------------------------------------------------------

export type TrustClass = 'fresh' | 'trusted' | 'flaky' | 'unknown';

/** Minimum use count before we stop calling a skill "fresh" and start
 *  judging it by its success rate. Below this we lack statistical power. */
const TRUST_MIN_USES = 3;
const TRUSTED_RATE = 0.9;
const FLAKY_RATE = 0.5;

type TrustInput = {
  readonly uses_count?: number;
  readonly success_count?: number;
};

/**
 * Bucket a skill's telemetry into one of four trust classes:
 *   • "fresh"   — never run (uses_count === 0).
 *   • "trusted" — run ≥ TRUST_MIN_USES times with success rate ≥ 0.9.
 *   • "flaky"   — run ≥ TRUST_MIN_USES times with success rate < 0.5.
 *   • "unknown" — everything else (small sample, or middling rate).
 */
export function computeTrustClass(skill: TrustInput): TrustClass {
  const uses = skill.uses_count ?? 0;
  const succ = skill.success_count ?? 0;
  if (uses === 0) return 'fresh';
  if (uses < TRUST_MIN_USES) return 'unknown';
  const rate = succ / uses;
  if (rate >= TRUSTED_RATE) return 'trusted';
  if (rate < FLAKY_RATE) return 'flaky';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Test-only exports — pure helpers worth unit-testing without touching Tauri.
// ---------------------------------------------------------------------------

export const __internal = {
  parseRecipe,
  resolveTemplate,
  substituteDeep,
  initialScope,
  isToolResult,
  checkInputShape,
  matchesType,
  isTemplateString,
  checkCapability,
};
