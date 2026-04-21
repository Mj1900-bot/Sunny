# Constitution

SUNNY's constitution is a **declarative JSON file** that defines:

1. **Identity** — who the agent is (name, voice, operator)
2. **Values** — principles the LLM should honor in its reasoning
3. **Prohibitions** — hard rules enforced at the tool-call gate

Users edit `~/.sunny/constitution.json` directly. The file is the single
source of truth for agent behavior that should persist across every run.

## Editor UI

SUNNY ships a full GUI editor for the constitution at
[`src/pages/ConstitutionPage.tsx`](../src/pages/ConstitutionPage.tsx).
Click **CONSTITUTION** in the nav panel (or press the macOS View menu
entry). You'll see:

- **Identity form** — name / voice / operator fields
- **Values** — add / edit / remove value strings
- **Prohibitions** — per-rule editor with:
  - free-text description
  - tool picker (checkbox list, seeded with common tools + your
    currently-registered skill tools)
  - hour-window inputs with clear affordances (`after` / `before` that
    handle midnight wrap correctly)
  - input-substring pattern tags (type + Enter to add; click to remove)
- **Live prompt preview** — shows the exact block the LLM will see in
  every run's system prompt, updated as you type
- **SAVE** writes via `constitution_save` and invalidates the 60 s
  client cache so the next agent run picks up the new policy without a
  restart
- **REVERT** reloads from disk

You can still hand-edit `~/.sunny/constitution.json` if you prefer; the
editor just reads and writes the same file.

## File location

```
~/.sunny/constitution.json
```

Permissions: 0600 (user read/write only). Created on first app launch
with permissive defaults. Subsequent launches honor whatever the user
has edited. A malformed file logs a warning and falls back to defaults —
the agent never refuses to boot because of a broken constitution.

## Schema

```json
{
  "schema_version": 1,
  "identity": {
    "name": "SUNNY",
    "voice": "British male, calm, dry wit when appropriate",
    "operator": "Sunny"
  },
  "values": [
    "Prefer concise over verbose — say less, mean more.",
    "Confirm destructive actions through the UI gate before running.",
    "Never share user secrets with cloud providers without explicit opt-in.",
    "Trust the user over learned facts when they conflict."
  ],
  "prohibitions": [
    {
      "description": "No iMessage after 10 PM unless I say yes this turn",
      "tools": ["messaging_send_imessage", "messaging_send_sms"],
      "after_local_hour": 22
    },
    {
      "description": "Never rm -rf home directory",
      "tools": ["run_shell"],
      "match_input_contains": ["rm -rf /", "rm -rf ~", "rm -rf $HOME"]
    },
    {
      "description": "No AppleScript after hours — too easy to misfire",
      "tools": ["applescript"],
      "after_local_hour": 22,
      "before_local_hour": 7
    }
  ]
}
```

### Top-level fields

| Field | Type | Notes |
|---|---|---|
| `schema_version` | int | Currently `1`. The loader future-proofs schema evolution here. |
| `identity` | object | Rendered into every system prompt. Bad values degrade gracefully to built-in defaults. |
| `values` | string[] | Listed in every system prompt under "VALUES". No runtime enforcement — these guide the LLM's reasoning. |
| `prohibitions` | object[] | Enforced at the tool-call gate in both System-1 and System-2. |

### Identity fields

```typescript
{
  name:     string   // "SUNNY"
  voice:    string   // "British male, calm, dry wit when appropriate"
  operator: string   // "Sunny" — the user's handle
}
```

All three surface in the system prompt's IDENTITY block. Empty strings
fall back to built-in defaults.

### Prohibition fields

```typescript
{
  description: string;              // shown in insights when block fires

  tools: string[];                  // [] means "all tools"
  after_local_hour:  number | null; // 0–23 inclusive
  before_local_hour: number | null; // 0–23 inclusive
  match_input_contains: string[];   // [] means "any input"
}
```

All specified filters must match for the prohibition to block — they're
AND-ed together.

## Hour-window semantics

The two hour fields define a window in the local timezone:

| `after` | `before` | Active when |
|---|---|---|
| `null` | `null` | Always (time doesn't restrict) |
| `22` | `null` | Hour ≥ 22 (so 22:00–23:59) |
| `null` | `7` | Hour < 7 (so 00:00–06:59) |
| `9` | `17` | 09:00–16:59 — same-day window |
| `22` | `7` | 22:00–06:59 — **wraps midnight** |

When `after > before`, the window wraps midnight. That's exactly what
you want for "no messages between 10 PM and 7 AM" without needing two
separate rules.

## Rule evaluation

```
for each prohibition in constitution.prohibitions:
  if prohibition.tools is non-empty AND toolName not in prohibition.tools:
    skip
  if not inside hour window:
    skip
  if prohibition.match_input_contains is non-empty AND
     no substring of JSON(input) matches any needle:
    skip
  → BLOCK with prohibition.description
→ ALLOW
```

**First match wins**. The description of the matching rule is the reason
the user sees in the `constitution_block` insight.

## The three-layer defense

Every tool call goes through three checks (see
[`docs/AGENT.md`](./AGENT.md#d-tool-branch--three-layer-defense)):

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — Constitution gate                                    │
│  Hard rule. No LLM call. Fail-safe on missing file (defaults).  │
│  Matches: tool name, local hour, input substrings.              │
│  On block: tool_result err + constitution_block insight.        │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 2 — Critic (only for tools with dangerous: true)         │
│  Cheap-model review of goal + tool + input + recent steps.      │
│  Returns approve / block / review.                              │
│  On block: abort with critic's reason, no user prompt.          │
│  On review / unavailable critic: fall through to layer 3.       │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 3 — ConfirmGate (user)                                   │
│  Modal UI. Always final authority. Persisted across runs.       │
│  User can approve, decline, or defer a dangerous action.        │
└─────────────────────────────────────────────────────────────────┘
```

**Key difference between layers 1 and 2**: Layer 1 is the **user's**
standing policy — they already said no at configuration time, so the
agent doesn't re-ask. Layer 2 is the critic's **judgment** — it can be
wrong, so it falls through to the user when unsure.

## Runtime enforcement — where it's wired

- `src/lib/constitution.ts` — TypeScript client + in-process gate
- `src/lib/agentLoop.ts` — `gateToolCall()` before every System-2 tool call
- `src/lib/skillExecutor.ts` — `gateToolCall()` before every recipe step
- `src-tauri/src/constitution.rs` — Rust-side source of truth + commands
  `constitution_get` / `constitution_save` / `constitution_check`

The TypeScript `checkTool()` is a deliberate duplicate of the Rust
`Constitution::check_tool` implementation. Running the check in-process
avoids an IPC round trip per tool call, and the Rust command remains
available for any backend caller (daemons, future UI pre-checks). The
two implementations must agree — both hit the same test cases.

## Client caching

The TypeScript client caches the fetched constitution for 60 seconds:

```ts
let cached: { value: Constitution; at: number } | null = null;
const CACHE_TTL_MS = 60_000;
```

A user saving a new constitution should call `invalidateConstitutionCache()`
(or the settings UI should call it). Otherwise the change takes effect
at the next cache expiration or app restart.

## Tauri command surface

### Read

```ts
const c = await invokeSafe<Constitution>('constitution_get');
```

### Write

```ts
await invokeSafe('constitution_save', { value: newConstitution });
invalidateConstitutionCache();
```

Writes the JSON atomically to `~/.sunny/constitution.json` (tmp + rename),
then swaps the in-memory `Arc`.

### Ad-hoc check

```ts
const res = await invokeSafe<CheckResult>('constitution_check', {
  tool: 'run_shell',
  input: { cmd: 'ls' },
});
// → { allowed: true, reason: null }
```

## Prompt rendering

The rendered constitution block is inserted into every system prompt
between the context pack and the protocol instructions:

```
IDENTITY
- Name: SUNNY
- Voice: British male, calm, dry wit when appropriate
- Operator: Sunny

VALUES
- Prefer concise over verbose — say less, mean more.
- Confirm destructive actions through the UI gate before running.
- Never share user secrets with cloud providers without explicit opt-in.
- Trust the user over learned facts when they conflict.

HARD PROHIBITIONS (enforced at tool-call gate; never rationalize around these):
- No iMessage after 10 PM unless I say yes this turn (tools=[messaging_send_imessage, messaging_send_sms] · after 22:00)
- Never rm -rf home directory (tools=[run_shell] · if input contains any of: "rm -rf /", "rm -rf ~", "rm -rf $HOME")
- No AppleScript after hours — too easy to misfire (tools=[applescript] · between 22:00 and 07:00)
```

The LLM sees these prohibitions **and** the runtime gate enforces them.
Both layers are important: the prompt-side nudges the LLM not to
propose prohibited calls at all; the gate is the guarantee when the
prompt nudge fails.

## Example constitutions

### Permissive default (what SUNNY ships with)

```json
{
  "schema_version": 1,
  "identity": {
    "name": "SUNNY",
    "voice": "British male, calm, dry wit when appropriate",
    "operator": "Sunny"
  },
  "values": [
    "Prefer concise over verbose — say less, mean more.",
    "Confirm destructive actions through the UI gate before running.",
    "Never share user secrets with cloud providers without explicit opt-in.",
    "Trust the user over learned facts when they conflict."
  ],
  "prohibitions": []
}
```

### "Don't bother my family at night"

```json
{
  "prohibitions": [
    {
      "description": "No messaging contacts between 10 PM and 7 AM",
      "tools": ["messaging_send_imessage", "messaging_send_sms"],
      "after_local_hour": 22,
      "before_local_hour": 7
    }
  ]
}
```

### "Work hours only, and never format disks"

```json
{
  "prohibitions": [
    {
      "description": "Destructive shell blocked outside work hours",
      "tools": ["run_shell", "applescript"],
      "after_local_hour": 18,
      "before_local_hour": 9
    },
    {
      "description": "Disk formatting forbidden",
      "tools": ["run_shell"],
      "match_input_contains": ["mkfs", "dd if=", "diskutil eraseDisk", "fdisk"]
    },
    {
      "description": "Never rm -rf root or home",
      "tools": ["run_shell"],
      "match_input_contains": ["rm -rf /", "rm -rf ~", "rm -rf $HOME"]
    }
  ]
}
```

### "All tools blocked in DND mode"

```json
{
  "prohibitions": [
    {
      "description": "Do Not Disturb — no tool calls at all",
      "tools": [],
      "after_local_hour": 22,
      "before_local_hour": 8
    }
  ]
}
```

Empty `tools` array is universal — this blocks **every** tool call in
the time window. The agent can still answer from memory (introspection's
`direct` mode) and reason verbally, but cannot take any action.

## Testing

`src-tauri/src/constitution.rs` ships with nine unit tests locking down
the evaluation semantics:

- `allow_by_default_with_no_prohibitions`
- `tool_scope_respects_name_list`
- `empty_tools_list_means_universal`
- `hour_window_same_day`
- `hour_window_wraps_midnight`
- `only_after_without_before_is_open_ended`
- `input_contains_blocks_only_on_match`
- `first_matching_prohibition_wins_with_its_description`
- `default_constitution_has_identity_and_values`

Run them:

```bash
cd src-tauri && cargo test --lib constitution
```

## Design principles

1. **User is the final authority.** The constitution is fully
   user-editable JSON. The agent can only become more permissive if the
   user widens the policy; it never auto-narrows.

2. **Fail-safe on a missing file.** If `constitution.json` is gone or
   malformed, the in-memory defaults kick in — permissive (no
   prohibitions) but with sensible identity + values. The app always
   boots.

3. **Both prompt-side and gate-side enforcement.** The prompt nudges the
   LLM to not propose prohibited actions; the runtime gate is the
   guarantee. Either alone is insufficient; together they cover both
   "well-behaved model" and "adversarial model" cases.

4. **Same policy across System-1 and System-2.** A compiled skill
   doesn't bypass the constitution. Goal-matched system prompts and
   deterministic recipes go through the same gate.

5. **Legibility.** Every block emits a visible `constitution_block`
   insight showing the description of the rule that fired. Users can
   see exactly why an action was refused.

## Further reading

- [`docs/AGENT.md`](./AGENT.md) — where the constitution fits in the turn
- [`docs/TOOLS.md`](./TOOLS.md) — which tools are flagged dangerous
- [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — recovering from a bad constitution
