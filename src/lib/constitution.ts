/**
 * Constitution client — TypeScript bridge to `~/.sunny/constitution.json`.
 *
 * Two responsibilities:
 *
 *   1. **Prompt injection**: fold the identity + values + prohibitions
 *      into a short system-prompt block that every run's main LLM call
 *      sees. This replaces the scattered identity strings we had before.
 *
 *   2. **Runtime tool-call gate**: before the agent loop (or the System-1
 *      skill executor) runs any tool, call `checkTool(name, input)`. A
 *      `Block` response short-circuits the call with a
 *      `constitution_block` insight; `Allow` proceeds normally.
 *
 * Both are fail-open — if the backend isn't reachable or the constitution
 * hasn't loaded yet, `checkTool` returns Allow and `renderConstitution`
 * returns a minimal generic block. The goal is never to deadlock an agent
 * run on a misbehaving constitution loader.
 */

import { invokeSafe, isTauri } from './tauri';
import { pushInsight } from '../store/insights';

// ---------------------------------------------------------------------------
// Wire-shape types (mirror Rust)
// ---------------------------------------------------------------------------

export type ConstitutionIdentity = {
  readonly name: string;
  readonly voice: string;
  readonly operator: string;
};

export type Prohibition = {
  readonly description: string;
  readonly tools: ReadonlyArray<string>;
  readonly after_local_hour: number | null;
  readonly before_local_hour: number | null;
  readonly match_input_contains: ReadonlyArray<string>;
};

export type Constitution = {
  readonly schema_version: number;
  readonly identity: ConstitutionIdentity;
  readonly values: ReadonlyArray<string>;
  readonly prohibitions: ReadonlyArray<Prohibition>;
};

export type CheckResult = {
  readonly allowed: boolean;
  readonly reason: string | null;
};

// ---------------------------------------------------------------------------
// In-process cache
//
// `checkTool` would otherwise hit the Rust side for every tool call inside
// a run — cheap, but wasteful. We cache the Constitution for 60s and
// evaluate prohibitions in-process. The Rust command is still the source
// of truth; this is a read-through cache.
// ---------------------------------------------------------------------------

let cached: { value: Constitution; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function loadConstitution(): Promise<Constitution | null> {
  if (!isTauri) return null;
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  const fresh = await invokeSafe<Constitution>('constitution_get');
  if (!fresh) return cached?.value ?? null;
  cached = { value: fresh, at: now };
  return fresh;
}

/** Invalidate the cache — called after constitution_save. */
export function invalidateConstitutionCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Policy check
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool call against the current constitution. Fail-open: a
 * missing backend or unreadable constitution returns Allow.
 *
 * This implementation is a deliberate duplicate of the Rust-side logic in
 * `constitution.rs::check_tool`. Running it in-process avoids a round trip
 * per tool call and — critically — lets the system-1 skill executor gate
 * without touching async I/O mid-recipe. The Rust command
 * `constitution_check` is the authoritative gate for anything paranoid
 * (UI-facing pre-check, future daemon runners) and should exactly agree
 * with this function.
 */
export async function checkTool(
  toolName: string,
  input: unknown,
): Promise<CheckResult> {
  const c = await loadConstitution();
  if (!c) return { allowed: true, reason: null };
  const hour = new Date().getHours();
  const inputJson = safeStringify(input);
  for (const p of c.prohibitions) {
    if (!appliesToTool(p, toolName)) continue;
    if (!matchesHourWindow(p, hour)) continue;
    if (!matchesInput(p, inputJson)) continue;
    return { allowed: false, reason: p.description };
  }
  return { allowed: true, reason: null };
}

function appliesToTool(p: Prohibition, tool: string): boolean {
  // Malformed rule guard: a prohibition with BOTH an empty tool list AND
  // an empty input-match list has no scope — treating it as "applies to
  // everything" (the naive reading of empty-tools) silently gags every
  // tool call during the match-hour window on a user typo. Reject.
  if (p.tools.length === 0 && p.match_input_contains.length === 0) {
    console.warn(
      `[constitution] Ignoring malformed prohibition "${p.description}": both tools[] and match_input_contains[] are empty. At least one must be set.`,
    );
    return false;
  }
  if (p.tools.length === 0) return true;
  return p.tools.includes(tool);
}

function matchesHourWindow(p: Prohibition, hour: number): boolean {
  const after = p.after_local_hour;
  const before = p.before_local_hour;
  if (after === null && before === null) return true;
  if (after !== null && before === null) return hour >= after;
  if (after === null && before !== null) return hour < before;
  // both set
  if (after !== null && before !== null) {
    if (after <= before) return hour >= after && hour < before;
    // wraps midnight
    return hour >= after || hour < before;
  }
  return true;
}

function matchesInput(p: Prohibition, inputJson: string): boolean {
  if (p.match_input_contains.length === 0) return true;
  return p.match_input_contains.some(needle => inputJson.includes(needle));
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/**
 * Thin helper used by every tool-call site. Emits a `constitution_block`
 * insight and returns `false` when the constitution refuses; returns
 * `true` to let the call proceed. Keeps the call sites terse.
 */
export async function gateToolCall(
  toolName: string,
  input: unknown,
): Promise<{ allowed: boolean; reason: string | null }> {
  const res = await checkTool(toolName, input);
  if (!res.allowed && res.reason) {
    pushInsight(
      'constitution_block',
      `Blocked "${toolName}"`,
      res.reason,
      { tool: toolName, input, reason: res.reason },
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Render a compact system-prompt block describing identity, values, and
 * the hard-prohibition list. Called once per run by `renderSystemPrompt`.
 * Values exactly reflect what's on disk so a user-edited constitution
 * shows up in the next run's prompt without a restart.
 */
export function renderConstitutionBlock(c: Constitution | null): string {
  if (!c) {
    return [
      "IDENTITY",
      "- You are SUNNY, a personal assistant running on the user's Mac.",
      "",
      "VALUES",
      '- Be concise. Ask before destructive action.',
    ].join('\n');
  }
  const lines: string[] = [];
  lines.push('IDENTITY');
  lines.push(`- Name: ${c.identity.name}`);
  lines.push(`- Voice: ${c.identity.voice}`);
  lines.push(`- Operator: ${c.identity.operator}`);
  lines.push('');
  if (c.values.length > 0) {
    lines.push('VALUES');
    for (const v of c.values) lines.push(`- ${v}`);
    lines.push('');
  }
  if (c.prohibitions.length > 0) {
    lines.push('HARD PROHIBITIONS (enforced at tool-call gate; never rationalize around these):');
    for (const p of c.prohibitions) {
      const scope =
        p.tools.length > 0 ? `tools=[${p.tools.join(', ')}]` : 'all tools';
      const hour = hourDescription(p);
      const sub = p.match_input_contains.length
        ? ` · if input contains any of: ${p.match_input_contains.map(s => `"${s}"`).join(', ')}`
        : '';
      lines.push(`- ${p.description} (${scope}${hour}${sub})`);
    }
  }
  return lines.join('\n');
}

function hourDescription(p: Prohibition): string {
  const a = p.after_local_hour;
  const b = p.before_local_hour;
  if (a === null && b === null) return '';
  if (a !== null && b === null) return ` · after ${a.toString().padStart(2, '0')}:00`;
  if (a === null && b !== null) return ` · before ${b.toString().padStart(2, '0')}:00`;
  if (a !== null && b !== null) {
    return ` · between ${a.toString().padStart(2, '0')}:00 and ${b.toString().padStart(2, '0')}:00`;
  }
  return '';
}

/** Convenience: load and render in one call. */
export async function loadAndRenderConstitution(): Promise<{
  constitution: Constitution | null;
  prompt: string;
}> {
  const c = await loadConstitution();
  return { constitution: c, prompt: renderConstitutionBlock(c) };
}

export { loadConstitution };

// ---------------------------------------------------------------------------
// Runtime answer verification
//
// The constitution's VALUES block is concatenated into the system prompt
// and otherwise unenforced — a jailbreak, a mis-routed call, or a model
// that "almost listens" can violate declared values without tripping
// anything. This is J v4 friction #5.
//
// `verifyAnswer` is a synchronous, pattern-based, post-hoc check that runs
// AFTER `runAgent` produces its final answer but BEFORE the answer ships
// to the user. Pattern (not LLM) because:
//   - fast + deterministic (<5 ms target);
//   - no extra model calls on the hot path of every turn;
//   - legible to the user when we have to tell them "this was blocked".
//
// Only a handful of constraints are cheap AND worth checking. This list
// is explicit — adding a new rule is one case in `checkSingleValue`, not a
// heuristic that might fire differently on the next model upgrade.
//
// False-positive avoidance is the primary correctness goal: a rule fires
// ONLY when the declared-value string matches a canonical token we
// recognise. An unknown value is a no-op (not a block, not a warn) — that
// keeps user-authored freeform values like "Be kind to Sunny's daughter"
// from getting interpreted as anything.
// ---------------------------------------------------------------------------

export type ConstitutionViolation = {
  readonly kind: string;
  readonly detail: string;
  readonly severity: 'warn' | 'block';
};

/**
 * The canonical phrasing returned to the user when a `block`-severity
 * violation fires. Kept as a single constant so the replacement string
 * is stable and testable.
 */
export const CONSTITUTION_BLOCK_REPLY =
  "I almost said something that broke a ground rule. Please rephrase what you're after.";

/**
 * Verify a fully-composed answer against the constitution's declared
 * values. Each value is a `{ key, constraint }` pair; `key` is a short
 * canonical identifier (see the list below) and `constraint` is the
 * optional parameter (e.g. `"50"` for max_words=50).
 *
 * Recognised keys:
 *   - `max_words`           → constraint = integer cap on word count
 *   - `max_sentences`       → constraint = integer cap on sentence count
 *   - `no_emoji`            → block on any emoji codepoint
 *   - `no_markdown_in_voice`→ block on markdown fences/bold/headers
 *                              (only relevant when the answer will be
 *                              spoken aloud — fires on any turn where
 *                              `options.source === 'voice'` regardless
 *                              of tag, because the rule name declares
 *                              the channel. Legacy: constraint='voice'
 *                              still works when no source is passed.)
 *   - `require_british_english` → WARN on common US spellings; too
 *                              ambiguous to block on
 *   - `confirm_destructive_ran` → sanity check that goes together with a
 *                              snapshot of the turn's tool calls (passed
 *                              via the `toolCalls` option); WARN when a
 *                              dangerous tool fired without ConfirmGate
 *                              evidence
 *
 * Anything else is silently ignored — a freeform value like "Be concise"
 * has no associated pattern and must not produce false positives.
 */
export type VerifyOptions = {
  /**
   * Snapshot of tool calls that fired during this turn, in order. Used
   * only by the `confirm_destructive_ran` check; optional for all
   * others. A tool call is considered "confirmed" if `confirmed === true`.
   */
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string;
    readonly dangerous: boolean;
    readonly confirmed: boolean;
  }>;
  /**
   * Channel the answer will be delivered through. Drives channel-tag
   * filtering (rules tagged `:voice` only fire when `source==='voice'`,
   * rules tagged `:chat` only fire when `source==='chat'`), and flips
   * voice-inherent rules (like `no_markdown_in_voice`) on even when the
   * user didn't manually add the `:voice` suffix.
   *
   * When omitted, ALL rules fire regardless of tag — preserves backward
   * compatibility with call sites that haven't been updated yet, but new
   * sites should pass this explicitly.
   */
  readonly source?: 'voice' | 'chat';
};

/**
 * Rules whose semantics are inherent to the voice channel. A rule with
 * one of these keys defaults to `:voice` scope even when the user wrote
 * it without a channel tag — a user who wrote `no_markdown_in_voice` in
 * their constitution clearly meant it to fire on voice turns, regardless
 * of whether they knew to append `:voice`.
 */
const VOICE_INHERENT_KEYS: ReadonlySet<string> = new Set([
  'no_markdown_in_voice',
]);

/**
 * Rules whose priority bumps to `block` (from their default severity)
 * when the answer is heading to TTS. Voice rambling is worse than chat
 * rambling because the user can't skim past it — they wait through it.
 */
const VOICE_PRIORITY_BUMP: ReadonlySet<string> = new Set([
  'max_words',
  'max_sentences',
]);

export function verifyAnswer(
  answer: string,
  values: readonly { key: string; constraint: string; channel?: 'voice' | 'chat' }[],
  options: VerifyOptions = {},
): ConstitutionViolation[] {
  // Empty answer, empty values, or only unknown values → no violations.
  // This is the fast path that runs on the majority of turns.
  if (!answer || answer.length === 0 || values.length === 0) return [];

  const source = options.source;

  // Accumulate into a fresh array — never mutate the input `values`.
  const violations: ConstitutionViolation[] = [];
  for (const v of values) {
    // Channel-tag gate: `v.channel` is populated by parseConstitutionValues
    // when the user wrote `key:voice` or `key:chat`. A rule whose declared
    // channel doesn't match the current `source` is silently skipped.
    //
    // Sprint-13 ζ fix: voice-inherent keys (e.g. `no_markdown_in_voice`)
    // default to voice scope when a voice turn is in flight but the user
    // didn't append `:voice`. Without this fix, voice turns silently
    // bypassed the rule on a freshly authored constitution.
    //
    // When source is undefined (legacy callers that haven't adopted the
    // new arg yet), we preserve old behavior: the channel tag is used if
    // the user wrote one; otherwise the rule fires regardless. This keeps
    // existing tests and external call sites green during the rollout.
    const effectiveChannel: 'voice' | 'chat' | undefined =
      v.channel !== undefined
        ? v.channel
        : source === 'voice' && VOICE_INHERENT_KEYS.has(v.key)
          ? 'voice'
          : undefined;

    // Skip only when we KNOW the source AND the rule has a declared channel
    // (or voice-inherent default) that doesn't match.
    if (
      source !== undefined &&
      effectiveChannel !== undefined &&
      effectiveChannel !== source
    ) {
      continue;
    }

    const result = checkSingleValue(answer, v, options, effectiveChannel);
    if (!result) continue;

    // Voice priority bump: declared-warn rules don't change, but rules
    // that already block just stay block; documenting the hook point here
    // for future rules that may want warn-on-chat / block-on-voice.
    const bumped: ConstitutionViolation =
      source === 'voice' && VOICE_PRIORITY_BUMP.has(result.kind) && result.severity !== 'block'
        ? { ...result, severity: 'block' }
        : result;
    violations.push(bumped);
  }
  return violations;
}

/**
 * A parsed constitution rule. `channel`, when present, scopes the rule
 * to a specific delivery channel (see the channel-tag table below).
 */
export type ParsedRule = {
  readonly key: string;
  readonly constraint: string;
  /**
   * Channel tag:
   *   - `undefined` → rule applies to both voice and chat (unless the key
   *     is voice-inherent — see VOICE_INHERENT_KEYS).
   *   - `'voice'`   → rule ONLY fires on voice turns.
   *   - `'chat'`    → rule ONLY fires on chat turns.
   */
  readonly channel?: 'voice' | 'chat';
};

/**
 * Parse a raw constitution `values: string[]` (the on-disk shape) into
 * the `ParsedRule[]` shape that `verifyAnswer` expects.
 *
 * Grammar (post sprint-13 ζ):
 *   key
 *   key:constraint
 *   key:constraint:channel
 *   key:channel              (bare channel tag — no constraint)
 *   key=constraint
 *   key=constraint:channel
 *
 * Channel tags are the literal tokens `voice` or `chat`. Anything else
 * after the second colon is treated as part of the constraint (so a
 * numeric `max_words:50` with no channel keeps its full constraint).
 *
 * This keeps user-authored values like `"Be concise"` inert while still
 * activating structured values like `"max_words:60"` or `"no_emoji"`.
 */
export function parseConstitutionValues(
  raw: ReadonlyArray<string>,
): ReadonlyArray<ParsedRule> {
  // New array — never mutate callers' data.
  return raw.map(parseOneRule);
}

function parseOneRule(line: string): ParsedRule {
  const trimmed = line.trim();
  // Accept either "key:..." / "key=..." / bare "key".
  const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s*[:=]\s*(.*)$/i);
  if (match) {
    const key = match[1].toLowerCase();
    const rest = match[2].trim();
    // Channel tag detection: a trailing `:voice` or `:chat` pulls the
    // channel out and leaves the rest as the constraint. If there's no
    // colon, the whole rest is the constraint (may be empty, e.g. a
    // key that has no value).
    const channelMatch = rest.match(/^(.*?):(voice|chat)$/i);
    if (channelMatch) {
      return {
        key,
        constraint: channelMatch[1].trim(),
        channel: channelMatch[2].toLowerCase() as 'voice' | 'chat',
      };
    }
    // No channel tag, but the bare rest might itself BE a channel tag
    // (e.g. user wrote `no_markdown_in_voice:voice` — we used to read
    // 'voice' as the constraint, which checkNoMarkdownInVoice hard-
    // coded. Keep the legacy behaviour by leaving it as constraint,
    // and also promote it to channel so channel-tag filtering works.
    if (rest.toLowerCase() === 'voice' || rest.toLowerCase() === 'chat') {
      return {
        key,
        constraint: rest,
        channel: rest.toLowerCase() as 'voice' | 'chat',
      };
    }
    return { key, constraint: rest };
  }
  // Bare token like "no_emoji" (no colon) — still a valid rule key.
  if (/^[a-z_][a-z0-9_]*$/i.test(trimmed)) {
    return { key: trimmed.toLowerCase(), constraint: '' };
  }
  // Freeform text ("Be concise", "Ask before destructive action") —
  // pass through as a no-op; verifyAnswer's switch will not match it.
  return { key: trimmed, constraint: '' };
}

// --- individual checks ----------------------------------------------------

function checkSingleValue(
  answer: string,
  value: { key: string; constraint: string },
  options: VerifyOptions,
  effectiveChannel: 'voice' | 'chat' | undefined,
): ConstitutionViolation | null {
  switch (value.key) {
    case 'max_words':
      return checkMaxWords(answer, value.constraint);
    case 'max_sentences':
      return checkMaxSentences(answer, value.constraint);
    case 'no_emoji':
      return checkNoEmoji(answer);
    case 'no_markdown_in_voice':
      return checkNoMarkdownInVoice(answer, value.constraint, effectiveChannel, options.source);
    case 'require_british_english':
      return checkBritishEnglish(answer);
    case 'confirm_destructive_ran':
      return checkConfirmDestructive(options.toolCalls ?? []);
    default:
      // Unknown / freeform value → silent no-op. Never ship a false positive.
      return null;
  }
}

/** Parse a positive integer constraint, or null if unparseable. */
function parsePositiveInt(constraint: string): number | null {
  const n = Number.parseInt(constraint, 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n <= 0) return null;
  return n;
}

function countWords(text: string): number {
  // Split on any whitespace run; empty segments (leading/trailing ws) drop out.
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // Split on sentence-terminal punctuation. Filter empties so trailing
  // punctuation doesn't double-count.
  const parts = trimmed.split(/[.!?]+\s+|[.!?]+$/).filter(s => s.trim().length > 0);
  // If there's no terminator at all, treat the whole thing as one sentence.
  return Math.max(parts.length, 1);
}

function checkMaxWords(answer: string, constraint: string): ConstitutionViolation | null {
  const cap = parsePositiveInt(constraint);
  if (cap === null) return null;
  const words = countWords(answer);
  if (words <= cap) return null;
  return {
    kind: 'max_words',
    detail: `Answer has ${words} words; cap is ${cap}.`,
    severity: 'block',
  };
}

function checkMaxSentences(answer: string, constraint: string): ConstitutionViolation | null {
  const cap = parsePositiveInt(constraint);
  if (cap === null) return null;
  const sentences = countSentences(answer);
  if (sentences <= cap) return null;
  return {
    kind: 'max_sentences',
    detail: `Answer has ${sentences} sentences; cap is ${cap}.`,
    severity: 'block',
  };
}

// Emoji regex: the modern `\p{Extended_Pictographic}` property covers
// emoji, pictographs, dingbats, and keycap bases without the giant
// hand-rolled range we'd otherwise need. Requires `u` flag.
const EMOJI_RE = /\p{Extended_Pictographic}/u;

function checkNoEmoji(answer: string): ConstitutionViolation | null {
  if (!EMOJI_RE.test(answer)) return null;
  return {
    kind: 'no_emoji',
    detail: 'Answer contains emoji or pictographic characters.',
    severity: 'block',
  };
}

// Markdown-in-voice fires when the turn IS a voice turn. We recognise that
// from two independent signals:
//   - `context.source === 'voice'` (sprint-13 ζ: the caller tells us);
//   - legacy constraint `voice` or legacy channel tag `:voice`.
//
// The sprint-13 ζ change: if the caller passes `source === 'voice'`, we
// fire regardless of whether the user appended `:voice` to the rule. On
// chat turns we stay silent — markdown renders fine in the chat pane and
// the user wrote it that way on purpose.
const MARKDOWN_RE = /```|\*\*[^*]+\*\*|^#{1,6}\s/m;

function checkNoMarkdownInVoice(
  answer: string,
  constraint: string,
  effectiveChannel: 'voice' | 'chat' | undefined,
  source: 'voice' | 'chat' | undefined,
): ConstitutionViolation | null {
  // Is this turn heading to voice? Either the caller said so, or the
  // rule was explicitly scoped to voice. In the legacy call-site (no
  // `source` passed), fall back to the old constraint-string check so
  // existing callers don't regress.
  const isVoiceTurn =
    source === 'voice' ||
    effectiveChannel === 'voice' ||
    (source === undefined && constraint.toLowerCase() === 'voice');
  if (!isVoiceTurn) return null;
  if (!MARKDOWN_RE.test(answer)) return null;
  return {
    kind: 'no_markdown_in_voice',
    detail: 'Answer contains markdown (code fences, bold, or headers) and will be spoken.',
    severity: 'block',
  };
}

// British-English is inherently fuzzy — US/UK spellings overlap with
// proper nouns and quoted material all the time ("Office of the Color
// Guard" is a real institution; "realize" appears in quoted source
// material). WARN only. We look for standalone tokens so we don't false-
// positive on substrings like "colorblind" or "realized".
const US_SPELLINGS_RE = /\b(color|colors|realize|realized|realizing|organize|organized|organizing|favorite|favorites|honor|honors|labor|labors)\b/i;

function checkBritishEnglish(answer: string): ConstitutionViolation | null {
  if (!US_SPELLINGS_RE.test(answer)) return null;
  return {
    kind: 'require_british_english',
    detail: 'Answer may contain US spellings (color/realize/organize/favorite/honor/labor).',
    severity: 'warn',
  };
}

function checkConfirmDestructive(
  toolCalls: ReadonlyArray<{ name: string; dangerous: boolean; confirmed: boolean }>,
): ConstitutionViolation | null {
  // Find the first dangerous call that did NOT have a positive confirm.
  // One unconfirmed destructive call is enough to raise a warning — we
  // list it in the detail so operators can trace it.
  const offender = toolCalls.find(c => c.dangerous && !c.confirmed);
  if (!offender) return null;
  return {
    kind: 'confirm_destructive_ran',
    detail: `Dangerous tool "${offender.name}" ran without a ConfirmGate approval record.`,
    // WARN rather than BLOCK because this is retrospective — the action
    // already fired. Replacing the user-visible answer wouldn't undo it;
    // the value of surfacing it is auditability.
    severity: 'warn',
  };
}

// ---------------------------------------------------------------------------
// Pure text-rewrite helpers used by the voice path
//
// The chat path replaces the whole answer with `CONSTITUTION_BLOCK_REPLY` on
// a blocking violation, but voice can't — a stock refusal clipped onto a
// half-spoken reply is worse UX than a gently truncated one. These helpers
// let the voice-kick plumbing translate specific rule kinds into the
// minimum text mutation that brings the answer into compliance.
//
// All helpers are pure, allocating a new string and never mutating input.
// ---------------------------------------------------------------------------

/**
 * Clip `answer` to the first `cap` whitespace-separated words, append a
 * trailing ellipsis, and trim trailing punctuation so the join is clean.
 * Returns the original answer unchanged when it already fits.
 *
 * We operate on whitespace-split tokens (matching `countWords`) so the
 * enforcement is consistent with the verifier — truncating on characters
 * or bytes risks chopping mid-word and producing something the verifier
 * still rejects.
 */
export function truncateToWordCap(answer: string, cap: number): string {
  if (!Number.isFinite(cap) || cap <= 0) return answer;
  const words = answer.trim().split(/\s+/);
  if (words.length <= cap) return answer;
  // Strip trailing punctuation on the last retained word so "…" reads
  // naturally after `foo,` or `bar.` (neither looks right spoken).
  const kept = words.slice(0, cap);
  const last = kept[kept.length - 1] ?? '';
  const cleanedLast = last.replace(/[.,;:!?-]+$/u, '');
  const out = [...kept.slice(0, -1), cleanedLast].join(' ');
  return `${out}\u2026`;
}

/**
 * Remove every extended-pictographic codepoint from the answer, then
 * collapse any double spaces the removal created. Pure.
 */
export function stripEmoji(answer: string): string {
  const withoutEmoji = answer.replace(/\p{Extended_Pictographic}/gu, '');
  return withoutEmoji.replace(/ {2,}/g, ' ').trim();
}
