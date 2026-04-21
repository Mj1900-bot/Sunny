// ---------------------------------------------------------------------------
// Agent loop orchestrator — plan → call tools → observe → repeat.
//
// Talks to whichever LLM provider the user has configured via the existing
// Tauri `stream_chat` command (we invoke through invokeSafe so we degrade
// gracefully outside the Tauri runtime). The loop is pure TS and does not
// import React; it reads settings straight from localStorage (the same key
// written by src/store/view.ts) so callers can drive it from any context.
//
// The first iteration uses a prompt-engineered JSON protocol because our
// providers don't all support Anthropic-style structured tool_use yet:
//
//   System: "here are your tools + a JSON protocol"
//   Model : '{"action":"tool","tool":"fs_list","input":{"path":"/x"}}'
//   Loop  : runs the tool, appends result, asks again
//   Model : '{"action":"answer","text":"Here is what I found…"}'
//
// When the model returns non-JSON we attempt one regex-based salvage pass;
// if that also fails we treat the raw text as the final answer.
// ---------------------------------------------------------------------------

// Re-export public API types so existing callers can keep their import paths.
export type { AgentStep, AgentRunOptions, AgentRunResult, ChatFn } from './types';

import { invokeSafe } from '../tauri';
import { runTool, TOOLS } from '../tools';
import {
  registerRunContext,
  clearRunContext,
} from '../tools/builtins/delegation';
import { buildContextPack, type ContextPack } from '../contextPack';
import { introspectGoal } from '../introspect';
import {
  loadAndRenderConstitution,
  gateToolCall,
  parseConstitutionValues,
  verifyAnswer,
  CONSTITUTION_BLOCK_REPLY,
} from '../constitution';
import { reviewDangerousAction } from '../critic';
import { pushInsight } from '../../store/insights';
import { maybeDecompose } from '../planner';

import type { AgentStep, AgentRunOptions, AgentRunResult } from './types';
import {
  savePendingClarify,
  consumePendingClarify,
  peekPendingClarifyForTests,
  clearPendingClarifiesForTests,
  CLARIFY_TTL_MS,
} from './clarify';
import { readSettings, defaultChat, buildSystemPrompt, buildTurnPrompt } from './context';
import { parseModelResponse, reconstructToolCalls } from './parse';
import { nextStepId, emit, fireReflection, linkSignal } from './utils';
import { runSkillRouter, runSocietyDispatch } from './routing';

// ---------------------------------------------------------------------------
// HTN decomposition runner
// ---------------------------------------------------------------------------

/**
 * Execute an HTN decomposition: run each sub-goal as its own `runAgent`
 * call sequentially, collect answers, and compose a parent reply. Each
 * sub-run inherits the parent's signal, onStep callback, and confirm
 * handler, but is flagged `isSubGoal: true` so the decomposer doesn't
 * re-fire recursively.
 *
 * Execution semantics:
 *   - SEQUENTIAL — later sub-goals can reference earlier context (memory
 *     already has the earlier run's episodic writes by the time the next
 *     call builds its context pack).
 *   - Aborts on the first failed sub-goal (not `done`) — continuing past
 *     a failure would often compound the error (e.g. "send email" fails,
 *     then "summarize what was sent" has nothing real to summarize).
 *   - Step events from sub-runs flow to the parent's `onStep` so the UI
 *     shows a unified timeline — no special nesting UI required.
 */
async function runDecomposed(
  opts: AgentRunOptions,
  parentSteps: AgentStep[],
  decomp: { subgoals: ReadonlyArray<string>; rationale: string | null },
): Promise<AgentRunResult> {
  const allSteps: AgentStep[] = [...parentSteps];

  const planStep: AgentStep = {
    id: nextStepId(),
    kind: 'plan',
    text: `Decomposed into ${decomp.subgoals.length} sub-goal${decomp.subgoals.length === 1 ? '' : 's'}${
      decomp.rationale ? ` — ${decomp.rationale}` : ''
    }:\n${decomp.subgoals.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
    at: Date.now(),
  };
  allSteps.push(emit(planStep, opts.onStep));

  pushInsight(
    'introspect_caveat',
    'Split into sub-goals',
    `${decomp.subgoals.length} parts: ${decomp.subgoals.slice(0, 3).join(' · ')}${decomp.subgoals.length > 3 ? ' …' : ''}`,
    { goal: opts.goal, subgoals: decomp.subgoals, rationale: decomp.rationale },
  );

  const perSubAnswers: string[] = [];
  for (let i = 0; i < decomp.subgoals.length; i += 1) {
    if (opts.signal?.aborted) {
      return {
        steps: allSteps,
        finalAnswer: 'Decomposed run aborted before completion.',
        status: 'aborted',
      };
    }
    const sub = decomp.subgoals[i];
    const header: AgentStep = {
      id: nextStepId(),
      kind: 'plan',
      text: `sub-goal ${i + 1}/${decomp.subgoals.length}: ${sub}`,
      at: Date.now(),
    };
    allSteps.push(emit(header, opts.onStep));

    const child = await runAgent({
      goal: sub,
      signal: opts.signal,
      onStep: opts.onStep,
      chat: opts.chat,
      confirmDangerous: opts.confirmDangerous,
      maxSteps: opts.maxSteps,
      isSubGoal: true,
      parent: opts.parent,
      depth: opts.depth,
    });
    for (const s of child.steps) allSteps.push(s);

    if (child.status !== 'done') {
      const bailed = `sub-goal "${sub}" ended with status=${child.status}: ${child.finalAnswer}`;
      return {
        steps: allSteps,
        finalAnswer: `Stopped after the first failing sub-goal.\n\n${bailed}`,
        status: child.status,
      };
    }
    perSubAnswers.push(child.finalAnswer);
  }

  const composed = decomp.subgoals
    .map((sub, i) => `**${i + 1}. ${sub}**\n${perSubAnswers[i] ?? ''}`)
    .join('\n\n');

  const finalStep: AgentStep = {
    id: nextStepId(),
    kind: 'message',
    text: composed,
    at: Date.now(),
  };
  allSteps.push(emit(finalStep, opts.onStep));

  void invokeSafe('memory_episodic_add', {
    kind: 'agent_step',
    text: `goal: ${opts.goal}\nanswer: ${composed.slice(0, 400)}`,
    tags: ['run', 'done', 'decomposed'],
    meta: {
      steps: allSteps.length,
      system: 'htn',
      subgoals: decomp.subgoals,
      ts: Date.now(),
    },
  });
  fireReflection(opts.goal, allSteps, composed, 'done');
  return { steps: allSteps, finalAnswer: composed, status: 'done' };
}

// ---------------------------------------------------------------------------
// The main loop
// ---------------------------------------------------------------------------

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  // --------------------------------------------------------------------
  // Clarify continuation: if the PREVIOUS turn on this session ended with
  // a clarify question, merge the user's new message into a composite goal
  // that preserves the original intent. Done BEFORE buildContextPack so
  // memory retrieval ranks against the full question.
  // --------------------------------------------------------------------
  const pending = consumePendingClarify(opts.sessionId);
  const rawUserAnswer = opts.goal;
  const prependedNewMessage = pending
    ? `Earlier I asked: ${pending.clarifyingQuestion}. Now answering: ${rawUserAnswer}`
    : rawUserAnswer;
  const effectiveOpts: AgentRunOptions = pending
    ? {
        ...opts,
        goal:
          `${pending.originalGoal}\n\n` +
          `Clarification from user: ${prependedNewMessage}`,
      }
    : opts;
  const justResumedClarify = pending !== null;

  // Shadow `opts` with the merged version so all downstream references
  // transparently see the continuation without per-call site edits.
  opts = effectiveOpts;

  const maxSteps = opts.maxSteps ?? 12;
  const signal = opts.signal;
  const chat = opts.chat ?? defaultChat;
  const settings = readSettings();

  // Stable parent-signal for the cancel cascade.
  const parentSignal = signal ?? new AbortController().signal;

  const steps: AgentStep[] = [];

  const abortedResult = (): AgentRunResult => ({
    steps,
    finalAnswer: 'Run aborted before completion.',
    status: 'aborted',
  });

  if (signal?.aborted) return abortedResult();

  // Surface the clarify resume in the transcript.
  if (pending) {
    const resumeStep: AgentStep = {
      id: nextStepId(),
      kind: 'plan',
      text:
        `Resuming earlier clarify. Question I asked: "${pending.clarifyingQuestion}"\n` +
        `User answered: "${rawUserAnswer}"\n` +
        `Merged goal now in play.`,
      at: Date.now(),
    };
    steps.push(emit(resumeStep, opts.onStep));
    pushInsight(
      'introspect_caveat',
      'Resumed clarify continuation',
      `"${pending.clarifyingQuestion}" → continuing with merged goal`,
      {
        originalGoal: pending.originalGoal,
        question: pending.clarifyingQuestion,
        sessionId: pending.sessionId,
      },
    );
  }

  // Build the context pack once per run.
  let contextPack: ContextPack | null = null;
  try {
    contextPack = await buildContextPack({ goal: opts.goal, signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return abortedResult();
    console.warn('[agentLoop] contextPack build failed:', err);
  }
  if (signal?.aborted) return abortedResult();

  // Record the user's goal as an episodic event.
  void invokeSafe('memory_episodic_add', {
    kind: 'user',
    text: opts.goal,
    tags: ['goal'],
    meta: { run_started_at: Date.now() },
  });

  // --------------------------------------------------------------------
  // HTN decomposition — split complex goals into sub-goals that each run
  // as their own agent turn. Suppressed on sub-runs to prevent infinite
  // recursion.
  // --------------------------------------------------------------------
  if (!opts.isSubGoal) {
    const decomp = await maybeDecompose({
      goal: opts.goal,
      contextPack,
      signal,
    });
    if (decomp && decomp.subgoals.length > 0) {
      return await runDecomposed(opts, steps, decomp);
    }
    if (signal?.aborted) return abortedResult();
  }

  // --------------------------------------------------------------------
  // Pre-run introspection — can answer directly from memory, ask one
  // clarifying question, or attach caveats to the main-loop prompt.
  // Degrades silently on any failure — `null` means proceed normally.
  // --------------------------------------------------------------------
  let introspectionCaveats: ReadonlyArray<string> = [];
  let effectiveGoal = opts.goal;
  try {
    const introspection = justResumedClarify
      ? null
      : await introspectGoal({ goal: opts.goal, contextPack, signal });
    if (introspection) {
      if (introspection.mode === 'direct') {
        const step: AgentStep = {
          id: nextStepId(),
          kind: 'message',
          text: introspection.answer,
          at: Date.now(),
        };
        steps.push(emit(step, opts.onStep));
        void invokeSafe('memory_episodic_add', {
          kind: 'agent_step',
          text: `goal: ${opts.goal}\nanswer: ${introspection.answer.slice(0, 400)}`,
          tags: ['run', 'done', 'introspect-direct'],
          meta: { steps: 1, system: 'introspect', ts: Date.now() },
        });
        fireReflection(opts.goal, steps, introspection.answer, 'done');
        return { steps, finalAnswer: introspection.answer, status: 'done' };
      }
      if (introspection.mode === 'clarify') {
        const clarification = `I need a quick clarification — ${introspection.question}`;
        const step: AgentStep = {
          id: nextStepId(),
          kind: 'message',
          text: clarification,
          at: Date.now(),
        };
        steps.push(emit(step, opts.onStep));
        try {
          savePendingClarify(opts.sessionId, opts.goal, introspection.question);
        } catch (saveErr) {
          console.debug('[agentLoop] savePendingClarify failed:', saveErr);
        }
        return { steps, finalAnswer: clarification, status: 'done' };
      }
      if (introspection.mode === 'rewrite') {
        effectiveGoal = introspection.rewritten;
        const rewriteStep: AgentStep = {
          id: nextStepId(),
          kind: 'plan',
          text:
            `Original goal: "${opts.goal}"\n` +
            `Rewrote to:    "${introspection.rewritten}"\n` +
            `Because:       ${introspection.reason}`,
          at: Date.now(),
        };
        steps.push(emit(rewriteStep, opts.onStep));
        introspectionCaveats = [`Interpreted "${opts.goal}" as: ${introspection.rewritten} (${introspection.reason})`];
      } else if (introspection.mode === 'proceed') {
        introspectionCaveats = introspection.caveats;
      }
    }
  } catch (err) {
    console.debug('[agentLoop] introspection failed:', err);
  }
  if (signal?.aborted) return abortedResult();

  // --------------------------------------------------------------------
  // System-1 router — try to satisfy the goal with a skill recipe,
  // bypassing the LLM loop entirely when a high-confidence match exists.
  // Falls through (returns null) on miss or skill error.
  // --------------------------------------------------------------------
  const skillRouterResult = await runSkillRouter(opts, contextPack, abortedResult);
  if (skillRouterResult !== null) return skillRouterResult;

  // --------------------------------------------------------------------
  // Agent Society dispatch — pick a specialist role for the LLM loop.
  // Falls back to null (generalist) when disabled or on error.
  // --------------------------------------------------------------------
  const activeRole = await runSocietyDispatch(opts, effectiveGoal, contextPack);
  if (signal?.aborted) return abortedResult();

  // Load the constitution once per run so identity + values + hard
  // prohibitions land in the system prompt AND the runtime gate uses the
  // same snapshot.
  const constitution = await loadAndRenderConstitution();
  const built = buildSystemPrompt(
    effectiveGoal,
    contextPack,
    introspectionCaveats,
    constitution.prompt,
    activeRole,
  );
  const systemPrompt = built.prompt;

  if (built.budgetTrimmed) {
    pushInsight(
      'introspect_caveat',
      'Trimmed prompt to fit budget',
      built.trimNotes.join(' · '),
      { goal: opts.goal, notes: built.trimNotes },
    );
  }

  // --------------------------------------------------------------------
  // ReAct tool loop
  // --------------------------------------------------------------------
  for (let iter = 0; iter < maxSteps; iter += 1) {
    if (signal?.aborted) return abortedResult();

    const prompt = buildTurnPrompt(systemPrompt, steps);

    let raw: string;
    try {
      raw = await chat(prompt, {
        provider: settings.provider,
        model: settings.model,
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push(
        emit(
          {
            id: nextStepId(),
            kind: 'error',
            text: `chat failed: ${message}`,
            at: Date.now(),
          },
          opts.onStep,
        ),
      );
      const errorAnswer = `I hit an error talking to the model: ${message}`;
      fireReflection(opts.goal, steps, errorAnswer, 'error');
      return { steps, finalAnswer: errorAnswer, status: 'error' };
    }

    if (signal?.aborted) return abortedResult();

    const parsed = parseModelResponse(raw);

    if (parsed.action === 'answer') {
      const proposed = parsed.text.length > 0 ? parsed.text : raw.trim();

      // Runtime constitution verification — sits between the model's
      // answer and the user.
      const toolCallsForCheck = reconstructToolCalls(steps, TOOLS);
      const parsedValues = parseConstitutionValues(
        constitution.constitution?.values ?? [],
      );
      const violations = verifyAnswer(proposed, parsedValues, {
        toolCalls: toolCallsForCheck,
        source: 'chat',
      });
      const blocking = violations.find(v => v.severity === 'block');
      const final = blocking ? CONSTITUTION_BLOCK_REPLY : proposed;

      for (const v of violations) {
        pushInsight(
          'constitution_block',
          `Constitution ${v.severity}: ${v.kind}`,
          v.detail,
          { kind: v.kind, severity: v.severity, detail: v.detail, goal: opts.goal },
        );
      }

      steps.push(
        emit(
          { id: nextStepId(), kind: 'message', text: final, at: Date.now() },
          opts.onStep,
        ),
      );

      const toolSequence: string[] = steps
        .filter(s => s.kind === 'tool_call' && typeof s.toolName === 'string')
        .map(s => s.toolName as string);
      void invokeSafe('memory_episodic_add', {
        kind: 'agent_step',
        text: `goal: ${opts.goal}\nanswer: ${final.slice(0, 400)}`,
        tags: ['run', 'done'],
        meta: {
          steps: steps.length,
          iter,
          ts: Date.now(),
          system: 2,
          tool_sequence: toolSequence,
        },
      });
      fireReflection(opts.goal, steps, final, 'done');
      return { steps, finalAnswer: final, status: 'done' };
    }

    // parsed.action === 'tool'
    const toolName = parsed.tool;
    const toolInput = parsed.input;
    const tool = TOOLS.get(toolName);

    steps.push(
      emit(
        {
          id: nextStepId(),
          kind: 'tool_call',
          text: `calling ${toolName}`,
          toolName,
          toolInput,
          at: Date.now(),
        },
        opts.onStep,
      ),
    );

    if (!tool) {
      const errResult = {
        ok: false,
        content: `Unknown tool "${toolName}". Available: ${Array.from(TOOLS.keys()).join(', ')}`,
        latency_ms: 0,
      };
      steps.push(
        emit(
          {
            id: nextStepId(),
            kind: 'tool_result',
            text: errResult.content,
            toolName,
            toolInput,
            toolOutput: errResult,
            at: Date.now(),
          },
          opts.onStep,
        ),
      );
      continue;
    }

    // Society role enforcement: refuse tools outside the role's allowlist
    // even if the model hallucinated the name.
    if (
      activeRole &&
      !activeRole.tools.includes('*') &&
      !activeRole.tools.includes(toolName)
    ) {
      const outOfRole = {
        ok: false,
        content: `Tool "${toolName}" is outside the ${activeRole.name} role's allowlist. Allowed: ${activeRole.tools.slice(0, 8).join(', ')}${activeRole.tools.length > 8 ? ', …' : ''}`,
        latency_ms: 0,
      };
      steps.push(
        emit(
          {
            id: nextStepId(),
            kind: 'tool_result',
            text: outOfRole.content,
            toolName,
            toolInput,
            toolOutput: outOfRole,
            at: Date.now(),
          },
          opts.onStep,
        ),
      );
      continue;
    }

    // Constitution gate: hard-prohibition check before ConfirmGate.
    const gate = await gateToolCall(toolName, toolInput);
    if (!gate.allowed) {
      const blocked = {
        ok: false,
        content: `Constitution blocked "${toolName}": ${gate.reason ?? 'policy'}`,
        latency_ms: 0,
      };
      steps.push(
        emit(
          {
            id: nextStepId(),
            kind: 'tool_result',
            text: blocked.content,
            toolName,
            toolInput,
            toolOutput: blocked,
            at: Date.now(),
          },
          opts.onStep,
        ),
      );
      continue;
    }

    // Critic review — sits between the constitution gate and ConfirmGate.
    if (tool.dangerous) {
      const verdict = await reviewDangerousAction({
        goal: opts.goal,
        toolName,
        toolDescription: tool.schema.description,
        toolInput,
        recentSteps: steps,
        constitution: constitution.constitution,
        signal,
      });
      if (verdict?.verdict === 'block') {
        pushInsight(
          'constitution_block',
          `Critic blocked "${toolName}"`,
          verdict.reason,
          { tool: toolName, input: toolInput, source: 'critic' },
        );
        const blocked = {
          ok: false,
          content: `Critic blocked "${toolName}": ${verdict.reason}`,
          latency_ms: 0,
        };
        steps.push(
          emit(
            {
              id: nextStepId(),
              kind: 'tool_result',
              text: blocked.content,
              toolName,
              toolInput,
              toolOutput: blocked,
              at: Date.now(),
            },
            opts.onStep,
          ),
        );
        continue;
      }
      if (verdict?.verdict === 'review' && verdict.concern) {
        console.debug(`[critic] concern on ${toolName}: ${verdict.concern}`);
      }
    }

    if (tool.dangerous && opts.confirmDangerous) {
      const allowed = await Promise.resolve(
        opts.confirmDangerous(toolName, toolInput),
      );
      if (!allowed) {
        const declined = {
          ok: false,
          content: `User declined dangerous tool "${toolName}".`,
          latency_ms: 0,
        };
        steps.push(
          emit(
            {
              id: nextStepId(),
              kind: 'tool_result',
              text: declined.content,
              toolName,
              toolInput,
              toolOutput: declined,
              at: Date.now(),
            },
            opts.onStep,
          ),
        );
        continue;
      }
    }

    // Each tool invocation gets its own linked AbortSignal.
    const toolSignal = linkSignal(signal);
    registerRunContext(toolSignal.signal, {
      label: opts.parent ?? 'agent',
      depth: opts.depth ?? 0,
      parentSignal,
    });
    let toolResult;
    try {
      toolResult = await runTool(toolName, toolInput, toolSignal.signal);
    } finally {
      clearRunContext(toolSignal.signal);
      toolSignal.dispose();
    }

    steps.push(
      emit(
        {
          id: nextStepId(),
          kind: 'tool_result',
          text: toolResult.content,
          toolName,
          toolInput,
          toolOutput: toolResult,
          at: Date.now(),
        },
        opts.onStep,
      ),
    );

    if (signal?.aborted) return abortedResult();
  }

  // Ran out of steps.
  const fallback = 'Reached the maximum number of steps without a final answer.';
  steps.push(
    emit(
      { id: nextStepId(), kind: 'error', text: fallback, at: Date.now() },
      opts.onStep,
    ),
  );
  fireReflection(opts.goal, steps, fallback, 'max_steps');
  return { steps, finalAnswer: fallback, status: 'max_steps' };
}

// ---------------------------------------------------------------------------
// Test-only exports — not part of the public surface.
// ---------------------------------------------------------------------------

export const __internal = {
  savePendingClarify,
  consumePendingClarify,
  peekPendingClarifyForTests,
  clearPendingClarifiesForTests,
  CLARIFY_TTL_MS,
};
