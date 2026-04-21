/**
 * Agent Society — chair dispatcher.
 *
 * The dispatcher picks a specialist role for a given goal. Two-stage:
 *
 *   1. **Keyword prefilter** — `scoreRolesByTriggers(goal)` returns
 *      candidate roles with hit counts. If exactly one candidate has
 *      hits (or the top candidate has ≥ 2 hits and the runner-up has
 *      ≤ 1), we use it directly — no LLM call needed.
 *
 *   2. **Cheap-model tiebreak** — when keywords are ambiguous (multiple
 *      roles tied or no triggers matched), call the cheap model with a
 *      terse "pick one" prompt. Falls back to generalist on any parse
 *      or transport failure.
 *
 * Callers use `pickRole(goal, pack)` → `RoleId`. The caller then:
 *   • Filters the tool registry to `ROLES[id].tools`
 *   • Appends `ROLES[id].promptFragment` to the system prompt
 *   • Runs the normal agent loop
 *
 * This module is deliberately separate from `agentLoop.ts` so the society
 * layer can be toggled on/off via `settings.societyEnabled` without
 * touching core-loop code.
 */

import { chatFor } from '../modelRouter';
import type { ContextPack } from '../contextPack';
import { pushInsight } from '../../store/insights';
import { ROLES, scoreRolesByTriggers, type RoleId, type RoleSpec } from './roles';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Dispatch = {
  readonly role: RoleSpec;
  /** How the chair arrived at this role. Logged to insights. */
  readonly reason: 'keyword' | 'model' | 'fallback';
  /** Confidence 0..1. Keyword matches use hit count ÷ top-K; model picks
   *  use a flat 0.75 since we don't ask for a confidence score. */
  readonly confidence: number;
};

export type DispatchOptions = {
  readonly goal: string;
  readonly contextPack: ContextPack | null;
  readonly signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Pick a role for this goal. Fail-open: on any error, returns the
 * `generalist` role (full tool access, normal behaviour).
 */
export async function pickRole(opts: DispatchOptions): Promise<Dispatch> {
  const keywordScores = scoreRolesByTriggers(opts.goal);

  // Stage 1: confident keyword match — use it.
  if (keywordScores.length === 1 && keywordScores[0].hits >= 1) {
    return finalize(keywordScores[0].id, 'keyword', confidenceFromHits(keywordScores[0].hits));
  }
  if (
    keywordScores.length >= 2 &&
    keywordScores[0].hits >= 2 &&
    keywordScores[0].hits >= keywordScores[1].hits + 2
  ) {
    return finalize(keywordScores[0].id, 'keyword', confidenceFromHits(keywordScores[0].hits));
  }

  // Stage 2: ambiguous keywords (or no triggers at all) — ask the cheap
  // model. Pass in the context pack's semantic hits so the model has
  // the user's recent themes to lean on. Fail-open to generalist.
  try {
    const picked = await askModel(opts);
    if (picked) return finalize(picked, 'model', 0.75);
  } catch (err) {
    console.debug('[society] model dispatch failed:', err);
  }

  return finalize('generalist', 'fallback', 0.25);
}

/**
 * Lookup-and-wrap. Emits a `introspect_caveat` insight so the user can
 * see which role fired — same channel as other routing insights.
 */
function finalize(id: RoleId, reason: Dispatch['reason'], confidence: number): Dispatch {
  const role = ROLES[id];
  pushInsight(
    'introspect_caveat',
    `Dispatched to ${role.name}`,
    `${reason} match · conf ${confidence.toFixed(2)} · ${role.description}`,
    { role: id, reason, confidence },
  );
  return { role, reason, confidence };
}

// ---------------------------------------------------------------------------
// Confidence heuristic — trigger hit count → [0.4, 0.95]
// ---------------------------------------------------------------------------

function confidenceFromHits(hits: number): number {
  // 1 → 0.55; 2 → 0.70; 3+ → 0.85 (cap at 0.95 so we never claim certainty)
  if (hits <= 0) return 0.25;
  if (hits === 1) return 0.55;
  if (hits === 2) return 0.70;
  if (hits === 3) return 0.85;
  return 0.95;
}

// ---------------------------------------------------------------------------
// Model dispatch
// ---------------------------------------------------------------------------

async function askModel(opts: DispatchOptions): Promise<RoleId | null> {
  const prompt = buildDispatchPrompt(opts);
  const raw = await chatFor('decomposition', prompt);
  if (!raw) return null;
  return parseRolePick(raw);
}

function buildDispatchPrompt(opts: DispatchOptions): string {
  const specialists = Object.values(ROLES).filter(r => r.id !== 'chair' && r.id !== 'generalist');
  const table = specialists
    .map(
      r =>
        `  ${r.id.padEnd(12)} — ${r.description} (triggers: ${r.triggers.slice(0, 6).join(', ')})`,
    )
    .join('\n');

  const pack = opts.contextPack?.memory;
  const recentFacts = (pack?.semantic ?? [])
    .slice(0, 4)
    .map(f => `  • ${f.subject ? `[${f.subject}] ` : ''}${f.text}`)
    .join('\n');

  return [
    'You are the CHAIR. Pick exactly one specialist role for the user goal.',
    'Reply with a single JSON object: { "role": "<id>" }',
    'No prose, no markdown.',
    '',
    'SPECIALISTS:',
    table,
    '  generalist   — fallback when nothing else fits (full tool access)',
    '',
    `USER GOAL: ${opts.goal}`,
    '',
    recentFacts.length > 0 ? `MEMORY CONTEXT:\n${recentFacts}\n` : '',
    'Rules:',
    '- Choose the most specific role whose capabilities cover the goal.',
    '- If two specialists both fit, prefer the one whose trigger keywords',
    '  appear more prominently in the goal phrasing.',
    '- Use `generalist` only when no specialist is a clear match.',
    '',
    'JSON:',
  ].join('\n');
}

function parseRolePick(raw: string): RoleId | null {
  const trimmed = raw.trim();
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Try direct parse first.
  const direct = safeParse(fenceStripped);
  if (direct) return direct;

  // Salvage: find a balanced `{...}` substring.
  for (let i = 0; i < fenceStripped.length; i += 1) {
    if (fenceStripped[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < fenceStripped.length; j += 1) {
      const ch = fenceStripped[j];
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
          const candidate = fenceStripped.slice(i, j + 1);
          const retry = safeParse(candidate);
          if (retry) return retry;
          break;
        }
      }
    }
  }
  return null;
}

function safeParse(raw: string): RoleId | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const id = (parsed as Record<string, unknown>).role;
    if (typeof id !== 'string') return null;
    if (!(id in ROLES)) return null;
    if (id === 'chair') return null; // chair can't pick itself
    return id as RoleId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings lookup — used by agentLoop to gate society mode
// ---------------------------------------------------------------------------

/** Is the society mode opted-in via settings? Fail-safe default: off. */
export function societyEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem('sunny.settings.v1');
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.societyEnabled === true;
  } catch {
    return false;
  }
}

export const __internal = {
  buildDispatchPrompt,
  parseRolePick,
  confidenceFromHits,
};
