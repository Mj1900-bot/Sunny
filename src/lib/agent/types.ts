// ---------------------------------------------------------------------------
// Public types shared across the agent module.
// ---------------------------------------------------------------------------

import type { ToolResult } from '../tools';

export type AgentStep = {
  readonly id: string;
  readonly kind: 'plan' | 'tool_call' | 'tool_result' | 'message' | 'error';
  readonly text: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolOutput?: ToolResult;
  readonly at: number;
};

export type ChatFn = (
  message: string,
  opts: { provider?: string; model?: string; signal?: AbortSignal },
) => Promise<string>;

export type AgentRunOptions = {
  readonly goal: string;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
  readonly onStep?: (step: AgentStep) => void;
  // Optional override so tests / future ConfirmGate can inject a chat backend.
  readonly chat?: ChatFn;
  // Optional hook for a future ConfirmGate — if provided, the loop will call
  // this before running a tool whose schema has `dangerous: true`. Returning
  // `false` cancels the call; returning `true` allows it.
  readonly confirmDangerous?: (
    toolName: string,
    toolInput: unknown,
  ) => Promise<boolean> | boolean;
  // Suppresses HTN decomposition for this run. Set by the planner when it
  // spawns sub-runs so a sub-goal can't re-decompose into further splits.
  readonly isSubGoal?: boolean;
  // Delegation plumbing: the label + depth of the parent that spawned
  // this run. The delegation tools use these values (via the signal
  // WeakMap in `tools/builtins/delegation.ts`) to tag further spawns
  // and enforce MAX_DEPTH. Roots leave both undefined.
  readonly parent?: string;
  readonly depth?: number;
  // Optional session identifier. When provided, the clarify-continuation
  // bridge scopes pending-clarify state to this session so overlapping
  // chat+voice sessions don't cross-contaminate. Omitted → treated as the
  // single shared default session (fine for the single-user HUD today).
  readonly sessionId?: string;
};

export type AgentRunResult = {
  readonly steps: ReadonlyArray<AgentStep>;
  readonly finalAnswer: string;
  readonly status: 'done' | 'aborted' | 'max_steps' | 'error';
};
