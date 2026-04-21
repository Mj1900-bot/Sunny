// ---------------------------------------------------------------------------
// JSON parsing — defensive, with one regex-salvage retry.
// Also: tool-call ledger reconstruction (for verifyAnswer).
// ---------------------------------------------------------------------------

import { TOOLS } from '../tools';
import type { AgentStep } from './types';

export type ToolAction = { readonly action: 'tool'; readonly tool: string; readonly input: unknown };
export type AnswerAction = { readonly action: 'answer'; readonly text: string };
export type ModelAction = ToolAction | AnswerAction;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normaliseAction(value: unknown): ModelAction | null {
  if (!isRecord(value)) return null;
  const action = value.action;
  if (action === 'tool') {
    const tool = typeof value.tool === 'string' ? value.tool : '';
    if (!tool) return null;
    const input = 'input' in value ? value.input : {};
    return { action: 'tool', tool, input };
  }
  if (action === 'answer') {
    const text = typeof value.text === 'string' ? value.text : '';
    return { action: 'answer', text };
  }
  return null;
}

function tryParseJson(raw: string): ModelAction | null {
  try {
    return normaliseAction(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Grab the largest balanced {…} substring. Handles strings-with-braces and
// escape sequences so a JSON object embedded in markdown or prose survives.
function extractLargestJsonObject(raw: string): string | null {
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

export function parseModelResponse(raw: string): ModelAction {
  const trimmed = raw.trim();
  // Strip common markdown code fences if present.
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const direct = tryParseJson(fenceStripped);
  if (direct) return direct;

  const salvaged = extractLargestJsonObject(fenceStripped);
  if (salvaged) {
    const retry = tryParseJson(salvaged);
    if (retry) return retry;
  }

  // Treat the raw text as the final answer.
  return { action: 'answer', text: trimmed };
}

// ---------------------------------------------------------------------------
// Tool-call ledger reconstruction (for verifyAnswer)
// ---------------------------------------------------------------------------
//
// Walks the run's step stream and pairs each `tool_call` with the
// matching `tool_result` (the next result bearing the same toolName).
// A tool is considered "confirmed" if its result was NOT the explicit
// ConfirmGate-declined sentinel. This is best-effort — the verifier
// treats the ledger as a hint, not a transcript.
//
// Pulled out into its own function so agentLoop's main body stays
// readable and so the logic is easy to unit-test in isolation if
// needed later.
// ---------------------------------------------------------------------------

export function reconstructToolCalls(
  steps: ReadonlyArray<AgentStep>,
  tools: typeof TOOLS,
): ReadonlyArray<{ name: string; dangerous: boolean; confirmed: boolean }> {
  // Build fresh arrays — never mutate the step stream.
  const calls: { name: string; dangerous: boolean; confirmed: boolean }[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (s.kind !== 'tool_call' || typeof s.toolName !== 'string') continue;
    const toolName = s.toolName;
    const spec = tools.get(toolName);
    const dangerous = !!spec?.dangerous;
    // Scan forward for the matching tool_result. First match wins —
    // multiple simultaneous calls to the same tool is rare and the
    // ordering is already linear in the transcript.
    let confirmed = true;
    for (let j = i + 1; j < steps.length; j += 1) {
      const r = steps[j];
      if (r.kind === 'tool_result' && r.toolName === toolName) {
        const content = r.toolOutput?.content ?? '';
        if (r.toolOutput?.ok === false && content.startsWith('User declined dangerous tool')) {
          confirmed = false;
        }
        break;
      }
    }
    calls.push({ name: toolName, dangerous, confirmed });
  }
  return calls;
}
