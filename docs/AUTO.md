# AUTO — persistent AI agents, todos, scheduled jobs

The **AUTO** module is where SUNNY goes from "answer my question" to
"own this task in perpetuity". It has four tabs, ordered by the mental
model users actually reach for:

1. **AGENTS** — persistent AI daemons. Write a goal in plain English,
   pick a cadence, SUNNY runs it forever.
2. **TODOS** — traditional one-off task list.
3. **SCHEDULED** — classic cron-style recurring shell/notify/speak
   jobs (no LLM in the loop).
4. **ACTIVITY** — live view of everything running + recent history.

This document walks through the AGENTS + ACTIVITY flow in depth. TODOS
and SCHEDULED are straightforward CRUD surfaces.

---

## AGENTS — the headline feature

### What a "daemon" is

A daemon is a named, persistent goal that SUNNY wakes up on its own
schedule and attempts via the full agent tool loop.

Persisted fields (mirrors `Daemon` in `src-tauri/src/daemons.rs`):

```ts
type Daemon = {
  id: string;
  title: string;
  kind: 'once' | 'interval' | 'on_event';
  at: number | null;          // unix secs — `once` fires at this time
  every_sec: number | null;   // seconds — `interval` cadence
  on_event: string | null;    // named event — fires when emitted
  goal: string;               // plain-English directive to the agent
  enabled: boolean;
  next_run: number | null;
  last_run: number | null;
  last_status: string | null; // 'done' | 'error' | 'aborted' | 'max_steps'
  last_output: string | null; // truncated to 1000 chars
  runs_count: number;
  max_runs: number | null;    // auto-disables when hit
  created_at: number;
};
```

State lives at `~/.sunny/daemons.json` (mode `0600`, atomic rename on
write). Survives app restarts and upgrades.

### How a daemon fires

End-to-end when a scheduled daemon becomes due:

```
┌────────────────────────────────────────────────────────────┐
│ 1. Rust tick (Rust side)                                   │
│    daemons_ready_to_fire(now) returns enabled daemons      │
│    where next_run <= now and kind != 'on_event'.           │
├────────────────────────────────────────────────────────────┤
│ 2. Runtime poll (src/lib/daemonRuntime.ts, 15s interval)   │
│    for each due daemon, not already in-flight:             │
│      runId = useSubAgents.spawn(goal, `daemon:${id}`)      │
│      inFlight[id] = { runId, startedAt }                   │
├────────────────────────────────────────────────────────────┤
│ 3. Sub-agent worker (src/lib/subAgents.ts)                 │
│    drains the queue, picks up the spawned run, invokes     │
│    runAgent() (ReAct loop) with the full tool registry.    │
├────────────────────────────────────────────────────────────┤
│ 4. Zustand subscription (daemonRuntime.ts)                 │
│    on every useSubAgents change, checks in-flight entries  │
│    for terminal status. When one reaches done/aborted/     │
│    error/max_steps:                                        │
│      daemons_mark_fired(id, now, status, truncatedAnswer)  │
│      delete inFlight[id]                                   │
│      refresh daemons cache                                 │
├────────────────────────────────────────────────────────────┤
│ 5. Rust side persists                                      │
│    bumps runs_count, records last_run/last_status/         │
│    last_output, advances next_run per kind, auto-disables  │
│    once-daemons, disables interval when max_runs hit.      │
└────────────────────────────────────────────────────────────┘
```

`on_event` daemons skip step 1. They fire when anywhere in the UI
calls:

```ts
import { emitDaemonEvent } from '../lib/daemonRuntime';
await emitDaemonEvent('scan.completed');
```

Every enabled daemon whose `on_event` matches queues a sub-agent via
the same path. The scan module doesn't currently emit events — but the
hook is open for anything that wants to trigger an agent run without a
schedule.

`Run now` in the UI calls `runDaemonNow(daemon)` which takes the
schedule-bypass path: spawn a sub-agent immediately, register the fire
so the completion path will still call `daemons_mark_fired`.

### Starter templates

Twelve recipes ship under `src/pages/AutoPage/templates.ts`, grouped into
six categories:

| Category | Recipe | Cadence | What it does |
|---|---|---|---|
| **MORNING**  | Morning briefing     | 24 h | Calendar + top-3 priorities + urgent mail + weather, <200 words |
|              | End-of-day wrap      | 24 h | Completed vs still-open tasks, suggests tomorrow's top 3 |
| **FOCUS**    | Focus check-in       | 90 m | Notification asking "what are you working on?" + logs focus memory (gated 09:00–18:00) |
|              | Auto-generated standup | 24 h | Pulls tasks + calendar + agent runs → Yesterday/Today/Blockers memo tagged `#standup` |
| **INBOX**    | Inbox triage         | 30 m | Flags mail from known correspondents with deadlines ≤24h |
|              | iMessage digest      | 60 m | One-sentence summary per person with unreads |
| **CLEANUP**  | Downloads auto-sort  | 6 h  | Move >7-day files to dated archive, group by extension, skip <24h |
|              | Desktop zero         | 24 h | Archive >3-day files into `~/Desktop/Archive/<date>/` |
| **WATCHERS** | Security sweep       | 6 h  | Runs SCAN on ~/Downloads + LaunchAgents, notifies on hits |
|              | Running process audit| 24 h | Hashes every running binary against MalwareBazaar |
| **LEARN**    | Weekly review        | 7 d  | 300-word reflection from memory + tasks, tagged `#weekly-review` |
|              | Knowledge rotator    | 4 h  | Picks one random semantic fact, notifies as a recall-test question |

One click installs a template as a daemon. Installing a second copy of
the same template title is explicit ("INSTALLED · ADD COPY") so the user
can create per-project / per-scope variants.

Adding a template is a 10-line PR — see the `Template` type in
`src/pages/AutoPage/templates.ts`.

### Custom agents

`+ CUSTOM AGENT` opens an inline form:

- `TITLE` — short name shown in the AGENTS list.
- `GOAL` — free-form plain English. The ReAct loop + tool registry
  figure out the mechanics; goals should state *what* and *when*, not
  *how*.
- `KIND` — `interval` / `once` / `on_event`.
  - `interval` — preset chips for `15m / 30m / 1h / 4h / 12h / 1d`.
  - `once` — datetime-local input, fires once then auto-disables.
  - `on_event` — free-form event name; fires whenever the frontend
    calls `emitDaemonEvent('<name>')`.

Validation: the form refuses to submit until title is non-empty and goal
is ≥8 chars. Per-kind schedule fields are validated on the Rust side as
well — a malformed spec never corrupts the persistent file.

### Hard caps (Phase 5)

Three limits that the daemon surface enforces regardless of how the
spec reaches Rust (UI form, voice-driven `schedule_recurring` tool, or
direct Tauri command). Raising them is a conscious act — see
[`SECURITY.md#process-budget-phase-5`](./SECURITY.md#process-budget-phase-5)
for why each is where it is.

| Cap | Default | Constant |
|---|---|---|
| Enabled daemons at any one time | 32 | `daemons::MAX_ENABLED_DAEMONS` |
| Recurring cadence (`every_sec`) | ≥ 60s | `daemons::MIN_INTERVAL_SECS` / `MIN_CADENCE_SECS` |
| Open terminal sessions | 16 | `pty::MAX_PTY_SESSIONS` |

Adding the 33rd enabled daemon returns `daemon limit reached: 32 enabled
daemons (max 32). Disable or delete an existing one before adding
another.` Scheduling sub-minute cadence (e.g. `every_sec: 30`) returns
`cadence too fast: 30s (min 60s). Sub-minute recurring agent runs are
refused to prevent spawn fanout.`

### Quarantine on abnormal exit

If SUNNY exits via crash, SIGKILL, or force-quit — anything that skips
the normal Tauri `RunEvent::Exit` path — the boot guard detects the
surviving `~/.sunny/booting.marker` on the next launch and flips every
enabled daemon to `enabled=false`, `last_status="quarantined_on_boot"`,
`next_run=null`. The AGENTS list shows them as **PAUSED** with the
quarantine status; hit `RESUME` deliberately once you know why the
prior session died. Panic mode (`P` on Security page) engages the same
disable path for the user-initiated case; quarantine covers the "no
human got to react" case.

### Row anatomy

An installed-agent row is a compressed single-liner that expands to a
full detail pane:

Collapsed — `[ STATUS chip ] [ title + schedule + run count ] [ NEXT meta ] [ LAST meta ] [ ▸ ]`

The status chip has three levels:

- **RUNNING** — cyan, with a pulsing dot (the theme's `pulseDot`
  keyframe). Appears while `inFlightDaemonIds()` contains this id.
- **ARMED** — green. Enabled, waiting for its next fire.
- **PAUSED** — dim. Disabled via the `PAUSE` action.

The left border picks up the status color and the background gradient
lights up briefly while running.

Expanded pane shows the full `goal` text, the `last_output` block
colored by `last_status` (green done / amber aborted / red error), and
four actions: `RUN NOW`, `PAUSE`/`RESUME`, 2-click `DELETE`.

### Max-runs and auto-disable

Set `max_runs` on a daemon (not yet exposed in the UI — submit via
`daemonsAdd` programmatically) to cap total executions. The Rust side
auto-disables the daemon when the cap is hit. Useful for migration
daemons that should run a fixed number of times.

`Once` daemons always auto-disable after their single fire — you'll
see them drop from `ARMED → PAUSED` without user interaction.

---

## ACTIVITY — the "what's running" surface

Three panes stack top-to-bottom:

### `LIVE · N ACTIVE`

Every sub-agent whose status is `queued` or `running`, newest first.
Each row gets a pulsing status chip and, if it was spawned by a
daemon (the `parent` id starts with `daemon:`), a breadcrumb linking
back to the daemon title.

### `RECENT FIRES · N`

The last 10 daemons to fire. Colored `last_status` chip, run count, and
an expandable `last_output` block. Orders by `last_run` descending, so
"the agent I just ran" sits at the top.

### `COMPLETED SUB-AGENTS · N`

The last 12 terminated sub-agent runs (done/aborted/error/max_steps).
Expanding a row shows the full `finalAnswer`. `CLEAR FINISHED` wipes
terminal runs from the sub-agent store without touching anything still
queued or running.

---

## TODOS and SCHEDULED

**TODOS** is the same one-off task list from before the restructure —
text input, filter by all/open/done, checkbox to toggle, × to delete,
`CLEAR COMPLETED` sweeper. Persists to localStorage only (no
`~/.sunny/` file); tasks aren't sensitive enough to warrant a disk
write.

**SCHEDULED** is the older recurring-job scheduler — `Once`/`Interval`
jobs that fire `Shell` / `Notify` / `Speak` actions. Separate from
AGENTS because these run entirely in Rust without touching the LLM —
great for `rsync -a ~/code ~/backups` every 6 hours, not so great for
"summarize my week".

---

## Tab chrome

Each tab chip has a live `· N` badge (armed daemons, open todos,
active scheduler jobs, active sub-agent runs) derived from the same
stores the tabs subscribe to — no extra polling.

Hotkeys while the AUTO page is focused:

- `1` — AGENTS
- `2` — TODOS
- `3` — SCHEDULED
- `4` — ACTIVITY

Guarded against text inputs so typing a digit into a form field doesn't
teleport you.

---

## Relationship to other modules

- **MEMORY** — daemons freely read and write memory via the tool
  registry (`memory_add`, `memory_search`, `memory_list`). Many starter
  templates (`Auto-generated standup`, `Weekly review`) persist output
  as semantic memory tagged with `#standup` / `#weekly-review`.
- **SCAN** — the `Security sweep` and `Running process audit`
  templates call the scan tool chain (`scan_start`, `scan_findings`),
  so the agent can actually triage malware on your behalf.
- **NOTIFY** — any daemon whose goal says "notify me" ends up calling
  `notify_send` via the tool loop. The macOS notification arrives while
  the user is anywhere on their machine, not just inside SUNNY.
- **CALENDAR / MAIL / MESSAGES** — morning/inbox templates pull from
  the read tools (`calendar_list_events`, `mail_list_recent`,
  `messaging_fetch_conversation`) — everything gated by the
  constitution.

---

## Delegation — agents that spawn agents

A daemon run starts as a single sub-agent, but it's not limited to one.
The agent loop exposes a small family of **delegation tools** that let
the ReAct loop fan out work across a fleet of helper sub-agents — each
with its own goal, step budget, transcript, and tool registry.

### Why delegate

Without delegation the agent has to serialise everything inside one
12-step ReAct budget. Tasks like "audit deps in 8 repos" or "research 5
topics" blow through that budget before they start. Delegation turns
N-way fan-out into one tool call, collects structured results, and
shows each child in the `ACTIVITY` tab so you can watch the fleet.

### The tools

| Tool | Shape | When to use |
|---|---|---|
| `spawn_parallel` | `{ goals: string[], labels?: string[], wait?: bool, timeout_sec?: number }` | **The default.** Fans out N independent goals in one call, blocks on all of them, and returns per-child status + final answer in the same order. Max 12 goals per call. |
| `spawn_subagent` | `{ goal, wait?, timeout_sec?, label? }` | Single child. Fire-and-forget (`wait:false`) lets you keep working while a long task runs; `wait:true` blocks for the answer. |
| `subagent_wait_all` | `{ ids: string[], timeout_sec? }` | Block on a fleet you spawned earlier. One tool call replaces N `subagent_wait` loops. |
| `subagent_wait` | `{ id, timeout_sec? }` | Block on one child. |
| `subagent_status` | `{ id }` | Cheap, non-blocking status read. |
| `subagent_list` | `{ limit?, status?, parent? }` | Fleet overview with filters. |
| `subagent_abort` | `{ id }` | Cancel a queued or running child. |

### Safety rails

- **Max depth = 3.** The parent label carries `@depth:N` segments;
  `parseParentDepth` reads the deepest value and the spawn tools
  refuse deeper nesting. Runaway recursion is structurally impossible.
- **Max concurrency = 4** (configurable up to 8 in the sub-agent
  store). Extra spawns queue — they don't fail.
- **Cancel cascade.** When the parent run's `AbortSignal` fires
  (user hit STOP, constitution gate denied something, etc.), every
  child the run ever spawned is aborted automatically. No orphans.
- **Depth ledger via `AbortSignal` WeakMap.** Parent context is keyed
  on per-tool signals so concurrent runs never clobber each other's
  depth counter.

### Prompt-side guidance

The delegation rules live in `PROTOCOL_INSTRUCTIONS` inside
`src/lib/agentLoop.ts`. Every sub-agent sees the same DELEGATION
section, so a grandchild that inherits a goal like
"research 3 topics" will itself use `spawn_parallel` — recursion just
stops when depth hits 3.

Key rules the agent sees:

- **N-way fan-out → `spawn_parallel`.** Split the collection first; give
  each child ONE item.
- **Long isolated sub-task → `spawn_subagent wait:false`**, keep
  working, collect with `subagent_wait` or `subagent_wait_all` later.
- **Tight tool chains stay inline** — serial `web_fetch` → `memory_add`
  has no fan-out win.
- **Self-contained goals.** Sub-agents start with empty transcripts;
  restate every fact they need. Goals must also specify the exact
  output format the child must return (e.g. `"return EXACTLY: ID::... TITLE::..."`)
  so the parent can parse the result reliably.

### Starter templates that use delegation

| Template | Fan-out |
|---|---|
| `Security sweep` | 2 concurrent scans (Downloads + LaunchAgents) |
| `Dependency audit` | 1 sub-agent per repo |
| `TODO miner` | 1 sub-agent per repo |
| `Git hygiene` | 1 sub-agent per repo |
| `News digest` | 1 sub-agent per `#interest` topic |
| `arXiv daily` | 1 sub-agent per `#interest` topic |
| `Research digest` | 1 sub-agent per topic (deep_research is slow per call) |
| `Competitor watch` | 1 sub-agent per competitor URL |
| `Price drop watcher` | 1 sub-agent per tracked product |
| `Thread catch-up` | 1 sub-agent per unread iMessage thread |

Every fan-out template follows the same pattern:

1. Resolve the collection (`memory_search` or shell listing).
2. `spawn_parallel wait:true` with one goal string per item.
3. Parse structured child responses from `data.results`.
4. Aggregate into a Notes doc + dedupe memory entries.
5. Speak only if the aggregate crosses a threshold.

---

## Files

| Path | Role |
|---|---|
| `src-tauri/src/daemons.rs` | Rust store + `daemons_*` commands |
| `src/store/daemons.ts` | Zustand cache + typed API bindings |
| `src/lib/daemonRuntime.ts` | Polling tick + sub-agent dispatch + mark-fired |
| `src/pages/AutoPage/index.tsx` | Tab container + hotkeys + badges |
| `src/pages/AutoPage/AgentsTab.tsx` | AGENTS tab UI |
| `src/pages/AutoPage/templates.ts` | 12 starter recipes |
| `src/pages/AutoPage/ActivityTab.tsx` | ACTIVITY tab UI |
| `src/pages/AutoPage/TodosTab.tsx` | TODOS tab UI |
| `src/pages/AutoPage/ScheduledTab.tsx` | SCHEDULED tab UI |

---

## Opening the hook for external triggers

`emitDaemonEvent(name)` is exported from `src/lib/daemonRuntime.ts`.
Any module that wants to trigger an on_event daemon fires it:

```ts
import { emitDaemonEvent } from '../../lib/daemonRuntime';

// Example: after a successful scan finishes
await emitDaemonEvent('scan.completed');
```

Every enabled daemon with `kind: 'on_event'` and matching `on_event`
spawns a sub-agent. Use this for event-driven automations that don't
fit on a clock — file drops into a watched folder, scan verdict,
incoming iMessage from a starred contact, etc.
