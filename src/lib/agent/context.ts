// ---------------------------------------------------------------------------
// Context building: settings access, system prompt assembly, default chat.
// ---------------------------------------------------------------------------

import { invoke, invokeSafe, isTauri } from '../tauri';
import { listToolSchemas } from '../tools';
import { renderSystemPromptWithReport, type ContextPack } from '../contextPack';
import type { RoleSpec } from '../society/roles';
import type { ChatFn } from './types';

// ---------------------------------------------------------------------------
// Settings access (React-free — reads the same localStorage key view.ts writes)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'sunny.settings.v1';

type InferredSettings = {
  readonly provider?: string;
  readonly model?: string;
};

export function readSettings(): InferredSettings {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = typeof parsed.provider === 'string' ? parsed.provider : undefined;
    const model = typeof parsed.model === 'string' ? parsed.model : undefined;
    return { provider, model };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Default chat backend — PREFERS the Tauri `llm_oneshot` command, which does
// a single provider round-trip with NO Rust-side tool dispatch. This is the
// fix for the "double-loop" problem where the TS ReAct loop called `chat`,
// which itself ran a full Rust ReAct loop — causing tools to be chosen and
// executed twice. `llm_oneshot` keeps planning in TS (where the tool
// registry, constitution gate, critic, and ConfirmGate live) and uses the
// Rust side only as a thin provider client.
//
// FALLBACK: if `llm_oneshot` isn't registered on this build (Agent α hasn't
// landed yet), or the command errors with an "unknown command"-shaped
// message, we fall through to the legacy `chat` command so voice and chat
// turns keep working on mixed builds.
// ---------------------------------------------------------------------------

// Split the turn prompt back into a system block + a single user message.
// `buildTurnPrompt` concatenates:
//
//     <systemPrompt>\n\n<TRANSCRIPT SO FAR:...>\n\nRespond with the next JSON object.
//
// So the "TRANSCRIPT SO FAR" line is a reliable boundary. If it's missing
// (unexpected caller shape), treat the whole blob as the user message and
// leave `system` empty — `llm_oneshot` tolerates either.
const TRANSCRIPT_MARKER = 'TRANSCRIPT SO FAR';

export function splitSystemFromMessage(message: string): {
  readonly system: string;
  readonly user: string;
} {
  const idx = message.indexOf(TRANSCRIPT_MARKER);
  if (idx === -1) {
    return { system: '', user: message };
  }
  // Trim trailing whitespace from the system block so we don't ship the
  // blank separator line that buildTurnPrompt inserts.
  const system = message.slice(0, idx).replace(/\s+$/, '');
  const user = message.slice(idx);
  return { system, user };
}

// Heuristic: does this thrown error indicate the Tauri command isn't
// registered on this build? Tauri's core surfaces these as strings like
// "command llm_oneshot not found" or "unknown command 'llm_oneshot'". We
// match loosely so any reasonable phrasing fires the fallback path.
export function isUnknownCommandError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('unknown command') ||
    msg.includes('not found') ||
    msg.includes('command not found') ||
    msg.includes('no such command')
  );
}

export const defaultChat: ChatFn = async (message, opts) => {
  const { system, user } = splitSystemFromMessage(message);
  const messages = [{ role: 'user', content: user }];

  // Primary path — `llm_oneshot`. Use raw `invoke` (not `invokeSafe`) so
  // we can distinguish "command missing" from a legit provider error.
  if (isTauri) {
    try {
      const response = await invoke<string>('llm_oneshot', {
        req: {
          system,
          messages,
          provider: opts.provider,
          model: opts.model,
          max_tokens: 2048,
        },
      });
      if (typeof response === 'string' && response.length > 0) {
        console.info('[agentLoop] chat via llm_oneshot');
        return response;
      }
      // Empty/non-string response from llm_oneshot — fall through.
    } catch (err) {
      if (!isUnknownCommandError(err)) {
        // Real provider error: surface it to the caller instead of
        // silently retrying through the Rust ReAct loop, which would just
        // hit the same provider and usually the same failure.
        throw err instanceof Error ? err : new Error(String(err));
      }
      // Command missing — Agent α hasn't shipped on this build. Fall
      // through to the legacy `chat` path below.
    }
  }

  // Fallback path — legacy `chat` command (full Rust ReAct loop). Kept
  // unchanged so a stale build without `llm_oneshot` still works.
  const response = await invokeSafe<string>('chat', {
    req: {
      message,
      provider: opts.provider,
      model: opts.model,
    },
  });
  if (typeof response !== 'string') {
    throw new Error('chat returned no response');
  }
  console.info('[agentLoop] chat via chat (fallback)');
  return response;
};

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const PROTOCOL_INSTRUCTIONS = [
  '',
  'PROTOCOL',
  'On every turn you MUST reply with a single JSON object and NOTHING else.',
  'Use one of these two shapes:',
  '',
  '  { "action": "tool", "tool": "<name>", "input": { ... } }',
  '  { "action": "answer", "text": "<final response to the user>" }',
  '',
  'Rules:',
  '- Emit JSON only. No markdown fences, no commentary, no prose outside the object.',
  '- Prefer the smallest tool call that makes progress.',
  '- When you have enough information, reply with "answer".',
  '- Never invent tool names; use only those listed in AVAILABLE TOOLS.',
  '- Inputs must match the tool\'s JSON schema exactly.',
  '',
  'DELEGATION (you have a team, not just a tool belt)',
  'When a goal decomposes into INDEPENDENT sub-tasks, delegate instead of',
  'serialising them yourself. Each sub-agent gets its own ReAct loop, step',
  'budget, and transcript, and shows up in the ACTIVITY tab so the user',
  'can watch the fan-out.',
  '',
  'PREFERRED — spawn_parallel (one-call fan-out):',
  '  { "action": "tool", "tool": "spawn_parallel", "input": {',
  '      "goals": ["research topic A ...", "research topic B ...", ...],',
  '      "labels": ["research:A", "research:B", ...],   // optional',
  '      "wait": true,                                   // default true',
  '      "timeout_sec": 600                              // default 600',
  '  } }',
  'Returns per-child status + final answer in the same order as `goals`.',
  'Use this for ANY N-way fan-out: "audit deps in 8 repos", "research 5',
  '  topics", "summarise 12 conversations", "check 6 product URLs".',
  'Each child goal MUST be self-contained and MUST state the exact output',
  'format you need the child to return (e.g. "return EXACTLY: ID::... TITLE::...").',
  'Never send a child the raw collection; split it up first and give each',
  'child one item.',
  '',
  'When spawn_parallel is overkill:',
  '- Single child → spawn_subagent goal:"..." wait:true.',
  '- Fire-and-forget long-running helper → spawn_subagent goal:"..." wait:false,',
  '  then go back to your own work. Later collect with subagent_wait or',
  '  subagent_wait_all.',
  '- Already have ids (e.g. you spawned earlier and want to block now) →',
  '  subagent_wait_all ids:[...] timeout_sec:N. Cheaper than looping',
  '  subagent_wait one at a time.',
  '',
  'When NOT to delegate at all:',
  '- Tight tool chains where each call depends on the last (web_fetch then',
  '  memory_add — just do it).',
  '- Trivial work (one shell command, one calc).',
  '- Anything that needs your transcript for context — sub-agents start',
  '  fresh; you must restate every necessary fact in the `goal` string.',
  '',
  'Safety & budget:',
  '- Delegation depth is capped at 3. Grandchild-of-grandchild spawns are',
  '  refused — do that level of work yourself.',
  '- Concurrency is capped (default 4). Extra spawns queue; that\'s fine.',
  '- spawn_parallel with N>4 is still a single call — the first 4 run, the',
  '  rest wait their turn, and the tool\'s `timeout_sec` is the total wall',
  '  clock across the whole fan-out (not per child).',
  '- If the USER aborts this run, every child you spawned is aborted too',
  '  (cascade). So aborting mid-fan-out is clean.',
  '- Use subagent_list to see the fleet, subagent_abort to cancel anything',
  '  that went off the rails.',
].join('\n');

/**
 * Return type for buildSystemPrompt so the caller can surface budget-trim
 * events as visible insights (same channel as other routing decisions).
 */
export type BuiltPrompt = {
  readonly prompt: string;
  readonly budgetTrimmed: boolean;
  readonly trimNotes: ReadonlyArray<string>;
};

/**
 * Build the system prompt for a run. Composes:
 *   1. The rendered context pack (current state + memory) — provides identity,
 *      known facts, related past events, and learned skills.
 *   2. Any caveats the pre-run introspector attached ("keep this under 30s",
 *      "user has a meeting in 15 min", etc.).
 *   3. The ReAct JSON protocol description.
 *   4. The live tool registry with schemas.
 *
 * The pack is built once per run; the protocol / tools block is stable. This
 * keeps the per-turn prompt assembly cheap (one string concat + transcript
 * render) while still giving the model fresh, goal-matched memory every time.
 */
export function buildSystemPrompt(
  goal: string,
  pack: ContextPack | null,
  caveats: ReadonlyArray<string> = [],
  constitutionPrompt: string = '',
  role: RoleSpec | null = null,
): BuiltPrompt {
  const schemas = listToolSchemas();
  // When a role is active and its allowlist isn't universal, filter the
  // tool registry to only tools the role may invoke. The LLM therefore
  // literally can't propose a tool outside its remit — much stronger
  // than a runtime allowlist check alone. Generalist (`['*']`) sees
  // every tool.
  const allowed =
    role && !role.tools.includes('*')
      ? new Set(role.tools)
      : null;
  const filteredSchemas = allowed
    ? schemas.filter(s => allowed.has(s.name))
    : schemas;
  const toolBlock = filteredSchemas.length
    ? filteredSchemas
        .map(s => `- ${s.name}: ${s.description}\n  schema: ${JSON.stringify(s.input_schema)}`)
        .join('\n')
    : '(no tools registered)';

  // Memory pack is optional — if it fails to build we still want the agent to
  // run, just without the curated context. Every deployment after Phase 1 has
  // a working memory DB, but in tests / offline previews invokeSafe returns
  // null and the pack is omitted.
  let budgetTrimmed = false;
  let trimNotes: ReadonlyArray<string> = [];
  const contextBlock = pack
    ? (() => {
        const report = renderSystemPromptWithReport(pack, goal);
        budgetTrimmed = report.budgetTrimmed;
        trimNotes = report.trimNotes;
        return report.prompt;
      })()
    : `You are SUNNY — Sunny's personal assistant HUD running on his Mac.\n\nCURRENT GOAL\n${goal}`;

  const caveatBlock =
    caveats.length > 0
      ? ['', 'PRE-RUN CAVEATS (from introspector — honor these):', ...caveats.map(c => `- ${c}`)].join('\n')
      : '';

  const constitutionSection = constitutionPrompt
    ? `\n${constitutionPrompt}\n`
    : '';

  const roleSection = role && role.promptFragment
    ? `\nROLE: ${role.name.toUpperCase()}\n${role.promptFragment}\n`
    : '';

  const prompt = [
    contextBlock,
    constitutionSection,
    roleSection,
    caveatBlock,
    PROTOCOL_INSTRUCTIONS,
    '',
    'AVAILABLE TOOLS:',
    toolBlock,
  ]
    .filter(s => s !== '' || caveats.length === 0) // preserve blank separator when caveats exist
    .join('\n');

  return { prompt, budgetTrimmed, trimNotes };
}

export function buildTurnPrompt(
  systemPrompt: string,
  transcript: ReadonlyArray<import('./types').AgentStep>,
): string {
  const history = transcript
    .map(step => {
      switch (step.kind) {
        case 'tool_call':
          return `ASSISTANT ACTION: called ${step.toolName} with ${JSON.stringify(
            step.toolInput,
          )}`;
        case 'tool_result':
          return `TOOL RESULT (${step.toolName}, ok=${
            step.toolOutput?.ok ?? false
          }): ${step.toolOutput?.content ?? ''}`;
        case 'message':
        case 'plan':
          return `ASSISTANT: ${step.text}`;
        case 'error':
          return `ERROR: ${step.text}`;
      }
    })
    .join('\n');

  return [
    systemPrompt,
    '',
    history ? `TRANSCRIPT SO FAR:\n${history}` : 'TRANSCRIPT SO FAR: (empty)',
    '',
    'Respond with the next JSON object.',
  ].join('\n');
}
