// subAgentsLive — projection facade over the unified `useSubAgents` store.
//
// Historically this was a second, event-sourced store mirroring Rust
// `sunny://agent.sub` events. That created two sources of truth: Rust
// sub-agents landed here, TS-spawned runs (daemons, delegation, planner)
// landed in `subAgents.ts`, and the UI surfaces that consumed each store
// disagreed about what was running.
//
// Now both sources merge into the single `useSubAgents` store. This file
// exposes the same type and hook surface the old store did (so consumers
// like AgentsPanel / SocietyPage / AutoTaskPanel / useSubAgentsBridge are
// source-compatible) but the data is a live projection of the canonical
// store — TS and Rust runs alike are visible.

import { create } from 'zustand';
import {
  useSubAgents,
  type SubAgentRun,
  type SubAgentStatus as CanonicalStatus,
  type SubAgentStep as CanonicalStep,
} from './subAgents';

// ---------------------------------------------------------------------------
// Public types — preserved verbatim so existing consumers keep compiling.
// ---------------------------------------------------------------------------

export type SubAgentRole =
  | 'researcher'
  | 'coder'
  | 'writer'
  | 'browser_driver'
  | 'planner'
  | 'summarizer'
  | 'critic'
  | 'unknown';

export type SubAgentStatus = 'running' | 'done' | 'error';

export type SubAgentStepKind =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'error';

export type SubAgentStep = {
  readonly at: number;
  readonly kind: SubAgentStepKind;
  readonly text: string;
  readonly toolName?: string;
};

export type SubAgent = {
  readonly id: string;
  readonly role: SubAgentRole;
  readonly task: string;
  readonly model: string;
  readonly parentId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly status: SubAgentStatus;
  readonly answer?: string;
  readonly error?: string;
  readonly steps: ReadonlyArray<SubAgentStep>;
  readonly toolCallCount: number;
  readonly tokenEstimate: number;
};

export type StartPayload = {
  readonly id: string;
  readonly role: SubAgentRole;
  readonly task: string;
  readonly model: string;
  readonly parentId: string | null;
};

type LiveState = {
  readonly subAgents: Readonly<Record<string, SubAgent>>;
  readonly order: ReadonlyArray<string>;
  readonly start: (payload: StartPayload) => void;
  readonly step: (id: string, step: SubAgentStep) => void;
  readonly done: (id: string, answer: string) => void;
  readonly error: (id: string, message: string) => void;
  readonly clear: (olderThanMs?: number) => void;
};

// ---------------------------------------------------------------------------
// Projection — canonical run → SubAgent
// ---------------------------------------------------------------------------

const ROLE_VALUES: ReadonlySet<SubAgentRole> = new Set<SubAgentRole>([
  'researcher',
  'coder',
  'writer',
  'browser_driver',
  'planner',
  'summarizer',
  'critic',
  'unknown',
]);

const STEP_KIND_VALUES: ReadonlySet<SubAgentStepKind> = new Set<SubAgentStepKind>([
  'thinking',
  'tool_call',
  'tool_result',
  'error',
]);

const DEFAULT_CLEAR_AGE_MS = 5 * 60 * 1000;
const CHARS_PER_TOKEN = 4;

function narrowRole(raw: string | undefined): SubAgentRole {
  if (!raw) return 'unknown';
  return ROLE_VALUES.has(raw as SubAgentRole)
    ? (raw as SubAgentRole)
    : 'unknown';
}

function narrowStepKind(raw: string): SubAgentStepKind {
  return STEP_KIND_VALUES.has(raw as SubAgentStepKind)
    ? (raw as SubAgentStepKind)
    : 'thinking';
}

function narrowStatus(raw: CanonicalStatus): SubAgentStatus {
  if (raw === 'done') return 'done';
  if (raw === 'error' || raw === 'aborted' || raw === 'max_steps') return 'error';
  return 'running';
}

function projectStep(raw: CanonicalStep): SubAgentStep {
  return {
    at: raw.at,
    kind: narrowStepKind(raw.kind),
    text: raw.text,
    toolName: raw.toolName,
  };
}

function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
}

function projectRun(run: SubAgentRun): SubAgent {
  const steps = run.steps.map(projectStep);
  const role = narrowRole(run.role);
  // TS runs don't track tool calls / tokens natively — derive cheaply.
  const toolCallCount =
    run.toolCallCount ??
    steps.reduce(
      (acc, s) => (s.kind === 'tool_call' ? acc + 1 : acc),
      0,
    );
  const tokenEstimate =
    run.tokenEstimate ??
    estimateTokensFromChars(
      steps.reduce((acc, s) => acc + s.text.length, 0),
    );
  // SubAgent.startedAt is number, not nullable. Fall back to createdAt for
  // still-queued TS runs so the card renders with a sensible duration.
  const startedAt = run.startedAt ?? run.createdAt;
  const answer =
    run.status === 'done'
      ? run.finalAnswer || undefined
      : undefined;
  const errorText = run.error ?? (run.status === 'error' ? run.finalAnswer || undefined : undefined);
  return {
    id: run.id,
    role,
    task: run.goal,
    model: run.model ?? 'sunny',
    parentId: run.parent,
    startedAt,
    endedAt: run.endedAt,
    status: narrowStatus(run.status),
    answer,
    error: errorText,
    steps,
    toolCallCount,
    tokenEstimate,
  };
}

function projectAll(runs: ReadonlyArray<SubAgentRun>): {
  readonly subAgents: Record<string, SubAgent>;
  readonly order: ReadonlyArray<string>;
} {
  const subAgents: Record<string, SubAgent> = {};
  const order: string[] = [];
  for (const run of runs) {
    subAgents[run.id] = projectRun(run);
    order.push(run.id);
  }
  return { subAgents, order };
}

// ---------------------------------------------------------------------------
// Mutation adapters — Rust bridge → canonical store
// ---------------------------------------------------------------------------

function adaptStart(payload: StartPayload): void {
  useSubAgents.getState()._rustStart({
    id: payload.id,
    role: payload.role,
    task: payload.task,
    model: payload.model,
    parentId: payload.parentId,
  });
}

function adaptStep(id: string, step: SubAgentStep): void {
  useSubAgents.getState()._rustStep(id, {
    kind: step.kind,
    text: step.text,
    toolName: step.toolName,
    at: step.at,
  });
}

function adaptDone(id: string, answer: string): void {
  useSubAgents.getState()._rustDone(id, answer);
}

function adaptError(id: string, message: string): void {
  useSubAgents.getState()._rustError(id, message);
}

function adaptClear(olderThanMs: number = DEFAULT_CLEAR_AGE_MS): void {
  useSubAgents.getState()._rustClear(olderThanMs);
}

// ---------------------------------------------------------------------------
// Store — subscribes to the canonical store and re-projects on change.
// ---------------------------------------------------------------------------

const initial = projectAll(useSubAgents.getState().runs);

export const useSubAgentsLive = create<LiveState>(set => {
  // Mirror canonical runs into the projected shape on every change. We diff
  // against the *runs* array reference so we skip re-projection when the
  // canonical store changed maxConcurrent / inFlightDaemons only.
  let lastRuns = useSubAgents.getState().runs;
  useSubAgents.subscribe(state => {
    if (state.runs === lastRuns) return;
    lastRuns = state.runs;
    const { subAgents, order } = projectAll(state.runs);
    set({ subAgents, order });
  });

  return {
    subAgents: initial.subAgents,
    order: initial.order,
    start: adaptStart,
    step: adaptStep,
    done: adaptDone,
    error: adaptError,
    clear: adaptClear,
  };
});
