/**
 * Pre-run introspection — the metacognitive pass BEFORE the agent loop.
 *
 * Mirror image of `reflect.ts`:
 *
 *   perception → memory → INTROSPECT (pre) → action → reflect (post) → memory
 *
 * Given the goal and the current context pack, a cheap LLM decides one of:
 *
 *   • `direct`   — the answer is already in memory (semantic facts or a
 *                  strong matched lesson) and the agent can answer
 *                  immediately without tools or the planning loop.
 *                  Returns `{ mode:'direct', answer:'…' }`.
 *
 *   • `clarify`  — the goal is ambiguous or under-specified ("fix the
 *                  bug" — which bug?). Rather than burning 4+ LLM turns
 *                  guessing, the agent asks ONE focused clarifying
 *                  question and waits. Returns `{ mode:'clarify', question:'…' }`.
 *
 *   • `proceed`  — normal case; hand off to the main loop. Optionally
 *                  attaches caveats ("note: user has a meeting in 15m,
 *                  keep this under 30s") that get injected into the
 *                  system prompt.
 *
 * Design constraints (same as reflect.ts):
 *   - Must never block the user's answer on its own failure. Any error
 *     → return null → runAgent proceeds normally.
 *   - Uses a CHEAP model by default (configurable override). We pay for
 *     an extra round trip only when it saves multiple main-loop turns.
 *   - Pure, testable helpers (`__internal`). The shape-check + JSON
 *     salvage live here.
 *
 * Guardrails:
 *   - Disable for goals shorter than a few words (no value, pure latency).
 *   - Disable when no facts/lessons were retrieved — `direct` mode has
 *     nothing to stand on; `clarify`/`proceed` reduce to just a latency
 *     hit. Skipping entirely is correct.
 */

import { isTauri } from './tauri';
import type { ContextPack } from './contextPack';
import { pushInsight } from '../store/insights';
import { chatFor } from './modelRouter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IntrospectionResult =
  | { readonly mode: 'direct'; readonly answer: string }
  | { readonly mode: 'clarify'; readonly question: string }
  /**
   * Middle path between `clarify` and `proceed`: the goal is ambiguous,
   * BUT semantic memory gives us enough context to infer the user's
   * intent. Rather than pester them, rewrite the goal into a concrete
   * one and proceed with that. The original goal is preserved in the
   * episodic record; the rewritten goal is what the main loop plans
   * against. A visible insight makes this transparent.
   */
  | { readonly mode: 'rewrite'; readonly rewritten: string; readonly reason: string }
  | { readonly mode: 'proceed'; readonly caveats: ReadonlyArray<string> };

export type IntrospectOptions = {
  readonly goal: string;
  readonly contextPack: ContextPack | null;
  readonly provider?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const MIN_GOAL_WORDS = 3;

function shouldSkip(opts: IntrospectOptions): boolean {
  if (!isTauri) return true;
  const settings = readSettings();
  if (settings.introspectionEnabled === false) return true;

  const words = opts.goal.trim().split(/\s+/).filter(Boolean);
  if (words.length < MIN_GOAL_WORDS) return true;

  const m = opts.contextPack?.memory;
  // Nothing in memory to ground a direct/clarify decision — proceed silently.
  const semanticHits = m?.semantic?.length ?? 0;
  const matchedEpisodes = m?.matched_episodic?.length ?? 0;
  const matchedSkills = m?.matched_skills?.length ?? 0;
  if (semanticHits === 0 && matchedEpisodes === 0 && matchedSkills === 0) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type PersistedSettings = {
  readonly provider?: string;
  readonly model?: string;
  readonly introspectionEnabled?: boolean;
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
      introspectionEnabled:
        typeof parsed.introspectionEnabled === 'boolean'
          ? parsed.introspectionEnabled
          : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run an introspection pass. Returns the decision or `null` when skipped /
 * failed. Never throws.
 */
export async function introspectGoal(
  opts: IntrospectOptions,
): Promise<IntrospectionResult | null> {
  if (shouldSkip(opts)) return null;

  const prompt = buildIntrospectionPrompt(opts);
  // Cheap model by default — introspection is on the critical path but
  // the decision space is small (direct/clarify/proceed), so a small
  // local model handles it well and saves ~150ms vs a big-model round trip.
  const routeOverride =
    opts.provider && opts.model ? { provider: opts.provider, model: opts.model } : undefined;
  const raw = await chatFor('introspection', prompt, { routeOverride });
  if (!raw) return null;

  const parsed = parseIntrospection(raw);
  if (!parsed) return null;

  // Emit a user-visible insight so "why did it answer instantly" is
  // legible in the feed. `caveats`-only proceed is low-signal; we push
  // an insight only when caveats are non-empty.
  if (parsed.mode === 'direct') {
    pushInsight(
      'introspect_direct',
      'Answered from memory',
      'Pre-run check found the answer in semantic memory — skipped the loop',
      { goal: opts.goal, answer: parsed.answer },
    );
  } else if (parsed.mode === 'rewrite') {
    pushInsight(
      'introspect_caveat',
      'Rewrote ambiguous goal',
      `"${parsed.rewritten}" — ${parsed.reason}`,
      { original: opts.goal, rewritten: parsed.rewritten, reason: parsed.reason },
    );
  } else if (parsed.mode === 'clarify') {
    pushInsight(
      'introspect_clarify',
      'Asked a clarifying question',
      'Goal was ambiguous; clarifying instead of guessing',
      { goal: opts.goal, question: parsed.question },
    );
  } else if (parsed.caveats.length > 0) {
    pushInsight(
      'introspect_caveat',
      'Added caveats',
      parsed.caveats.join(' · '),
      { goal: opts.goal, caveats: parsed.caveats },
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildIntrospectionPrompt(opts: IntrospectOptions): string {
  const m = opts.contextPack?.memory;
  const world = m?.world;
  const facts = (m?.semantic ?? [])
    .slice(0, 6)
    .map((f, i) => {
      const subj = f.subject ? `[${f.subject}] ` : '';
      return `  ${i + 1}. ${subj}${f.text}`;
    })
    .join('\n');
  const matchedSkills = (m?.matched_skills ?? [])
    .slice(0, 3)
    .map(
      (ms, i) =>
        `  ${i + 1}. ${ms.skill.name} (score=${ms.score.toFixed(2)}): ${ms.skill.description}`,
    )
    .join('\n');
  const pastRuns = (m?.matched_episodic ?? [])
    .slice(0, 5)
    .map((e, i) => {
      const when = new Date(e.created_at * 1000).toISOString().slice(0, 16);
      const t = e.text.length > 180 ? `${e.text.slice(0, 177)}…` : e.text;
      return `  ${i + 1}. ${when} [${e.kind}] ${t}`;
    })
    .join('\n');

  const activity = world?.activity ?? 'unknown';
  const focused = world?.focus?.app_name ?? 'unknown';
  const nextEvent = world?.next_event
    ? `${world.next_event.title} at ${world.next_event.start}`
    : 'none';

  return [
    "You are SUNNY's pre-run introspector. You decide one of four things:",
    "  (a) the user's goal is already answered by the memory below — return DIRECT",
    "  (b) the user's goal is ambiguous AND memory makes the intent clear — return REWRITE",
    "      (rewrite into a concrete goal; don't pester the user)",
    "  (c) the user's goal is ambiguous AND memory is unclear — return CLARIFY",
    "      (ask ONE focused question)",
    "  (d) the goal is clear and needs the normal planning loop — return PROCEED",
    '',
    'Be conservative. Only return DIRECT if semantic facts ALREADY contain',
    'the answer and zero tool calls are needed. Prefer REWRITE over CLARIFY',
    'when the user has a clear pattern in memory (e.g. "make it better" on a',
    'project you have extensive facts about → rewrite into specifics).',
    'Fall back to CLARIFY only when memory genuinely cannot resolve the ambiguity.',
    '',
    `CURRENT GOAL: ${opts.goal}`,
    '',
    `WORLD: activity=${activity}, focused=${focused}, next_event=${nextEvent}`,
    '',
    `KNOWN FACTS (${m?.semantic?.length ?? 0}):`,
    facts.length > 0 ? facts : '  (none)',
    '',
    `LEARNED SKILLS (goal-matched, ${m?.matched_skills?.length ?? 0}):`,
    matchedSkills.length > 0 ? matchedSkills : '  (none)',
    '',
    `RELATED PAST RUNS (${m?.matched_episodic?.length ?? 0}):`,
    pastRuns.length > 0 ? pastRuns : '  (none)',
    '',
    'OUTPUT FORMAT — a single JSON object, nothing else:',
    '  {',
    '    "mode": "direct" | "rewrite" | "clarify" | "proceed",',
    '    "answer":    "<final answer, ONLY when mode=direct>",',
    '    "rewritten": "<concrete goal text, ONLY when mode=rewrite>",',
    '    "reason":    "<one-sentence why the rewrite is correct, mode=rewrite only>",',
    '    "question":  "<one concise question, ONLY when mode=clarify>",',
    '    "caveats":   ["<short caveat>", …]  // 0-3 items; mode=proceed only',
    '  }',
    '',
    'Rules:',
    '- Emit JSON only. No markdown, no prose.',
    '- Fields not applicable to the chosen mode MUST be absent or empty.',
    "- Don't hallucinate facts. If you're not certain, return PROCEED.",
    '',
    'JSON:',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing
// ---------------------------------------------------------------------------

function parseIntrospection(raw: string): IntrospectionResult | null {
  const trimmed = raw.trim();
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const direct = safeParseIntrospection(fenceStripped);
  if (direct) return direct;

  const salvaged = extractLargestObject(fenceStripped);
  if (salvaged) {
    const retry = safeParseIntrospection(salvaged);
    if (retry) return retry;
  }
  return null;
}

function safeParseIntrospection(raw: string): IntrospectionResult | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const mode = rec.mode;

    if (mode === 'direct') {
      const answer = typeof rec.answer === 'string' ? rec.answer.trim() : '';
      if (!answer) return null;
      return { mode: 'direct', answer };
    }
    if (mode === 'rewrite') {
      const rewritten = typeof rec.rewritten === 'string' ? rec.rewritten.trim() : '';
      if (!rewritten) return null;
      const reason =
        typeof rec.reason === 'string' && rec.reason.trim().length > 0
          ? rec.reason.trim()
          : 'Rewrote goal based on memory context';
      return { mode: 'rewrite', rewritten, reason };
    }
    if (mode === 'clarify') {
      const question = typeof rec.question === 'string' ? rec.question.trim() : '';
      if (!question) return null;
      return { mode: 'clarify', question };
    }
    if (mode === 'proceed') {
      const caveats = Array.isArray(rec.caveats)
        ? rec.caveats
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            .map(c => c.trim())
            .slice(0, 3)
        : [];
      return { mode: 'proceed', caveats };
    }
    return null;
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
// Test-only exports
// ---------------------------------------------------------------------------

export const __internal = {
  buildIntrospectionPrompt,
  parseIntrospection,
  shouldSkip,
};
