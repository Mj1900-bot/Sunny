# Skills

A **skill** is a named, reusable capability the agent can invoke. SUNNY
supports two flavors:

1. **Script-backed skills** — TypeScript files under `src/skills/` or
   `~/.sunny/skills/` that register `Tool`s into the global registry.
2. **Recipe-backed skills** — JSON recipes stored in the `procedural`
   memory table. The System-1 executor runs them deterministically,
   bypassing the LLM.

Both surface as rows in the same `procedural` SQLite table. Both compete
for `matched_skills` slots in the context pack. The difference is only
how they execute.

## Recipe format

A recipe is a small JSON program:

```json
{
  "steps": [
    {
      "kind": "tool",
      "tool": "calendar_list_events",
      "input": {
        "start_iso": "{{$today_start}}",
        "end_iso":   "{{$today_end}}"
      },
      "saveAs": "events"
    },
    {
      "kind": "tool",
      "tool": "mail_unread_count",
      "input": {}
    },
    {
      "kind": "answer",
      "text": "Here's your day:\n\nEvents:\n{{events}}\n\nUnread mail: check above."
    }
  ]
}
```

### Step types

| Kind | Shape | What it does |
|---|---|---|
| `tool` | `{ kind, tool, input, saveAs? }` | Invoke a tool from the global registry. `saveAs` binds the result for later template expansion. |
| `answer` | `{ kind, text }` | Emit the final user-facing message and terminate the recipe. |

### Hard caps

- `MAX_RECIPE_STEPS = 32` — runaway recipes can't loop 1000× on a tool
- Recipes that hit `!result.ok` on any step abort cleanly (subsequent
  steps would template against the failed output and produce garbage)

## Template substitution

Strings inside `input` objects and the `answer.text` support
`{{reference}}` tokens. Substitution walks objects and arrays
recursively, so nested paths like `{ "req": { "message": "{{$goal}}" } }`
work.

### Built-in references

Every recipe execution starts with these in scope:

| Reference | Value |
|---|---|
| `{{$goal}}` | The user's original goal text |
| `{{$now}}` | ISO-8601 timestamp (UTC) |
| `{{$now_local}}` | Naïve-local timestamp (what AppleScript commands want) |
| `{{$in_1h}}` | 1 hour from now, ISO |
| `{{$in_24h}}` | 24 hours from now, ISO |
| `{{$in_7d}}` | 7 days from now, ISO |
| `{{$today_start}}` | Start of local calendar day, naïve-local |
| `{{$today_end}}` | Start of tomorrow, naïve-local |

### Saved references

When a tool step has `saveAs: "name"`, its `ToolResult` is bound to
`name`. Use it as:

- `{{name}}` — the result's `content` string (shorthand)
- `{{name.content}}` — same, explicit
- `{{name.ok}}` — boolean success flag
- `{{name.data.field.nested}}` — dotted JSON path into `data`
- `{{name.latency_ms}}` — any other ToolResult field

### Missing references

Unresolved tokens expand to empty string. This is deliberate — a
template that references a step which hasn't run yet (e.g. conditional
logic) shouldn't crash the recipe.

## Execution — the System-1 router

**File**: `src/lib/skillExecutor.ts`

```
runSkill({ goal, skill, signal, onStep, confirmDangerous })
  │
  1. parseRecipe(skill.recipe) → validate shape; return null if bad
  │
  2. scope = { $goal, $now, $in_*, $today_* }
  │
  3. emit plan step — "System-1: running skill X (N steps)"
  │    + push skill_fired insight (toast + feed row)
  │
  4. for each step:
  │    if kind === 'answer':
  │      final = resolveTemplate(step.text, scope)
  │      emit message step
  │      return { status: 'done', finalAnswer: final }
  │
  │    tool step:
  │      substitutedInput = substituteDeep(step.input, scope)
  │      emit tool_call step
  │      • constitution gate    — block + abort recipe on refusal
  │      • (dangerous) ConfirmGate — abort on user decline
  │      result = await runTool(step.tool, substitutedInput, signal)
  │      emit tool_result step
  │      if !result.ok: abort cleanly
  │      if saveAs: scope[saveAs] = result
  │
  5. fallthrough (no answer step): emit last tool_result's content
  │    as the final message
  │
  6. caller calls recordSkillUse(skill.id) → bumps uses_count
```

### Constitution applies

System-1 recipes go through the same constitution gate as System-2
tool calls. A compiled recipe doesn't get a free pass — if the user has
banned `run_shell` after 10 PM, the skill won't run `run_shell` at
23:30 either.

### Dangerous tools + ConfirmGate

The `dangerous` flag is honored per step. If a recipe contains a
dangerous tool and the user declines, the **whole recipe** aborts (not
just the step) — partial side effects from a cancelled run are worse
than running nothing.

### Failure → System-2 fallback

When `runSkill` returns `status: 'error'`, `runAgent` logs the failure
and falls through to the LLM loop. A broken recipe is a slower run, not
a failed user experience.

## Auto-synthesis

**File**: `src/lib/skillSynthesis.ts`

The synthesizer runs every 20 minutes (offset from the consolidator's
15-min tick so they don't both hit the chat provider at the same
instant). On each tick:

```
1. Fetch recent successful runs:
     SELECT from episodic
     WHERE kind='agent_step'
       AND tags ⊇ {'run','done'}
       AND tags ⊉ {'skill'}        -- don't re-synthesize S1 outputs
       AND created_at > now - 30d
     LIMIT 500

2. Extract each row's meta.tool_sequence (recorded by agentLoop on done)
   Drop rows with: empty sequence, length 1, length > MAX_TOOL_SEQ (8)

3. Cluster by identical tool_sequence.
   cluster[i] = { sequence, runs[] }
   sort clusters by runs.length DESC

4. For each cluster where runs.length >= MIN_CLUSTER_RUNS (5):
   skip if a skill with the derived name already exists
   compile recipe:
     steps = [ tool_call(name, input={}) for name in sequence ]
     steps += [ answer "Here's what I found for \"{{$goal}}\"." ]
   memory_skill_add(name, description, trigger_text, recipe)
   push skill_synthesized insight
```

### Naming

```
deriveSkillName(goal, sequence) →
  "<first 4 non-stopword lowercase goal tokens>-<4-char FNV hash of seq>"
```

The FNV suffix disambiguates skills compiled from different tool
sequences for similar goals. Deterministic so re-synthesis of the same
pattern doesn't collide.

### Current limitations (v1 synthesis)

The current compiler emits recipes with **empty inputs** — each tool is
invoked with `{}`. This works for tools that take optional inputs (the
tool's own schema validator kicks in if required fields are missing, and
the recipe aborts cleanly, falling through to System-2). A future
synthesis pass will:

- Diff inputs across cluster runs to detect which fields vary with the
  goal vs which are constants
- Template user-goal-derived strings as `{{$goal}}`
- Preserve literal inputs from the most recent cluster run

## Manual authoring

Two paths, depending on whether you want imperative TS logic or a JSON
recipe.

### 1. TS skill (imperative, custom logic)

Drop a file into `src/skills/<your-skill>.ts`:

```ts
import type { SkillManifest } from '../lib/skills';
import type { Tool, ToolResult } from '../lib/tools';
import { invokeSafe } from '../lib/tauri';

const weatherCurrentTool: Tool = {
  schema: {
    name: 'skill.weather.current',
    description: 'Fetch the current weather for a named location.',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();
    const loc = (input as { location?: string }).location ?? '';
    if (!loc) {
      return { ok: false, content: '"location" required', latency_ms: 0 };
    }
    if (signal.aborted) {
      return { ok: false, content: 'aborted', latency_ms: 0 };
    }
    const reading = await invokeSafe('weather_current', { location: loc });
    return {
      ok: true,
      content: `${loc}: <reading>`,
      data: reading,
      latency_ms: Date.now() - started,
    };
  },
};

const manifest: SkillManifest = {
  id: 'skill.weather',
  name: 'Weather',
  description: 'Current-conditions lookup.',
  version: '0.1.0',
  tools: [weatherCurrentTool],
};

export default manifest;
```

At boot, `loadBuiltinSkills()` in `src/lib/skills.ts` discovers every
file matching `../skills/*.ts` via Vite's
`import.meta.glob({ eager: true })` and registers the default-exported
manifest's tools.

Namespace your tool names (`skill.weather.current`) so they don't
collide with built-ins.

### 2. Recipe skill (declarative JSON)

Add via the Tauri command:

```ts
import { invokeSafe } from './lib/tauri';

await invokeSafe('memory_skill_add', {
  name: 'morning-brief',
  description: 'Summarize today — calendar events + unread mail',
  trigger_text: 'morning brief, what\'s on today, daily summary, good morning',
  recipe: {
    steps: [
      {
        kind: 'tool',
        tool: 'calendar_list_events',
        input: {
          start_iso: '{{$today_start}}',
          end_iso:   '{{$today_end}}',
        },
        saveAs: 'events',
      },
      {
        kind: 'tool',
        tool: 'mail_unread_count',
        input: {},
      },
      {
        kind: 'answer',
        text: 'Here\'s your day:\n\nEvents:\n{{events}}\n\nUnread mail: above.',
      },
    ],
  },
});
```

The skill is immediately available — the skill synthesizer and manual
authoring use the same `memory_skill_add` endpoint.

## The `Tool` contract

```ts
type Tool = {
  readonly schema: {
    readonly name: string;                         // unique global id
    readonly description: string;                  // shown to the LLM
    readonly input_schema: Record<string, unknown>; // JSON Schema
  };
  readonly dangerous: boolean;                     // triggers 3-layer gate
  readonly run: (input: unknown, signal: AbortSignal) => Promise<ToolResult>;
};

type ToolResult = {
  readonly ok: boolean;
  readonly content: string;    // human-readable, what the model sees back
  readonly data?: unknown;     // structured payload for downstream steps
  readonly latency_ms: number;
};
```

**Conventions**:

- Validate `input` defensively — treat it as `unknown`.
- Honor `signal.aborted` both before and after async work.
- Set `dangerous: true` for any tool with user-visible side effects
  (shell, file writes, sent messages, UI automation).
- Return `ok: false` for expected failures; throw only for genuine bugs
  (the registry's try/catch wraps those into a graceful error ToolResult).

See [`docs/TOOLS.md`](./TOOLS.md) for the full built-in tool reference.

## Duplicate handling

| Conflict | Behavior |
|---|---|
| Two skill files register the same `skill.id` | First wins, warn once |
| Two tools register the same name | Last write wins (later module loaded overwrites earlier) |
| `memory_skill_add` with duplicate name | Rejected — unique index on `procedural.name` |
| Synthesizer re-compiles same cluster | Short-circuits at the name-exists check |

## Inspecting skills

The Memory page's **Procedural** tab shows:

- Sort by `uses_count` desc (most-used first)
- `last_used` timestamp (relative)
- Recipe JSON via the SHOW RECIPE button
- Script-backed skills labeled `[no recipe — script-backed]`
- DELETE button per row

## Lifecycle

```
authoring               usage
  │                       │
  ▼                       ▼
memory_skill_add     runAgent builds context pack
  │                       │
  │                  matched_skills[0].score >= 0.85?
  │                       │
  ▼                       ▼
procedural table    runSkill(recipe)  ◀─────── System-1 fires
  + embedding                │
                             ▼
                      memory_skill_bump_use(id)
                             │
                             ▼
                      uses_count += 1, last_used_at = now
                             │
                             ▼
                   next run's matched_skills
                     ranks this one higher
```

## Further reading

- [`docs/MEMORY.md`](./MEMORY.md) — where procedural lives in the schema
- [`docs/AGENT.md`](./AGENT.md#5-system-1-skill-router) — System-1 dispatch
- [`docs/TOOLS.md`](./TOOLS.md) — tool registry reference
- [`src/skills/README.md`](../src/skills/README.md) — quickstart for skill authoring
