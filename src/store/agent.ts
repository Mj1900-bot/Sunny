import { create } from 'zustand';

export type AgentRunStatus = 'idle' | 'running' | 'done' | 'aborted' | 'error';

export type PlanStepKind =
  | 'plan'
  | 'tool_call'
  | 'tool_result'
  | 'message'
  | 'error';

export type PlanStep = {
  readonly id: string;
  readonly kind: PlanStepKind;
  readonly text: string;
  readonly toolName?: string;
  readonly at: number;
  readonly durationMs?: number;
};

type AgentState = {
  readonly status: AgentRunStatus;
  readonly goal: string;
  readonly steps: ReadonlyArray<PlanStep>;
  readonly finalAnswer: string;
  readonly startedAt: number | null;
  readonly abortSignal: AbortSignal;
  readonly startRun: (goal: string) => void;
  readonly appendStep: (step: PlanStep) => void;
  readonly completeRun: (status: AgentRunStatus, finalAnswer: string) => void;
  readonly clearRun: () => void;
  readonly requestAbort: () => void;
};

// Controller lives outside the store so we can swap it atomically on each run
// without surfacing the mutable instance itself in state. The store exposes a
// live `abortSignal` reference that updates when `startRun` mints a new one.
let controller: AbortController = new AbortController();

export const useAgentStore = create<AgentState>((set, get) => ({
  status: 'idle',
  goal: '',
  steps: [],
  finalAnswer: '',
  startedAt: null,
  abortSignal: controller.signal,

  startRun: (goal: string) => {
    // Fresh controller so a prior abort() doesn't leak into the new run.
    controller = new AbortController();
    set({
      status: 'running',
      goal,
      steps: [],
      finalAnswer: '',
      startedAt: Date.now(),
      abortSignal: controller.signal,
    });
  },

  appendStep: (step: PlanStep) => {
    // Immutable append — always a new array reference so subscribers re-render.
    set(state => ({ steps: [...state.steps, step] }));
  },

  completeRun: (status: AgentRunStatus, finalAnswer: string) => {
    // Only transition out of the running phase. Ignore late completions
    // that arrive after the user already cleared / restarted.
    const current = get().status;
    if (current !== 'running') return;
    set({ status, finalAnswer });
  },

  clearRun: () => {
    // Mint a fresh, un-aborted controller so the next run starts clean even
    // if the caller forgets to invoke startRun before subscribing elsewhere.
    controller = new AbortController();
    set({
      status: 'idle',
      goal: '',
      steps: [],
      finalAnswer: '',
      startedAt: null,
      abortSignal: controller.signal,
    });
  },

  requestAbort: () => {
    if (get().status !== 'running') return;
    controller.abort();
    // Status flips immediately so UI reflects user intent even if the
    // downstream runAgent loop takes a tick to observe the signal.
    set({ status: 'aborted' });
  },
}));
