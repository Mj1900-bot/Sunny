# Agent

> **Two agent loops exist in SUNNY.** The Rust `agent_run` in
> `src-tauri/src/agent_loop/core.rs` drives voice turns and any call that
> reaches SUNNY via `invoke('chat')` — it owns the full ReAct loop with
> provider adapters, memory wiring, and the tool dispatcher. The TypeScript
> `agentLoop.ts` path described in this document drives the chat panel and
> carries richer TS-side cognitive layers (HTN decomposer, System-1 skill
> router, introspection, reflection). Both loops share the same tool
> catalog and constitution gate; they exist separately because the Rust path
> was added for voice latency (no JS bridge round-trips) while the TS path
> predates it and supports more cognitive architecture.

`runAgent` in `src/lib/agentLoop.ts` is the dispatcher. A single public
function that routes a user goal through up to nine cooperating
subsystems before returning an `AgentRunResult`.

This document annotates that flow step by step.

## Public contract

```ts
export async function runAgent(opts: {
  goal: string;
  maxSteps?: number;                // default 12
  signal?: AbortSignal;             // propagates throughout
  onStep?: (step: AgentStep) => void;
  chat?: ChatFn;                    // test injection
  confirmDangerous?: (tool, input) => Promise<boolean> | boolean;
  isSubGoal?: boolean;              // suppresses HTN (prevents recursion)
}): Promise<AgentRunResult>

type AgentStep = {
  id: string;
  kind: 'plan' | 'tool_call' | 'tool_result' | 'message' | 'error';
  text: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: ToolResult;
  at: number;
};

type AgentRunResult = {
  steps: ReadonlyArray<AgentStep>;
  finalAnswer: string;
  status: 'done' | 'aborted' | 'max_steps' | 'error';
};
```

The `onStep` callback streams every step as it happens so the UI can
render incrementally. `signal` is honored at every yield and every
network boundary — calling `.abort()` stops the run as quickly as the
current tool / LLM call allows.

## The dispatch flow

```
 runAgent(opts)
    │
    1. Build context pack
    2. HTN decompose?              ──yes──▶ runDecomposed (sequential sub-runs)
    3. Record goal as episodic
    4. Introspect ──direct──▶ answer + episodic + reflection + return
                   │
                   ├──rewrite─▶ swap goal → concrete rewrite, carry caveats
                   │
                   ├──clarify─▶ return one-line question
                   │
                   └──proceed─▶ carry caveats forward
    5. System-1 skill match? ──yes──▶ runSkill + bump_use + return
    6. Load constitution, build system prompt
    7. Society dispatch (if settings.societyEnabled):
         chair picks role via keyword prefilter + model tiebreak
         role's tool allowlist + prompt fragment scope the run
    8. System-2 ReAct loop:
         per iteration:
           a. chat(prompt)
           b. parse JSON → answer | tool
           c. if answer: episodic + reflection + return
           d. if tool:
              i.   role allowlist check (if active role)
              ii.  constitution gate
              iii. critic review (if dangerous)
              iv.  ConfirmGate (if dangerous)
              v.   runTool
              vi.  append tool_result step
         on max_steps: fallback + reflection + return
```

The rest of this document walks each stage.

## 1. Context pack

Before any routing decision, `buildContextPack({ goal, signal })` assembles
the agent's working memory (see [`docs/MEMORY.md`](./MEMORY.md)):

- Top-8 semantic facts matching the goal
- Top-8 matched episodic events (goal-ranked)
- Last 20 recent episodic events (chronological)
- Top-5 procedural skills by uses_count
- `matched_skills` — cosine-scored subset of skills vs goal
- Current `WorldState` — focus, activity, calendar, mail, machine
- Memory stats + `used_embeddings` flag

Built **once per run**, not per turn — per-turn rebuilds wouldn't change
the hit set in any meaningful way, and the FTS + embed round trip is
cheap but not free.

## 2. HTN decomposition

**File**: `src/lib/planner.ts`

Cheap-model pass (`chatFor('decomposition', ...)`) that returns either
null (atomic goal) or 2–5 independent sub-goals with an optional
rationale. Quick heuristic gate skips the model call when the goal has
no coordinating conjunction:

```ts
shouldSkip(goal):
  goal.length < 16                         → true
  has no " and ", " then ", ";", " after " → true
```

When decomposition fires:

```ts
runDecomposed(opts, parentSteps, decomp):
  emit plan step listing the sub-goals
  push introspect_caveat insight
  for each sub-goal:
    run = await runAgent({ goal: sub, isSubGoal: true, ...opts })
    append run.steps to allSteps
    if run.status !== 'done':
      return early with the bailed status
    collect run.finalAnswer
  compose final = "**1. <sub>**\n<answer>\n\n**2. ..."
  return { steps, finalAnswer: composed, status: 'done' }
```

Sub-runs inherit the parent's `signal`, `onStep`, and `confirmDangerous`,
but are flagged `isSubGoal: true` so the decomposer doesn't recurse.
Max 5 sub-goals (hard cap in the planner).

Sequential, not parallel — later sub-goals often depend on earlier ones
via memory.

## 3. Episodic goal record

```ts
memory_episodic_add({
  kind: 'user',
  text: opts.goal,
  tags: ['goal'],
  meta: { run_started_at: Date.now() },
});
```

Future runs' FTS retrieval will surface this row under "related past
events" for similar goals, and the skill synthesizer mines it later.

## 4. Introspection

**File**: `src/lib/introspect.ts`

Cheap-model pass that inspects the goal + context pack and returns one of:

| Mode | Response shape | Effect |
|---|---|---|
| `direct` | `{ mode: 'direct', answer: string }` | answer rendered immediately, run done |
| `rewrite` | `{ mode: 'rewrite', rewritten: string, reason: string }` | goal rewritten into concrete form from memory context; main loop plans against rewrite |
| `clarify` | `{ mode: 'clarify', question: string }` | one-line clarifier returned, run done |
| `proceed` | `{ mode: 'proceed', caveats: string[] }` | caveats injected into system prompt |

**When `rewrite` fires** — the introspector detected that the goal is
under-specified but semantic memory carries enough context to resolve
the intent. The original goal is logged to a visible `plan` step
("Original: X · Rewrote to: Y · Because: Z"), the rewritten goal
replaces `opts.goal` for the rest of the run, and an
`introspect_caveat` insight fires so the user can correct the
interpretation if needed.

**Skip conditions** (to avoid paying for the round trip when it can't
help):

- `goal < 3 words`
- User disabled introspection in settings
- Memory is empty of hits (`semantic.length + matched_episodic.length + matched_skills.length === 0`)

**Insights fired** (visible in the Memory → Insights tab):

- `introspect_direct` — "Answered from memory"
- `introspect_clarify` — "Asked a clarifying question"
- `introspect_caveat` — "Added caveats" (only when caveats non-empty)

On `direct`, the run finalizes in ~500 ms with one cheap-model call instead
of burning through multiple expensive-model turns. That's the biggest
latency win for recurring questions with known answers.

On `clarify`, the user gets a focused question instead of watching the
agent guess wrong — e.g. "Which bug? The one in `agentLoop.ts` or the
failing test in `web.rs`?" rather than four wrong tool calls.

## 5. System-1 skill router

```ts
const topSkill = contextPack?.memory?.matched_skills?.[0];
if (
  contextPack?.memory?.used_embeddings &&
  topSkill &&
  topSkill.score >= EXECUTE_THRESHOLD &&     // 0.85 cosine
  topSkill.skill.recipe !== undefined
) {
  result = await runSkill({ goal, skill: topSkill.skill, signal, onStep, confirmDangerous });
  if (result.status === 'done' || result.status === 'aborted') {
    // success path: bump_use, write episodic, reflect, return
    return result;
  }
  // error → fall through to System-2
}
```

**Gate**: `used_embeddings` must be true. Without embeddings, cosine
scores are zero everywhere — the threshold check would fire falsely.

**Falls through on error**: a broken recipe never strands the user. The
LLM loop picks up where the skill failed.

See [`docs/SKILLS.md`](./SKILLS.md) for recipe execution details.

## 5.5. Agent Society (optional)

**Files**: `src/lib/society/roles.ts` + `src/lib/society/dispatcher.ts`

Opt-in role-based dispatch between introspection and System-1. When
`settings.societyEnabled === true`, the chair picks a specialist role
whose tool allowlist + prompt fragment scope the main loop. Off by
default; sub-runs (HTN decomposition) also skip dispatch to avoid
recursive specialization.

### Available roles

| Role | Purpose | Tool subset |
|---|---|---|
| `researcher` | Answer factual questions, summarize | web_search, web_fetch_readable, memory_search, fs_list, file_read_text, find_text_on_screen |
| `coder` | Read/edit/run code | file_* (write/edit/delete/rename/mkdir), fs_list, run_shell, claude_code_run, pty_agent_* |
| `operator` | Drive the Mac UI | mouse_*, keyboard_*, screen_capture_*, open_app, find_text_on_screen, click_text_on_screen |
| `scribe` | Persist content | memory_*, notes_app_*, reminders_*, calendar_*, scheduler_* |
| `generalist` | Fallback with full tool access | `['*']` |

### Chair dispatch

Two-stage:

1. **Keyword prefilter** — `scoreRolesByTriggers(goal)` counts trigger
   substring matches per role. Confident wins (single role with ≥ 1
   match, or top role with ≥ 2 hit dominance) fire immediately — no
   LLM call.
2. **Cheap-model tiebreak** — on ambiguity, ask the cheap model
   (`chatFor('decomposition', prompt)`) to pick one. Falls through to
   `generalist` on any parse / transport failure.

Every dispatch fires an `introspect_caveat` insight
(`Dispatched to Coder · keyword match · conf 0.85 · …`) so the user
can see who handled their goal and why.

### Enforcement

The society layer enforces its allowlist twice:

1. **Prompt-level** — `buildSystemPrompt` filters the AVAILABLE TOOLS
   block to the role's set. The LLM literally can't see tools outside
   its remit.
2. **Runtime** — `runAgent`'s tool-call path checks the allowlist
   before executing. If the LLM hallucinates an out-of-role tool name,
   the gate returns `Tool "X" is outside the Coder role's allowlist`
   as a tool_result, nudging the next turn back on-track.

Both layers work together — belt-and-braces against model drift.

## 6. Constitution + system prompt

```ts
const constitution = await loadAndRenderConstitution();
const systemPrompt = buildSystemPrompt(opts.goal, contextPack,
                                       introspectionCaveats,
                                       constitution.prompt);
```

The system prompt is composed in this order:

1. **Context block** — rendered memory + world from the pack
2. **Constitution block** — identity + values + hard prohibitions
3. **Caveats** from introspection (if any)
4. **Protocol** — "reply with one JSON object, tool or answer"
5. **Tools** — full registry with schemas

The constitution block is verbatim user-editable JSON surfaced to the
model. Identity is declarative, not hardcoded. See
[`docs/CONSTITUTION.md`](./CONSTITUTION.md).

## 7. System-2 ReAct loop

Up to `maxSteps` iterations (default 12). Each iteration:

### a. Chat

```ts
const raw = await chat(prompt, { provider, model, signal });
```

`chat` is the `defaultChat` function by default — hits the Tauri `chat`
command. Tests can inject a synchronous chat function via `opts.chat`.

On failure: an `error` step is appended, reflection fires, the run
returns `status: 'error'`.

### b. Parse

```
parseModelResponse(raw) → ModelAction
  • { action: 'tool', tool: string, input: unknown }
  • { action: 'answer', text: string }
```

Three-stage parse:

1. Strip ` ```json ` fences if present
2. Try `JSON.parse`
3. Salvage: find the largest balanced `{...}` substring, retry parse
4. Fallback: treat the raw text as a final answer

This defensive stack handles: plain JSON, fenced JSON, JSON with
surrounding prose, and models that just emit text as the answer.

### c. Answer branch

```ts
if (parsed.action === 'answer') {
  emit message step
  memory_episodic_add({
    kind: 'agent_step',
    text: `goal: ${opts.goal}\nanswer: ${final.slice(0, 400)}`,
    tags: ['run', 'done'],
    meta: { steps, iter, ts, system: 2, tool_sequence },
  });
  fireReflection(opts.goal, steps, final, 'done');
  return { steps, finalAnswer: final, status: 'done' };
}
```

The `tool_sequence` metadata is the raw material the skill synthesizer
uses to compile recipes later.

### d. Tool branch — three-layer defense

```
emit tool_call step
│
▼
if unknown tool: emit tool_result err + continue
│
▼
┌── LAYER 1: constitution gate ──────────────────────────────────────────┐
│  const gate = await gateToolCall(toolName, toolInput);                 │
│  if (!gate.allowed): emit tool_result (blocked) + continue             │
│  // fires constitution_block insight                                   │
└────────────────────────────────────────────────────────────────────────┘
│
▼
if tool.dangerous:
  ┌── LAYER 2: critic review ────────────────────────────────────────────┐
  │  const verdict = await reviewDangerousAction({                       │
  │    goal, toolName, toolDescription, toolInput,                       │
  │    recentSteps, constitution, signal                                 │
  │  });                                                                 │
  │  Critic prompt automatically includes recent reliability stats for   │
  │  the tool (last 7d success rate, p50/p95 latency) when ≥ 5 calls    │
  │  are on record. Low success rate biases toward REVIEW.               │
  │  • 'block'   → emit blocked tool_result + continue                   │
  │  • 'review'  → fall through (log concern)                            │
  │  • 'approve' → fall through                                          │
  └──────────────────────────────────────────────────────────────────────┘
│
▼
if tool.dangerous && opts.confirmDangerous:
  ┌── LAYER 3: ConfirmGate (user) ───────────────────────────────────────┐
  │  allowed = await confirmDangerous(toolName, toolInput)               │
  │  if (!allowed): emit declined tool_result + continue                 │
  └──────────────────────────────────────────────────────────────────────┘
│
▼
execute: toolResult = await runTool(toolName, toolInput, signal)
emit tool_result step
```

All three layers are independent. Either the two automated ones (#1, #2)
can short-circuit before the user is asked. ConfirmGate is the final
authority — the user can always override a critic review or approve a
constitution "review" path.

### e. Max-steps exit

```ts
const fallback = 'Reached the maximum number of steps without a final answer.';
emit error step
fireReflection(opts.goal, steps, fallback, 'max_steps');
return { steps, finalAnswer: fallback, status: 'max_steps' };
```

Reflection on max-step runs is exactly where "this goal needs to be
broken into sub-goals" lessons emerge — so the next similar goal is more
likely to trigger HTN decomposition.

## 8. Reflection

Fire-and-forget at every terminal state except `aborted`:

```ts
fireReflection(opts.goal, steps, finalAnswer, status);
  // internally: reflectOnRun({ goal, steps, finalAnswer, status })
  //   → cheap-model call
  //   → structured JSON { success, outcome, lesson, wasted_tool_indices, followup }
  //   → episodic audit row (always)
  //   → semantic fact (if lesson) — bypasses the 15-min consolidator
  //   → memory_lesson insight
```

The user's answer is already rendered by the time reflection runs. It's
entirely a future-run investment.

See [`docs/MEMORY.md`](./MEMORY.md#reflection) for details.

## Sub-agents

A second execution path for concurrent background runs, separate from the
main `runAgent`.

**Store**: `src/store/subAgents.ts` — up to 8 concurrent runs, each with
its own status, steps, final answer. Abort individually or all.

**Runner**: `src/lib/subAgents.ts` — watches the store for `queued` runs,
flips to `running`, drives `runAgent` for the goal text, finalises on
completion.

**Used by**:

- HTN decomposition (internally, via recursive `runAgent` — not via the
  sub-agent store, because HTN needs sequential + in-line step streaming)
- User-initiated background tasks from the Task Queue page
- Daemons (Rust-side) dispatch via `useSubAgents.spawn` for scheduled runs

## Status summary

| Status | Meaning | Reflection fires? |
|---|---|---|
| `done` | answer produced | yes |
| `error` | chat failed / unrecoverable | yes |
| `max_steps` | ran out of budget | yes |
| `aborted` | user or parent aborted | no — user intent, not a learning signal |

## Testing

The whole loop is runnable in a Node environment with a mocked chat
function:

```ts
const result = await runAgent({
  goal: 'test goal',
  chat: async () => '{"action":"answer","text":"hello"}',
  confirmDangerous: () => true,
});
```

Tool registry, constitution client, and memory pack all degrade
gracefully when the Tauri IPC isn't available (`isTauri === false`), so
tests can exercise the loop without a running backend.

## Step helpers

The `onStep` callback fires for every step emission. The Dashboard uses
this to stream the run into the `AgentLogPanel` in real time:

```tsx
runAgent({
  goal,
  onStep: step => useAgentStore.getState().appendStep(step),
  confirmDangerous: useSafety.getState().request,
});
```

## Further reading

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — where the agent sits in the stack
- [`docs/MEMORY.md`](./MEMORY.md) — context pack internals
- [`docs/SKILLS.md`](./SKILLS.md) — what runSkill actually does
- [`docs/CONSTITUTION.md`](./CONSTITUTION.md) — gate layer #1 details
