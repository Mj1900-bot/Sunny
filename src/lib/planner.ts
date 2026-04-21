/**
 * Planner — Hierarchical Task Network (HTN) decomposition for complex goals.
 *
 * The ReAct loop plans tool-by-tool but it has no concept of "this goal
 * is actually two separate goals". When a user says "deploy sunny and
 * text mom about it", the loop tries to interleave tool calls for both
 * in one transcript, which wastes context and often fails one sub-task
 * while succeeding the other.
 *
 * This module adds one cheap-model pass at the top of `runAgent`:
 *
 *   decompose(goal, pack)
 *     returns:
 *       • null         — atomic goal, run normally
 *       • subgoals[]   — list of 2–5 independent sub-goals, each of
 *                        which is simpler than the parent
 *
 * When decomposition fires, the caller runs each sub-goal as its own
 * `runAgent` call (SEQUENTIAL — later sub-goals may reference earlier
 * answers via context pack), then composes a parent answer that
 * summarizes the whole thing.
 *
 * Why sequential, not parallel?
 *   • Sub-goals often depend on each other ("fix the build; commit;
 *     push" — the push needs the commit).
 *   • Parallel sub-agent spawning already exists via `useSubAgents`;
 *     reusing it here would conflict with the concurrency limiter.
 *   • Keeps the UX legible — the user sees steps streaming in order
 *     rather than interleaved chaos.
 *
 * Guardrails:
 *   • Max 5 sub-goals. More than that, the user's goal is too fluid and
 *     the decomposer is probably over-splitting.
 *   • No recursion — a sub-goal's own runAgent does NOT decompose. We
 *     gate on `opts.isSubGoal` in agentLoop.
 *   • Per-sub-goal soft timeout via AbortSignal, inheriting from the
 *     parent's signal.
 *   • Skip for very short goals — no value decomposing "open safari".
 */

import { chatFor } from './modelRouter';
import type { ContextPack } from './contextPack';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Decomposition = {
  readonly subgoals: ReadonlyArray<string>;
  readonly rationale: string | null;
};

export type DecomposeOptions = {
  readonly goal: string;
  readonly contextPack: ContextPack | null;
  readonly signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

// Lowered from 16 → 12 chars (sprint-7 Agent H): voice transcripts often
// produce very compact compound commands like "ship it + text mom" (19 chars)
// or "call mom, then home" that were being discarded by the old minimum.
// Going below 12 risks noise from fragments ("ok and go", "yes then no").
const MIN_GOAL_CHARS = 12;
const MIN_SUBGOALS = 2;
const MAX_SUBGOALS = 5;

// Idiomatic "X and Y" phrases that shouldn't trigger decomposition. We can
// only afford to ship a short list — the point is to catch the most common
// false positives, not to be exhaustive. Tolerating false negatives is fine;
// the LLM gets another chance to bail via `decompose: false`.
const IDIOMATIC_AND_PHRASES: ReadonlyArray<string> = [
  'black and white',
  'salt and pepper',
  'peanut butter and jelly',
  'rock and roll',
  'back and forth',
  'pros and cons',
  'nuts and bolts',
  'bread and butter',
  'trial and error',
  'cat and mouse',
  'over and over',
  'again and again',
  'sick and tired',
  'up and down',
  'in and out',
];

// Imperative verbs that commonly appear at the start of a sub-command after
// a sentence-terminating period. When we see `.` followed by one of these,
// we treat it as a punctuation-stripped conjunction. List is intentionally
// short and high-signal — false positives are tolerable (the LLM is the
// second gate) but we don't want to trigger on random noun-starting sentences.
const IMPERATIVE_VERB_STARTS: ReadonlyArray<string> = [
  'send',
  'text',
  'call',
  'email',
  'remind',
  'open',
  'close',
  'build',
  'deploy',
  'ship',
  'push',
  'pull',
  'commit',
  'run',
  'fix',
  'write',
  'read',
  'show',
  'tell',
  'ask',
  'schedule',
  'book',
  'order',
  'buy',
  'create',
  'make',
  'add',
  'delete',
  'update',
  'check',
  'find',
  'search',
  'play',
  'stop',
  'start',
  'restart',
  'post',
  'dm',
  'message',
  'ping',
  'draft',
  'summarize',
];

// Wh-words that, when leading the goal, indicate a single interrogative
// with a noun compound rather than two imperative tasks. Example:
// "what's the weather and time" — one lookup, not two goals. Kept to pure
// interrogative openers; "tell me…" / "show me…" are imperative-leaning
// and commonly introduce multi-step requests, so we DON'T suppress those.
const WH_PREFIXES: ReadonlyArray<string> = [
  "what's ",
  'what is ',
  'what are ',
  'whats ',
  'who is ',
  "who's ",
  'where is ',
  "where's ",
  'when is ',
  "when's ",
  'why is ',
  'how is ',
  'how do ',
  'how are ',
  'how much ',
  'how many ',
  'which ',
];

function stripIdiomaticPhrases(lower: string): string {
  let out = lower;
  for (const phrase of IDIOMATIC_AND_PHRASES) {
    if (out.includes(phrase)) {
      // Replace with a neutral placeholder so the later substring checks
      // don't re-match on the stripped ` and `.
      out = out.split(phrase).join(' __idiom__ ');
    }
  }
  return out;
}

// Skip-decision shape used for telemetry. `reason` is a short tag:
//   "short"                 — below MIN_GOAL_CHARS
//   "wh-compound"           — single-subject wh-query, e.g. "what's the X and Y"
//   "no conj"               — no coordinating conjunction or punctuation bridge
//   "has-conj: <trigger>"   — decomposition should fire; tag names the match
type SkipDecision = {
  readonly skip: boolean;
  readonly reason: string;
};

function startsWithWhPrefix(lower: string): boolean {
  for (const p of WH_PREFIXES) {
    if (lower.startsWith(p)) return true;
  }
  return false;
}

function hasMultipleConjunctions(g: string): boolean {
  // If the goal uses more than one conjunction (e.g. "A, then B and C"),
  // it's very likely multi-goal even if one of the clauses looks compound.
  let count = 0;
  if (g.includes(' and ')) count += 1;
  if (g.includes(' then ')) count += 1;
  if (g.includes(' after ')) count += 1;
  if (g.includes('; ')) count += 1;
  if (/\s&\s/.test(g)) count += 1;
  if (/\s\+\s/.test(g)) count += 1;
  return count >= 2;
}

function matchesPeriodImperative(lower: string): boolean {
  // Detect a sentence-ending period followed by whitespace and a known
  // imperative verb. Example: "update the calendar. send a reminder."
  // We rebuild a regex per call (cheap) rather than keep a massive one
  // literal for readability.
  for (const verb of IMPERATIVE_VERB_STARTS) {
    // `\.` sentence terminator, at least one space, the verb followed by a
    // word boundary (space or end-of-string). Anchored with a preceding
    // letter to avoid matching decimals like "v2.0 send".
    const re = new RegExp(`[a-z0-9)]\\.\\s+${verb}(\\s|$)`, 'i');
    if (re.test(lower)) return true;
  }
  return false;
}

function matchesNumberedList(lower: string): boolean {
  // "1. X 2. Y" — two or more numbered items separated by at least one space.
  // We require the items to be at least a couple characters apart so a
  // stray "1." in prose doesn't trigger.
  return /(^|\s)1[.)]\s+\S.*\s2[.)]\s+\S/.test(lower);
}

function evaluateSkip(goal: string): SkipDecision {
  const trimmed = goal.trim();
  if (trimmed.length < MIN_GOAL_CHARS) {
    return { skip: true, reason: 'short' };
  }

  const lower = trimmed.toLowerCase();
  const g = stripIdiomaticPhrases(lower);

  // Strong multi-goal signals that beat the wh-compound suppression.
  // "and also", "after that", numbered lists, period+imperative, and explicit
  // list separators (semicolon, em-dash) are high-confidence multi-task
  // markers even inside a wh-query.
  if (g.includes(' and also ')) return { skip: false, reason: 'has-conj: and also' };
  if (g.includes(' after that')) return { skip: false, reason: 'has-conj: after that' };
  if (g.includes('; ')) return { skip: false, reason: 'has-conj: ;' };
  if (g.includes(', then ')) return { skip: false, reason: 'has-conj: , then' };
  if (/[—–]/.test(goal)) return { skip: false, reason: 'has-conj: em-dash' };
  if (matchesNumberedList(lower)) {
    return { skip: false, reason: 'has-conj: numbered-list' };
  }
  if (matchesPeriodImperative(lower)) {
    return { skip: false, reason: 'has-conj: period-imperative' };
  }

  // Single-subject wh-compound: "what's the weather and time", "how many cats
  // and dogs are there". These have " and " but shouldn't decompose — they're
  // a single informational query joining two nouns. We only bail if there's
  // ONE conjunction; multi-conjunction wh-queries still decompose.
  if (startsWithWhPrefix(lower) && !hasMultipleConjunctions(g)) {
    return { skip: true, reason: 'wh-compound' };
  }

  // Weaker ASCII conjunctions (case-insensitive via `lower`/`g`).
  if (g.includes(' and ')) return { skip: false, reason: 'has-conj: and' };
  if (g.includes(' then ')) return { skip: false, reason: 'has-conj: then' };
  if (g.includes(' after ')) return { skip: false, reason: 'has-conj: after' };
  if (g.includes(' plus ')) return { skip: false, reason: 'has-conj: plus' };
  if (g.includes(' also ')) return { skip: false, reason: 'has-conj: also' };
  if (g.includes(' et ')) return { skip: false, reason: 'has-conj: et' };
  if (g.includes(' y ')) return { skip: false, reason: 'has-conj: y' };

  // `&` and `+` — only when flanked by whitespace so identifiers and URL
  // fragments don't match. Covers "ship it + text mom" voice shorthand.
  if (/\s&\s/.test(g)) return { skip: false, reason: 'has-conj: &' };
  if (/\s\+\s/.test(g)) return { skip: false, reason: 'has-conj: +' };

  // CJK "and" markers.
  if (/[和並와과]/.test(goal) || goal.includes('以及')) {
    return { skip: false, reason: 'has-conj: cjk' };
  }

  return { skip: true, reason: 'no conj' };
}

function shouldSkip(goal: string): boolean {
  return evaluateSkip(goal).skip;
}

// Telemetry hook — replaced in tests, no-op in production unless wired up by
// a caller (the runAgent turn loop). Kept as a mutable module-level binding
// rather than a setter function so the hot path is a single indirect call.
let telemetrySink: ((entry: DecomposerTelemetry) => void) | null = null;

export type DecomposerTelemetry = {
  readonly fired: boolean;
  readonly reason: string;
  readonly goalChars: number;
  readonly at: number;
};

export function setDecomposerTelemetrySink(
  sink: ((entry: DecomposerTelemetry) => void) | null,
): void {
  telemetrySink = sink;
}

function emitTelemetry(decision: SkipDecision, goalChars: number): void {
  if (!telemetrySink) return;
  // Immutable entry — callers must not mutate.
  const entry: DecomposerTelemetry = Object.freeze({
    fired: !decision.skip,
    reason: decision.reason,
    goalChars,
    at: Date.now(),
  });
  try {
    telemetrySink(entry);
  } catch {
    // Telemetry must never throw into the hot path.
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Ask the cheap model whether the goal should be split. Returns the list
 * of sub-goals (>= 2) or null to signal "atomic — run as a single goal".
 * Never throws.
 */
export async function maybeDecompose(
  opts: DecomposeOptions,
): Promise<Decomposition | null> {
  const decision = evaluateSkip(opts.goal);
  emitTelemetry(decision, opts.goal.trim().length);
  if (decision.skip) return null;

  const prompt = buildDecompositionPrompt(opts);
  const raw = await chatFor('decomposition', prompt);
  if (!raw) return null;

  const parsed = parseDecomposition(raw);
  if (!parsed) return null;

  // Post-parse validation: sub-goals must be distinct and ≠ the parent.
  const uniq = dedupe(parsed.subgoals);
  const filtered = uniq.filter(s => normalize(s) !== normalize(opts.goal));
  if (filtered.length < MIN_SUBGOALS) return null;
  if (filtered.length > MAX_SUBGOALS) {
    return {
      subgoals: filtered.slice(0, MAX_SUBGOALS),
      rationale: parsed.rationale,
    };
  }
  return { subgoals: filtered, rationale: parsed.rationale };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildDecompositionPrompt(opts: DecomposeOptions): string {
  const world = opts.contextPack?.memory?.world;
  const activity = world?.activity ?? 'unknown';
  const focused = world?.focus?.app_name ?? 'unknown';

  return [
    "You are the HTN planner for SUNNY. You decide whether a user goal",
    'should be split into independent sub-goals that each run as their own',
    'agent turn, or kept as one goal.',
    '',
    `USER GOAL: ${opts.goal}`,
    '',
    `CONTEXT: activity=${activity}, focused=${focused}`,
    '',
    'OUTPUT FORMAT — a single JSON object, NOTHING else:',
    '  {',
    '    "decompose": <boolean>,',
    '    "subgoals": ["<subgoal 1>", "<subgoal 2>", ...],',
    '    "rationale": "<one-sentence why, OPTIONAL>"',
    '  }',
    '',
    'Rules:',
    `- Split only when there are 2–${MAX_SUBGOALS} clearly INDEPENDENT tasks.`,
    '- Each sub-goal must be a complete sentence that stands alone.',
    '- Preserve the user\'s original words where possible; don\'t rephrase unnecessarily.',
    '- If the goal is atomic (single task, even if long), return decompose: false.',
    '- Emit JSON only. No markdown, no prose, no code fences.',
    '',
    'JSON:',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing
// ---------------------------------------------------------------------------

function parseDecomposition(raw: string): Decomposition | null {
  const trimmed = raw.trim();
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const direct = safeParse(fenceStripped);
  if (direct) return direct;

  const salvaged = extractLargestObject(fenceStripped);
  if (salvaged) {
    const retry = safeParse(salvaged);
    if (retry) return retry;
  }
  return null;
}

function safeParse(raw: string): Decomposition | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const decompose = rec.decompose === true;
    if (!decompose) return null;
    const subgoalsRaw = rec.subgoals;
    if (!Array.isArray(subgoalsRaw)) return null;
    const subgoals: string[] = [];
    for (const s of subgoalsRaw) {
      if (typeof s === 'string' && s.trim().length > 0) subgoals.push(s.trim());
    }
    if (subgoals.length < MIN_SUBGOALS) return null;
    const rationale =
      typeof rec.rationale === 'string' && rec.rationale.trim().length > 0
        ? rec.rationale.trim()
        : null;
    return { subgoals, rationale };
  } catch {
    return null;
  }
}

function extractLargestObject(raw: string): string | null {
  // Walk the string character-by-character tracking brace depth and whether
  // we're currently inside a JSON string literal. Proper handling of `\"`
  // (escaped quote) vs `"` (string terminator) is essential — otherwise a
  // payload like {"msg": "she said \"hi\""} closes its string early and
  // the brace counter goes negative.
  //
  // We also sanitize raw control characters (U+0000..U+001F) that appear
  // *inside* string literals. These are technically illegal in JSON, but
  // cheap models regularly emit raw newlines inside multi-line sub-goal
  // strings. We rewrite them to their escape sequences (\n, \r, \t, \uXXXX)
  // so the extracted slice is parseable by JSON.parse.
  let best: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '{') continue;
    const sanitized = extractObjectAt(raw, i);
    if (sanitized !== null && (!best || sanitized.length > best.length)) {
      best = sanitized;
    }
  }
  return best;
}

function extractObjectAt(raw: string, start: number): string | null {
  const buf: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = start; j < raw.length; j += 1) {
    const ch = raw[j];
    if (inString) {
      if (escape) {
        // Previous char was a backslash — this char is part of the escape
        // sequence. Emit as-is; don't interpret.
        buf.push(ch);
        escape = false;
        continue;
      }
      if (ch === '\\') {
        buf.push(ch);
        escape = true;
        continue;
      }
      if (ch === '"') {
        buf.push(ch);
        inString = false;
        continue;
      }
      // Rewrite raw control characters inside the string so JSON.parse
      // doesn't choke on unescaped newlines, tabs, etc.
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === '\n') buf.push('\\n');
        else if (ch === '\r') buf.push('\\r');
        else if (ch === '\t') buf.push('\\t');
        else if (ch === '\b') buf.push('\\b');
        else if (ch === '\f') buf.push('\\f');
        else buf.push('\\u' + code.toString(16).padStart(4, '0'));
        continue;
      }
      buf.push(ch);
      continue;
    }
    buf.push(ch);
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return buf.join('');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupe(xs: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = normalize(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

export const __internal = {
  shouldSkip,
  evaluateSkip,
  buildDecompositionPrompt,
  parseDecomposition,
  extractLargestObject,
  MIN_SUBGOALS,
  MAX_SUBGOALS,
  MIN_GOAL_CHARS,
};
