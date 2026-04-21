// Claude tool_use-native agent runner (EXPERIMENTAL).
//
// This module is a sibling to `agentLoop.ts`. It produces the SAME
// `AgentStep` shape so consumers are interchangeable, but drives the model
// using Anthropic's structured `tool_use` / `tool_result` protocol rather
// than the prompt-engineered JSON protocol used by `runAgent`.
//
// Current UI wiring: the UI still uses `runAgent` from `agentLoop.ts`. This
// runner is shipped standalone so callers can opt-in once the Tauri backend
// exposes a true Anthropic-format messages endpoint (tentatively named
// `anthropic_messages`). Until then we emulate the protocol on top of the
// existing `chat` Tauri command by:
//
//   1. Sending a system prompt that describes the Anthropic tool_use JSON
//      shape and the tools the model may call.
//   2. Appending the running transcript as a single flattened user turn
//      (because `chat` only accepts a single `message` string).
//   3. Parsing the model's text reply for Anthropic-style tool_use blocks —
//      either as ```tool_use fenced blocks or as raw JSON objects with
//      `"type":"tool_use"`. Any text outside those blocks is treated as the
//      assistant's visible reasoning / final answer.
//
// Once the Rust side grows a real `anthropic_messages` command that returns
// a native `ClaudeResponse`, only `claudeComplete` needs to change.

import { invokeSafe } from './tauri';
import {
  listToolSchemas,
  runTool,
  TOOLS,
  type ToolResult,
  type ToolSchema,
} from './tools';
import type { AgentStep, AgentRunOptions } from './agentLoop';

// ---------------------------------------------------------------------------
// Anthropic-shaped protocol types (self-contained, no SDK dependency)
// ---------------------------------------------------------------------------

type TextBlock = { readonly type: 'text'; readonly text: string };
type ToolUseBlock = {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};
export type ContentBlock = TextBlock | ToolUseBlock;

export type ToolResultBlock = {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
};

export type ClaudeMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | ReadonlyArray<ContentBlock> }
  | { readonly role: 'user'; readonly content: ReadonlyArray<ToolResultBlock> };

export type ClaudeTool = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
};

export type ClaudeStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence';

export type ClaudeResponse = {
  readonly stop_reason: ClaudeStopReason;
  readonly content: ReadonlyArray<ContentBlock>;
};

// ---------------------------------------------------------------------------
// Public result type — identical shape to `AgentRunResult` in agentLoop.ts
// ---------------------------------------------------------------------------

export type ClaudeAgentResult = {
  readonly steps: ReadonlyArray<AgentStep>;
  readonly finalAnswer: string;
  readonly status: 'done' | 'aborted' | 'max_steps' | 'error';
};

// ---------------------------------------------------------------------------
// Settings (shared key with agentLoop.ts)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'sunny.settings.v1';

type InferredSettings = {
  readonly provider?: string;
  readonly model?: string;
};

function readSettings(): InferredSettings {
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
// Prompt assembly
// ---------------------------------------------------------------------------

const PROTOCOL_INSTRUCTIONS = [
  'You are SUNNY, an assistant that can call tools to accomplish the user\'s goal.',
  '',
  'Use the Anthropic tool_use protocol. On every turn you may return zero or',
  'more text blocks and zero or more tool_use blocks. When calling a tool,',
  'emit a fenced code block exactly like this:',
  '',
  '```tool_use',
  '{"type":"tool_use","id":"<unique id>","name":"<tool name>","input":{...}}',
  '```',
  '',
  'Rules:',
  '- One tool_use block per fenced ```tool_use region.',
  '- `id` must be unique within the turn (e.g. "tu_1", "tu_2").',
  '- `input` must validate against the tool\'s JSON schema.',
  '- Only use tools listed under AVAILABLE TOOLS below.',
  '- When you have enough information, reply with only plain text (no tool_use block) — that text becomes the final answer.',
].join('\n');

function formatTools(tools: ReadonlyArray<ToolSchema>): string {
  if (tools.length === 0) return '(no tools registered)';
  return tools
    .map(
      t =>
        `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.input_schema)}`,
    )
    .join('\n');
}

function buildSystemPrompt(tools: ReadonlyArray<ClaudeTool>): string {
  return `${PROTOCOL_INSTRUCTIONS}\n\nAVAILABLE TOOLS:\n${formatTools(tools)}`;
}

// Serialise the running conversation into a single string the legacy `chat`
// command can accept. When a native anthropic_messages command lands this
// flattening step goes away — we'll pass `messages` straight through.
function flattenMessagesForLegacyChat(
  messages: ReadonlyArray<ClaudeMessage>,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      lines.push(`SYSTEM:\n${msg.content}`);
      continue;
    }
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        lines.push(`USER:\n${msg.content}`);
      } else {
        const rendered = msg.content
          .map(
            b =>
              `tool_result(${b.tool_use_id})${b.is_error ? ' [error]' : ''}: ${b.content}`,
          )
          .join('\n');
        lines.push(`USER (tool results):\n${rendered}`);
      }
      continue;
    }
    // assistant
    if (typeof msg.content === 'string') {
      lines.push(`ASSISTANT:\n${msg.content}`);
    } else {
      const rendered = msg.content
        .map(b => {
          if (b.type === 'text') return b.text;
          return [
            '```tool_use',
            JSON.stringify({ type: 'tool_use', id: b.id, name: b.name, input: b.input }),
            '```',
          ].join('\n');
        })
        .join('\n');
      lines.push(`ASSISTANT:\n${rendered}`);
    }
  }
  lines.push('Respond with the next assistant turn.');
  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Parsing — extract text + tool_use blocks from a plain-text chat response
// ---------------------------------------------------------------------------

const FENCE_REGEX = /```tool_use\s*([\s\S]*?)```/gi;

function tryParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isToolUseObject(value: unknown): value is {
  type: 'tool_use';
  id?: unknown;
  name: unknown;
  input?: unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'tool_use' &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

// Walk a string and yield the largest balanced {…} substrings (same approach
// as agentLoop.ts's salvage pass).
function* balancedJsonObjects(source: string): Generator<string> {
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < source.length; j += 1) {
      const ch = source[j];
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
          yield source.slice(i, j + 1);
          i = j;
          break;
        }
      }
    }
  }
}

let fallbackToolIdCounter = 0;
function nextFallbackToolId(): string {
  fallbackToolIdCounter += 1;
  return `tu_auto_${Date.now().toString(36)}_${fallbackToolIdCounter}`;
}

function toToolUseBlock(value: unknown): ToolUseBlock | null {
  if (!isToolUseObject(value)) return null;
  const id =
    typeof value.id === 'string' && value.id.length > 0
      ? value.id
      : nextFallbackToolId();
  return {
    type: 'tool_use',
    id,
    name: value.name as string,
    input: value.input ?? {},
  };
}

// Parse a plain-text chat response into Anthropic-style content blocks.
// Strategy:
//   1. Extract every ```tool_use JSON ``` fenced block.
//   2. Also scan remaining text for raw JSON objects that look like tool_use.
//   3. Whatever text is left (after removing the fenced blocks) becomes one
//      text block.
function parseTextToBlocks(raw: string): {
  blocks: ContentBlock[];
  stopReason: ClaudeStopReason;
} {
  const blocks: ContentBlock[] = [];
  const seenToolUse: ToolUseBlock[] = [];

  // 1. Fenced blocks.
  let textRemainder = raw;
  const fenced = Array.from(raw.matchAll(FENCE_REGEX));
  for (const match of fenced) {
    const body = match[1]?.trim();
    if (!body) continue;
    const parsed = tryParse(body);
    const block = toToolUseBlock(parsed);
    if (block) seenToolUse.push(block);
  }
  textRemainder = textRemainder.replace(FENCE_REGEX, '').trim();

  // 2. Raw JSON objects with type=tool_use in the remaining text.
  if (textRemainder.length > 0 && textRemainder.includes('"tool_use"')) {
    for (const candidate of balancedJsonObjects(textRemainder)) {
      const parsed = tryParse(candidate);
      const block = toToolUseBlock(parsed);
      if (block) {
        seenToolUse.push(block);
        textRemainder = textRemainder.replace(candidate, '').trim();
      }
    }
  }

  // 3. Preserve any residual text as a single text block.
  if (textRemainder.length > 0) {
    blocks.push({ type: 'text', text: textRemainder });
  }
  for (const t of seenToolUse) blocks.push(t);

  // If no blocks at all, represent the raw response as text so the loop can
  // terminate cleanly.
  if (blocks.length === 0 && raw.length > 0) {
    blocks.push({ type: 'text', text: raw.trim() });
  }

  const stopReason: ClaudeStopReason =
    seenToolUse.length > 0 ? 'tool_use' : 'end_turn';
  return { blocks, stopReason };
}

// ---------------------------------------------------------------------------
// Network — currently stubbed on top of the legacy `chat` command
// ---------------------------------------------------------------------------

async function claudeComplete(
  messages: ReadonlyArray<ClaudeMessage>,
  _tools: ReadonlyArray<ClaudeTool>,
  signal: AbortSignal,
): Promise<ClaudeResponse> {
  if (signal.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
  const settings = readSettings();
  const prompt = flattenMessagesForLegacyChat(messages);

  const response = await invokeSafe<string>('chat', {
    req: {
      message: prompt,
      provider: settings.provider,
      model: settings.model,
    },
  });
  if (typeof response !== 'string') {
    throw new Error('chat command returned no response');
  }
  if (signal.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
  const { blocks, stopReason } = parseTextToBlocks(response);
  return { stop_reason: stopReason, content: blocks };
}

// ---------------------------------------------------------------------------
// AbortSignal bridging (copy of agentLoop.ts helper — keeps this file
// standalone and avoids cross-module coupling)
// ---------------------------------------------------------------------------

type LinkedSignal = {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
};

function linkSignal(parent: AbortSignal | undefined): LinkedSignal {
  const controller = new AbortController();
  if (!parent) {
    return { signal: controller.signal, dispose: () => undefined };
  }
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
// Step helpers
// ---------------------------------------------------------------------------

let stepCounter = 0;
function nextStepId(): string {
  stepCounter += 1;
  return `cstep_${Date.now().toString(36)}_${stepCounter}`;
}

function emit(step: AgentStep, onStep?: (s: AgentStep) => void): AgentStep {
  try {
    onStep?.(step);
  } catch (err) {
    console.error('onStep listener threw:', err);
  }
  return step;
}

// ---------------------------------------------------------------------------
// Public entrypoint
//
// EXPERIMENTAL — not yet wired into the UI. Use `runAgent` from
// `./agentLoop.ts` for anything user-facing. This runner exists so we can
// switch to Anthropic's native tool_use protocol once the Rust backend
// exposes a real `anthropic_messages` command. Until then it emulates the
// protocol on top of the same single-message `chat` IPC.
// ---------------------------------------------------------------------------

export async function runAgentClaude(
  opts: AgentRunOptions,
): Promise<ClaudeAgentResult> {
  const maxSteps = opts.maxSteps ?? 12;
  const parentSignal = opts.signal;

  const tools: ReadonlyArray<ClaudeTool> = listToolSchemas().map(s => ({
    name: s.name,
    description: s.description,
    input_schema: s.input_schema,
  }));

  const systemPrompt = buildSystemPrompt(tools);

  const messages: ClaudeMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: opts.goal },
  ];

  const steps: AgentStep[] = [];

  const abortedResult = (): ClaudeAgentResult => ({
    steps,
    finalAnswer: 'Run aborted before completion.',
    status: 'aborted',
  });

  if (parentSignal?.aborted) return abortedResult();

  for (let iter = 0; iter < maxSteps; iter += 1) {
    if (parentSignal?.aborted) return abortedResult();

    let response: ClaudeResponse;
    try {
      const requestSignal = linkSignal(parentSignal);
      try {
        response = await claudeComplete(messages, tools, requestSignal.signal);
      } finally {
        requestSignal.dispose();
      }
    } catch (err) {
      if (parentSignal?.aborted) return abortedResult();
      const message = err instanceof Error ? err.message : String(err);
      steps.push(
        emit(
          {
            id: nextStepId(),
            kind: 'error',
            text: `claudeComplete failed: ${message}`,
            at: Date.now(),
          },
          opts.onStep,
        ),
      );
      return {
        steps,
        finalAnswer: `I hit an error talking to the model: ${message}`,
        status: 'error',
      };
    }

    if (parentSignal?.aborted) return abortedResult();

    // Record assistant turn into the running message list so subsequent calls
    // see the full conversation state.
    messages.push({ role: 'assistant', content: response.content });

    // Emit text blocks as `message`/`plan` steps, and tool_use blocks as
    // `tool_call` + run them.
    const toolUses: ToolUseBlock[] = [];
    const textParts: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        const text = block.text.trim();
        if (text.length > 0) textParts.push(text);
      } else {
        toolUses.push(block);
      }
    }

    if (textParts.length > 0) {
      const kind: AgentStep['kind'] = toolUses.length > 0 ? 'plan' : 'message';
      steps.push(
        emit(
          {
            id: nextStepId(),
            kind,
            text: textParts.join('\n\n'),
            at: Date.now(),
          },
          opts.onStep,
        ),
      );
    }

    // No tool calls requested → we're done.
    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      const finalAnswer =
        textParts.join('\n\n').trim() ||
        '(model returned no text)';
      return { steps, finalAnswer, status: 'done' };
    }

    // Run each tool call sequentially, collecting tool_result blocks to send
    // back in the next turn.
    const toolResultBlocks: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      if (parentSignal?.aborted) return abortedResult();

      steps.push(
        emit(
          {
            id: nextStepId(),
            kind: 'tool_call',
            text: `calling ${tu.name}`,
            toolName: tu.name,
            toolInput: tu.input,
            at: Date.now(),
          },
          opts.onStep,
        ),
      );

      const tool = TOOLS.get(tu.name);
      if (!tool) {
        const errResult: ToolResult = {
          ok: false,
          content: `Unknown tool "${tu.name}". Available: ${Array.from(
            TOOLS.keys(),
          ).join(', ')}`,
          latency_ms: 0,
        };
        steps.push(
          emit(
            {
              id: nextStepId(),
              kind: 'tool_result',
              text: errResult.content,
              toolName: tu.name,
              toolInput: tu.input,
              toolOutput: errResult,
              at: Date.now(),
            },
            opts.onStep,
          ),
        );
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: errResult.content,
          is_error: true,
        });
        continue;
      }

      if (tool.dangerous && opts.confirmDangerous) {
        const allowed = await Promise.resolve(
          opts.confirmDangerous(tu.name, tu.input),
        );
        if (!allowed) {
          const declined: ToolResult = {
            ok: false,
            content: `User declined dangerous tool "${tu.name}".`,
            latency_ms: 0,
          };
          steps.push(
            emit(
              {
                id: nextStepId(),
                kind: 'tool_result',
                text: declined.content,
                toolName: tu.name,
                toolInput: tu.input,
                toolOutput: declined,
                at: Date.now(),
              },
              opts.onStep,
            ),
          );
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: declined.content,
            is_error: true,
          });
          continue;
        }
      }

      const toolSignal = linkSignal(parentSignal);
      let result: ToolResult;
      try {
        result = await runTool(tu.name, tu.input, toolSignal.signal);
      } finally {
        toolSignal.dispose();
      }

      steps.push(
        emit(
          {
            id: nextStepId(),
            kind: 'tool_result',
            text: result.content,
            toolName: tu.name,
            toolInput: tu.input,
            toolOutput: result,
            at: Date.now(),
          },
          opts.onStep,
        ),
      );

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.content,
        is_error: !result.ok,
      });

      if (parentSignal?.aborted) return abortedResult();
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  const fallback = 'Reached the maximum number of steps without a final answer.';
  steps.push(
    emit(
      {
        id: nextStepId(),
        kind: 'error',
        text: fallback,
        at: Date.now(),
      },
      opts.onStep,
    ),
  );
  return { steps, finalAnswer: fallback, status: 'max_steps' };
}
