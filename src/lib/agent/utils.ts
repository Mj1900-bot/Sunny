// ---------------------------------------------------------------------------
// Step helpers and AbortSignal bridging.
// ---------------------------------------------------------------------------

import { reflectOnRun, type ReflectionStatus } from '../reflect';
import type { AgentStep } from './types';

// ---------------------------------------------------------------------------
// Step ID generation
// ---------------------------------------------------------------------------

let stepCounter = 0;
export function nextStepId(): string {
  stepCounter += 1;
  return `step_${Date.now().toString(36)}_${stepCounter}`;
}

// ---------------------------------------------------------------------------
// Step emission — calls the onStep listener, swallowing any throw so a
// misbehaving listener never crashes the loop.
// ---------------------------------------------------------------------------

export function emit(step: AgentStep, onStep?: (s: AgentStep) => void): AgentStep {
  try {
    onStep?.(step);
  } catch (err) {
    // A misbehaving listener must never crash the loop.
    console.error('onStep listener threw:', err);
  }
  return step;
}

// ---------------------------------------------------------------------------
// Reflection — fire-and-forget. The user's answer is already rendered;
// reflection is for future runs and should never delay `runAgent`'s return.
// ---------------------------------------------------------------------------

/**
 * Fire a reflection pass after a terminal run state. Deliberately not
 * awaited — any failure is swallowed at the reflectOnRun level; this
 * `.catch` is belt-and-braces.
 */
export function fireReflection(
  goal: string,
  steps: ReadonlyArray<AgentStep>,
  finalAnswer: string,
  status: ReflectionStatus,
): void {
  void reflectOnRun({ goal, steps, finalAnswer, status }).catch(err => {
    console.debug('[agentLoop] reflection failed:', err);
  });
}

// ---------------------------------------------------------------------------
// AbortSignal bridging (works on older runtimes without AbortSignal.any)
// ---------------------------------------------------------------------------

export type LinkedSignal = {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
};

export function linkSignal(parent: AbortSignal | undefined): LinkedSignal {
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
