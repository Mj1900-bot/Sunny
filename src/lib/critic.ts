/**
 * Critic — second-pair-of-eyes review for dangerous tool calls.
 *
 * The agent loop has three layers of defense before a dangerous tool
 * runs. Each is stricter than the next:
 *
 *    1. Constitution gate  (hard rule — never rationalizable)
 *    2. Critic review      (cheap LLM — catches "technically allowed but
 *                            looks wrong" cases)
 *    3. ConfirmGate        (user is final authority)
 *
 * The critic is the middle layer. It's a cheap-model call that receives:
 *   - the user's goal
 *   - the constitution values (so it knows what "good" looks like)
 *   - the tool name + schema description
 *   - the proposed input
 *   - a summary of recent steps (what led here)
 *
 * …and returns one of:
 *
 *   • `approve`    — the action looks fine given the goal and constraints
 *   • `block(reason)` — the action is clearly wrong (e.g. emails the
 *                      wrong person, or wipes a file the user asked to
 *                      open); the agent loop aborts the call with the
 *                      reason surfaced as a `constitution_block` insight
 *                      (same channel as constitution blocks — from the
 *                      user's perspective, both are "the agent refused")
 *   • `review`     — the critic is uncertain; fall through to ConfirmGate
 *                    so the user decides
 *
 * Design constraints:
 *   - Uses the cheap model via `chatFor('critic', …)` so the review
 *     doesn't double the latency of an already-gated tool call.
 *   - Pure; returns null on any failure. Callers degrade to "just use
 *     ConfirmGate" — never worse than before.
 *   - Defensively parses the JSON; salvages a fenced block if the model
 *     wrapped it.
 */

import { invokeSafe } from './tauri';
import { chatFor } from './modelRouter';
import type { AgentStep } from './agentLoop';
import type { Constitution } from './constitution';

/**
 * Subset of the Rust-side `ToolStats` shape we need for critic prompting.
 * Kept structurally compatible (not a direct import) so this module stays
 * independent of the memory inspector's typings.
 */
type ReliabilityStats = {
  readonly count: number;
  readonly ok_count: number;
  readonly err_count: number;
  readonly success_rate: number;
  readonly latency_p50_ms: number;
  readonly latency_p95_ms: number;
};

const RELIABILITY_WINDOW_SECS = 7 * 24 * 60 * 60; // last 7 days

export type CriticVerdict =
  | { readonly verdict: 'approve' }
  | { readonly verdict: 'block'; readonly reason: string }
  | { readonly verdict: 'review'; readonly concern: string | null };

export type CriticInput = {
  readonly goal: string;
  readonly toolName: string;
  readonly toolDescription: string;
  readonly toolInput: unknown;
  /** Recent agent steps — gives the critic "what led here" context. */
  readonly recentSteps: ReadonlyArray<AgentStep>;
  readonly constitution: Constitution | null;
  readonly signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Review a dangerous tool call. Returns `null` when the critic can't be
 * reached (Ollama down, Tauri preview) or when the model reply is
 * unparseable — callers should treat null as "skip review, fall through
 * to ConfirmGate" since refusing to act on a critic-unavailable path
 * would make the agent useless when the cheap model is offline.
 */
export async function reviewDangerousAction(
  input: CriticInput,
): Promise<CriticVerdict | null> {
  // Best-effort fetch of recent reliability stats for this tool. The
  // critic uses this as a reliability prior — "tool_X failed 6/10 times
  // in the last week" is a strong signal to lean toward `review` over
  // `approve`. Missing backend → no block; critic proceeds without stats.
  const reliability = await fetchReliability(input.toolName);
  const prompt = buildCriticPrompt(input, reliability);
  const raw = await chatFor('critic', prompt);
  if (!raw) return null;
  return parseVerdict(raw);
}

async function fetchReliability(toolName: string): Promise<ReliabilityStats | null> {
  const stats = await invokeSafe<ReadonlyArray<ReliabilityStats & { tool_name: string }>>(
    'tool_usage_stats',
    {
      opts: {
        tool_name: toolName,
        since_secs_ago: RELIABILITY_WINDOW_SECS,
        limit: 1,
      },
    },
  );
  if (!stats || stats.length === 0) return null;
  const row = stats[0];
  // Require a minimum sample size — with only 1-2 calls, success_rate is
  // too noisy to feed into the critic. 5 is the same floor the skill
  // synthesizer uses for pattern confirmation, so tools consistent
  // enough to summon the critic twice are worth profiling.
  if (row.count < 5) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const STEP_SUMMARY_CAP = 160;
const TOTAL_STEPS_CAP = 1400;

function summariseRecent(steps: ReadonlyArray<AgentStep>): string {
  const lines: string[] = [];
  let total = 0;
  // Only surface the last ~6 steps — the critic doesn't need full history.
  for (const s of steps.slice(-6)) {
    const line = summariseStep(s);
    total += line.length;
    if (total > TOTAL_STEPS_CAP) {
      lines.push('  … (truncated)');
      break;
    }
    lines.push(line);
  }
  return lines.length ? lines.join('\n') : '  (no prior steps)';
}

function summariseStep(step: AgentStep): string {
  switch (step.kind) {
    case 'tool_call': {
      const input = step.toolInput !== undefined ? JSON.stringify(step.toolInput) : '{}';
      const clip = input.length > 80 ? `${input.slice(0, 77)}…` : input;
      return `  → called ${step.toolName ?? '?'} with ${clip}`;
    }
    case 'tool_result': {
      const ok = step.toolOutput?.ok ? 'ok' : 'err';
      const content = step.toolOutput?.content ?? '';
      const clip = content.length > STEP_SUMMARY_CAP ? `${content.slice(0, STEP_SUMMARY_CAP - 1)}…` : content;
      return `  ← ${step.toolName ?? '?'} [${ok}]: ${clip}`;
    }
    case 'message':
    case 'plan':
    case 'error':
      return `  • ${step.kind}: ${step.text.slice(0, STEP_SUMMARY_CAP)}`;
  }
}

function buildCriticPrompt(
  input: CriticInput,
  reliability: ReliabilityStats | null,
): string {
  const values =
    input.constitution?.values?.length
      ? input.constitution.values.map(v => `- ${v}`).join('\n')
      : '- Be concise.\n- Confirm destructive actions.';

  const identity =
    input.constitution?.identity?.name ?? 'SUNNY';
  const operator =
    input.constitution?.identity?.operator ?? 'the user';

  const reliabilityBlock = reliability
    ? [
        'RECENT TOOL RELIABILITY (last 7d):',
        `  ${reliability.ok_count}/${reliability.count} successes ` +
          `(${Math.round(reliability.success_rate * 100)}%) · ` +
          `p50 ${reliability.latency_p50_ms}ms · p95 ${reliability.latency_p95_ms}ms`,
        reliability.success_rate < 0.6
          ? '  ⚠  low success rate — lean toward REVIEW if the call is recoverable'
          : reliability.success_rate < 0.85
            ? '  ℹ  mixed reliability — factor into your judgment'
            : '  ✓  high historical reliability',
        '',
      ]
    : [];

  return [
    `You are the critic for ${identity}, a personal assistant running for ${operator}.`,
    "You review proposed tool calls that the agent has flagged as dangerous.",
    "Return APPROVE / BLOCK / REVIEW based on whether the tool call is aligned with the user's goal and values.",
    '',
    'VALUES (from constitution):',
    values,
    '',
    `USER GOAL: ${input.goal}`,
    '',
    `PROPOSED TOOL CALL:`,
    `  tool: ${input.toolName}`,
    `  description: ${input.toolDescription}`,
    `  input: ${safeStringify(input.toolInput)}`,
    '',
    ...reliabilityBlock,
    'RECENT STEPS:',
    summariseRecent(input.recentSteps),
    '',
    'OUTPUT FORMAT — a single JSON object, nothing else:',
    '  {',
    '    "verdict": "approve" | "block" | "review",',
    '    "reason":  "<one-line explanation, REQUIRED when block>",',
    '    "concern": "<what you are unsure about, OPTIONAL when review>"',
    '  }',
    '',
    'Rules:',
    '- APPROVE when the action clearly serves the goal and has no obvious downside.',
    '- BLOCK only when the action is clearly wrong — wrong recipient, wrong file,',
    '  irrecoverable at the user\'s expense, conflicts with values.',
    '- REVIEW when you are uncertain and want the user to make the final call.',
    '- Never invent facts about the user. If you are unsure, prefer REVIEW.',
    '- Emit JSON only. No markdown, no prose.',
    '',
    'JSON:',
  ].join('\n');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing
// ---------------------------------------------------------------------------

function parseVerdict(raw: string): CriticVerdict | null {
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

function safeParse(raw: string): CriticVerdict | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const v = rec.verdict;
    if (v === 'approve') return { verdict: 'approve' };
    if (v === 'block') {
      const reason = typeof rec.reason === 'string' && rec.reason.trim().length > 0
        ? rec.reason.trim()
        : 'Critic refused';
      return { verdict: 'block', reason };
    }
    if (v === 'review') {
      const concern =
        typeof rec.concern === 'string' && rec.concern.trim().length > 0
          ? rec.concern.trim()
          : null;
      return { verdict: 'review', concern };
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

export const __internal = {
  buildCriticPrompt,
  parseVerdict,
  summariseRecent,
};
