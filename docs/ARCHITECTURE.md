# Architecture

SUNNY is a Tauri 2 desktop app. Rust owns the backend (macOS integrations,
memory DB, agent loop, browser, PTY), React owns the frontend (HUD, pages,
tool registry). The boundary is a set of `#[tauri::command]` functions bridged
by Tauri's IPC and an event bus (`sunny://` custom events).

---

## Tauri 2 layout

```
Sunny/
├─ src/                     React app (Vite, TypeScript)
│  ├─ App.tsx               boot: registers tools, starts background loops
│  ├─ components/           shared HUD chrome (Dashboard, NavPanel, QuickLauncher, …)
│  ├─ pages/                one folder per module page (lazy-loaded via pages.ts)
│  ├─ store/                zustand stores (view, agent, memory, terminals, …)
│  ├─ lib/                  agent stack (agentLoop, planner, reflect, society, …)
│  └─ hooks/                voice chat, voice activity, wake-word
│
└─ src-tauri/               Rust crate
   ├─ src/
   │  ├─ main.rs            Tauri builder → lib.rs::run()
   │  ├─ lib.rs             crate root: mod declarations + run() + invoke_handler!
   │  ├─ commands.rs        125 thin #[tauri::command] wrappers
   │  ├─ startup.rs         .setup hook body + background tokio loops
   │  ├─ agent_loop/        ReAct driver + provider adapters (see below)
   │  ├─ memory/            3-store SQLite + embeddings
   │  ├─ browser/           hardened multi-profile browser
   │  ├─ world/             continuous world model
   │  ├─ voice/              Kokoro TTS daemon — sub-module split (Phase 2)
   │  │  ├─ mod.rs          public API, daemon lifecycle (speak, barge-in, queue)
   │  │  ├─ config.rs       voice catalogue, DEFAULT_VOICE constant
   │  │  └─ normalize.rs    text-normalisation helpers (resolve_voice, wpm_to_speed,
   │  │                       clean_for_kokoro, say_compatible_voice)
   │  ├─ ambient/            Proactive world-model watcher — sub-module split (Phase 3)
   │  │  ├─ mod.rs          daemon start, process_world, spawn_classifier, tests
   │  │  ├─ store.rs        AmbientDisk, DISK static, load_disk / save_disk
   │  │  ├─ settings.rs     AmbientSettings, per-setting constants
   │  │  └─ rules.rs        evaluate, gap_ok, compound synthesis, Surface type
   │  ├─ commands/memory/    Memory Tauri commands — sub-module split (Phase 3)
   │  │  ├─ mod.rs          memory_pack, memory_stats (cross-domain) + layout //!
   │  │  ├─ episodic.rs     memory_episodic_* commands
   │  │  ├─ semantic.rs     memory_fact_* commands
   │  │  ├─ procedural.rs   memory_skill_* commands
   │  │  ├─ compact.rs      memory_compact*, memory_consolidator_* commands
   │  │  ├─ retention.rs    memory_retention_* commands
   │  │  ├─ tool_usage.rs   tool_usage_* commands
   │  │  ├─ conversation.rs conversation_* commands
   │  │  └─ legacy.rs       memory_add/list/search/delete (deprecated aliases)
   │  └─ … ~30 domain modules (calendar, mail, ax, vision, ocr, pty, …)
   └─ Cargo.toml
```

### Adding a new Tauri command

> **Editing SUNNY config files from the webview?** Use `open_sunny_file(filename)`
> (defined in `commands/fs.rs`) instead of `open_path`. It accepts a bare filename
> with no path separators, resolves to `~/.sunny/<filename>`, validates via
> `assert_read_allowed`, and is the safe-by-design surface for any webview-initiated
> edits of SUNNY config files (`constitution.json`, `daemons.json`, etc.).

### Adding a new Tauri command

1. Write the function in the appropriate domain module (e.g. `src-tauri/src/calendar.rs`).
   Mark it `#[tauri::command]` and add it to the module's `pub use` in `mod.rs` or return it directly.
2. Add a thin wrapper in `src-tauri/src/commands.rs` if the function needs
   AppHandle injection or extra validation.
3. Register it in `lib.rs`'s `invoke_handler!` macro — one entry per command.
4. Add the TypeScript binding in `src/bindings/` or call via `invokeSafe(name, args)`.
5. If the command is agent-accessible, add a `ToolSpec` entry in
   `src-tauri/src/agent_loop/catalog.rs` (dangerous flag, trust class) and a
   matching frontend tool spec in `src/lib/tools/builtins/<domain>.ts`.

---

## agent_loop module

`src-tauri/src/agent_loop/` is the ReAct driver. `agent_run` is the single
public Tauri command; everything else is internal.

```
agent_loop/
├─ mod.rs          pub use core::agent_run — the only public export
├─ core.rs         agent_run_inner — the shared driver for main + sub-agents
│                    • picks backend via pick_backend()
│                    • builds system prompt (safety amendment + constitution + memory digest)
│                    • ReAct loop: up to MAX_ITERATIONS (8) iterations
│                    • emits sunny://agent.step live during the run
├─ providers/
│  ├─ anthropic.rs  streaming + non-streaming turns against Claude API
│  ├─ ollama.rs     streaming + non-streaming turns; model auto-selection
│  ├─ glm.rs        GLM provider adapter
│  └─ auth.rs       key presence checks (no key storage — keys come from secrets.rs)
├─ dispatch.rs     dispatch_tool — the single choke-point for every tool call
│                    • panic-mode short-circuit
│                    • pre-dispatch security audit (rate anomaly, outbound scan,
│                      role scoping, enforcement policy, constitution gate)
│                    • ConfirmGate for dangerous / force-confirm-all tools
│                    • trait-registry dispatch via tool_trait::find + inventory
├─ catalog.rs      static ToolSpec slice + trust_class() + is_dangerous()
├─ prompts.rs      SAFETY_AMENDMENT, TOOL_USE_DIRECTIVE, compose_system_prompt()
├─ subagents.rs    spawn_subagent — nested agent_run_inner at depth+1
│                    • recursion guard: MAX_SUBAGENT_DEPTH = 3
│                    • role-based model selection
│                    • events on sunny://agent.sub instead of sunny://agent.step
├─ memory_integration.rs  auto_remember_from_user, build_memory_digest, write_run_episodic
├─ scope.rs        allowed_tools_for_role — Society tool allowlist per specialist
├─ confirm.rs      request_confirm — sends sunny://confirm.request, awaits response
├─ helpers.rs      emit_agent_step, finalize_with_note, pretty_short, truncate
├─ types.rs        TurnOutcome, Backend, ToolCall, ToolOutput, ToolError
├─ analyze_messages.rs   classify messages for memory auto-remember
├─ claude_code.rs  claude_code_run tool implementation
├─ deep_research.rs  deep_research tool (multi-step browse + summarize)
└─ remember_screen.rs  remember_screen tool (OCR + episodic write)
```

### Tuning knobs in core.rs

| Constant | Default | Purpose |
|---|---|---|
| `TOTAL_TIMEOUT_SECS` | 120 | Wall-clock ceiling per `agent_run` invocation |
| `MAX_ITERATIONS` | 8 | Max ReAct turns before returning fallback |
| `CONFIRM_TIMEOUT_SECS` | 30 | User must approve/deny dangerous tool within this window |
| `MAX_SUBAGENT_DEPTH` | 3 | Recursion guard for spawned sub-agents (vertical) |

### Process-budget tuning knobs (Phase 5)

Separate from the agent-loop knobs above — these live outside `core.rs`
and cap the absolute amount of OS work the whole app can commission.
Full narrative in [`SECURITY.md`](./SECURITY.md#process-budget-phase-5);
pointer here for quick reference while reading architecture code.

| Constant | Default | File | Purpose |
|---|---|---|---|
| `NPROC_CEILING` | 1024 | `process_budget.rs` | `setrlimit(RLIMIT_NPROC)` — SUNNY's own fork ceiling (below ~1418 uid default) |
| `SPAWN_PERMITS` | 16 | `process_budget.rs` | Global `Semaphore` permits; `SpawnGuard::acquire` gates high-risk spawns |
| `SPAWN_ACQUIRE_TIMEOUT` | 30s | `process_budget.rs` | Max wait for a permit before surfacing "spawn budget exhausted" |
| `MAX_ENABLED_DAEMONS` | 32 | `daemons.rs` | Refuse `daemons_add` once 32 daemons are already enabled |
| `MIN_INTERVAL_SECS` | 60 | `daemons.rs` | Recurring daemons rejected below 60s cadence |
| `MIN_CADENCE_SECS` | 60 | `src/lib/tools/builtins/daemon.ts` | `schedule_recurring` LLM-tool floor — mirrors Rust cap |
| `MAX_PTY_SESSIONS` | 16 | `pty.rs` | `pty::open` refuses past 16 simultaneous terminals |
| `MAX_LIVE_SIBLINGS` | 4 | `agent_loop/subagents.rs` | Breadth cap — 4 concurrent children per parent agent |

Supporting infrastructure:
- `src-tauri/src/boot_guard.rs` — `~/.sunny/booting.marker` for crash
  detection. `arm()` at startup, `disarm()` on `RunEvent::Exit`.
  Surviving marker triggers `daemons::quarantine_on_disk()`.
- `agent_loop::dialogue::count_live_children(parent_id)` — powers the
  `MAX_LIVE_SIBLINGS` check by scanning the parent-child registry for
  still-running children (registered but no `set_result` yet).

---

## Memory stack

`src-tauri/src/memory/` — SQLite at `~/.sunny/memory/memory.sqlite`, WAL mode,
schema versioned via the `meta` table (current: v8).

```
memory/
├─ db.rs          OnceLock<Mutex<Connection>> singleton + reader pool (4 connections).
│                   with_conn() — writer path (serialised through mutex).
│                   with_conn_in(conn, f) — test-injection helper: runs f against
│                     a caller-supplied scratch connection; keeps production call
│                     sites unchanged and unit tests fully isolated.
│                   with_reader() — borrows a read-only WAL connection from the
│                     pool; falls back to with_conn when the pool is empty.
│                   Schema migrations v1–v8; init_reader_pool seeded post-schema.
├─ episodic.rs    chronological events — 6 kinds: user, agent_step, perception,
│                   reflection, note, tool_call. FTS5 virtual table with triggers.
├─ semantic.rs    durable facts — idempotent upsert on (subject, text).
│                   confidence + source fields. FTS5 virtual table.
├─ procedural.rs  skills — name + description + trigger + recipe_json + uses_count
│                   + success_count (schema v4). Unique by name.
├─ embed.rs       Ollama nomic-embed-text client, f32 BLOB codec, cosine distance.
│                   start_backfill_loop fills NULL embeddings 8 rows / 30 s.
├─ pack.rs        build_pack: FTS prefilter (4× widen) → cosine rerank → top-K.
│                   Budget-aware: drops matched_episodic first if over 6 000 tokens.
├─ consolidator.rs  watermark-based pending() / mark_done() for the TS consolidator loop.
├─ retention.rs   daily sweep — deletes perception > 14d, agent_step > 28d (except
│                   has-lesson), tool_usage > 30d. Never touches user / note / reflection.
├─ tool_usage.rs  tool_usage table: name, ok, latency_ms, error_msg, recorded_at.
│                   Feeds critic reliability prior and Memory → Tools tab.
└─ mod.rs
```

**Retrieval path**: FTS5 keyword search, widen by 4×, fetch embeddings for
candidates, cosine-rerank, return top-K. Falls back to FTS-only when Ollama is
unreachable. The pack is assembled once at turn start and injected into the
system prompt.

### `with_conn_in` — test helper for isolated unit tests

`db::with_conn_in(conn, f)` runs the closure `f` against a caller-supplied
`Connection` instead of the global `OnceLock` singleton. This lets unit tests
open a scratch DB in a temp dir, run full schema migrations via `init_in`, and
call any memory module function without touching the production singleton:

```rust
let (_dir, conn) = scratch_conn("my-test");
with_conn_in(&conn, |c| {
    episodic::add(c, "user", "test text", &[], &{})?;
    let rows = episodic::search(c, "test", 10)?;
    assert_eq!(rows.len(), 1);
    Ok(())
})?;
```

`scratch_conn` is `pub(crate)` in `memory::db::tests` and re-exported to sibling
test modules. `with_conn_in` stays in the production binary (zero overhead) to
avoid conditional-compilation complexity at import sites.

---

## Scheduler and daemons — two parallel systems

There are two distinct automation systems. They are NOT interchangeable.
Confusing them is the most common source of "my scheduled agent isn't running"
bugs.

### scheduler.rs — Rust-side shell executor

`src-tauri/src/scheduler.rs`. Stores jobs in `~/.sunny/scheduler.json`.
Ticks every 10 s on a tokio task inside the Tauri setup hook.

- **Executes in Rust** — runs shell commands, `osascript` notifications, `say`,
  or `agent_goal` strings through the Ollama loop directly.
- **Job kinds**: `Once`, `Interval`.
- **No UI participation** — jobs fire and record output without touching the
  React sub-agent machinery.
- **Surface**: the SCHEDULED tab in AutoPage (via `scheduler_*` Tauri commands).

### daemons.rs — frontend-orchestrated AI agents

`src-tauri/src/daemons.rs`. Stores daemons in `~/.sunny/daemons.json`.
Rust is a **pure store with a ready-check** — it never runs goal execution.

- **Executes on the frontend** — `daemonRuntime.ts` polls `daemons_ready_to_fire`
  every 15 s, spawns each due daemon via `useSubAgents.spawn(goal)`, and calls
  `daemons_mark_fired` with the result. This keeps daemon runs visible in the
  sub-agent card and routed through the full ReAct loop with all tools.
- **Daemon kinds**: `Once`, `Interval`, `on_event` (triggered by name via
  `emitDaemonEvent()`).
- **Surface**: the AGENTS tab in AutoPage.

**Rule of thumb**: if the automation needs to call agent tools and show up in
the activity feed, it's a daemon. If it needs to run a shell script on a tight
schedule without LLM involvement, it's a scheduler job.

---

## Event bus

The frontend and Rust communicate in two directions over named custom events.
All SUNNY-originated events use the `sunny://` scheme; Tauri commands use `invoke`.

### Rust → Frontend (emit)

| Event | Payload | Source |
|---|---|---|
| `sunny://agent.step` | `AgentStep` (kind, label, detail) | `core.rs::emit_agent_step` |
| `sunny://agent.sub` | `SubAgentEvent` (sub_id, kind, …) | `subagents.rs::emit_sub_event` |
| `sunny://chat.chunk` | `{ delta: string }` | `providers/anthropic.rs`, `providers/ollama.rs` |
| `sunny://chat.done` | `{ reply: string }` | `core.rs` (main agent only) |
| `sunny://world.focus` | `FocusSnapshot` | `world/side_effects.rs` |
| `sunny://clipboard` | `ClipboardEntry` | `startup.rs` sniffer |
| `sunny://metrics` | `MetricsPayload` | `startup.rs` emitter |
| `sunny://confirm.request` | `ConfirmRequest` (id, tool, input) | `confirm.rs` |
| `sunny://confirm.response` | `{ id, approved }` | sent from frontend, read by `confirm.rs` |
| `sunny://nav` | `{ view: ViewKey }` | tray.rs, menu.rs |
| `browser:download:update` | download job progress | `browser/downloads.rs` |
| `messages:new` | new iMessage(s) | `messages_watcher.rs` |

### The `SunnyEvent` envelope

All Rust → frontend events that traverse the event bus proper (not raw Tauri
`emit`) are wrapped in the `SunnyEvent` enum defined in
`src-tauri/src/event_bus.rs` and mirrored in
[`src/bindings/SunnyEvent.ts`](../src/bindings/SunnyEvent.ts). Every variant
carries a monotonic `seq: u64` and a `boot_epoch: u64` as a composite dedupe
key so the frontend can detect and discard replays across app restarts.
**Wrapped** payloads are those published via `event_bus::publish` (agent steps,
chat chunks, world ticks, security events, sub-agent lifecycle, daemon fires).
**Bare** payloads — emitted directly via Tauri's `AppHandle::emit` — skip the
envelope: `browser:download:update`, `messages:new`, and the confirm
request/response pair are bare because they are point-to-point and do not need
global sequence numbering.

### Frontend → Rust

Standard Tauri IPC: `invoke('command_name', args)` via `src/lib/tauri.ts::invokeSafe`.

### Frontend custom window events (React → React)

Some components communicate via `window.dispatchEvent` without going through
Rust. Notable examples:

| Event | Purpose |
|---|---|
| `sunny-terminals-open` | Opens the TerminalsOverlay from any tile |
| `sunny-ql-open` / `sunny-ql-toggle` | Opens QuickLauncher from tray |
| `sunny:web:open-new-tab` | Browser right-click "open in new tab" |

---

## Frontend pages map

All pages are lazy-loaded. `src/pages/pages.ts` maps `ViewKey` → `React.lazy(import(...))`.

| ViewKey | Folder | Notes |
|---|---|---|
| `today` | `TodayPage/` | Daily overview |
| `timeline` | `TimelinePage/` | L/R arrow nav, URL-hash kind filter |
| `security` | `SecurityPage/` | Network audit, panic mode |
| `tasks` | `TasksPage/` | ⌘A select-all, Delete, C complete |
| `journal` | `JournalPage/` | |
| `focus` | `FocusPage/` | |
| `calendar` | `CalendarPage.tsx` | Live macOS Calendar.app; ←/→/N/T/G/Esc |
| `inbox` | `InboxPage/` | |
| `people` | `PeoplePage/` | |
| `contacts` | `ContactsPage/` | iMessage proxy, send/call tools |
| `voice` | `VoicePage/` | Space record toggle |
| `notify` | `NotifyPage/` | |
| `notes` | `NotesPage/` | |
| `reading` | `ReadingPage/` | |
| `memory` | `MemoryPage/` | 6 tabs 1-6; radial graph; FTS search |
| `photos` | `PhotosPage/` | |
| `files` | `FilesPage/` | Full file manager; ⌘N, ⌘⇧N, Delete |
| `auto` | `AutoPage/` | Agents 1 / Todos 2 / Scheduled 3 / Activity 4 |
| `skills` | `SkillsPage/` | Up/Down REPL history |
| `apps` | `AppsPage/` | Full app manager; ↑↓←→, F, R, H, Q |
| `web` | `WebPage/` | Multi-profile browser; ⌘T/W/L/R/[/] |
| `code` | `CodePage/` | Up/Down REPL history |
| `console` | `ConsolePage/` | Up/Down REPL history |
| `screen` | `ScreenPage/` | Space capture, ⌘R recapture, O OCR |
| `scan` | `ScanPage/` | 4 tabs 1-4, / for findings search |
| `world` | `WorldPage/` | Live world model viewer |
| `society` | `SocietyPage/` | Agent Society inspector |
| `brain` | `BrainPage/` | |
| `persona` | `PersonaPage/` | |
| `inspector` | `InspectorPage/` | |
| `audit` | `AuditPage/` | |
| `devices` | `DevicesPage/` | |
| `vault` | `VaultPage/` | |
| `settings` | `SettingsPage/` | 3 tabs: General / Capabilities / Constitution |

---

## How to add a new tool

1. **Decide where it runs.** Most tools call a Rust `#[tauri::command]` via `invokeSafe`.
   Pure-compute tools can live entirely in TypeScript.

2. **Write the Rust command** (if needed) in the appropriate domain module.
   Register it in `lib.rs::invoke_handler!` and in `commands.rs` if it needs
   `AppHandle`.

3. **Create the frontend tool spec.** Add a file in `src/lib/tools/builtins/<domain>.ts`
   (or a new `tools.<domain>.ts` side-effect import):

   ```ts
   import { registerTool } from '../tools/registry';

   registerTool({
     schema: {
       name: 'my_tool',
       description: 'Does X. Use when Y.',
       input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
     },
     dangerous: false,        // true → critic + ConfirmGate
     run: async ({ query }, _signal) => {
       const result = await invokeSafe('my_tool', { query });
       return { ok: true, value: result };
     },
   });
   ```

4. **Register it in the catalog** (`src-tauri/src/agent_loop/catalog.rs`):
   - Add a `ToolSpec` entry with `name`, `description`, and `input_schema`.
   - Classify the trust class in `trust_class()` and add to `is_dangerous()` if warranted.

5. **Import the module** in `App.tsx` (side-effect import: `import './lib/tools.<domain>'`).
   This is the step most commonly missed — without it the tool is registered in catalog.rs
   but invisible to the frontend tool registry, so the agent sees it but can't execute it.

6. **Test**: ask the agent to call the new tool by name in chat, then check the
   Memory → Tools tab for a recorded call.

---

## How to add a new page

1. **Create the folder** `src/pages/<Name>Page/` with `index.tsx` as the entry point.
   Export a named component (`export function NamePage() { … }`).

2. **Add the ViewKey** to `src/store/view.ts` — add the string literal to the `ViewKey`
   union type.

3. **Register the lazy import** in `src/pages/pages.ts`:

   ```ts
   mypage: lazyPage(() => import('./MyPage'), 'MyPage'),
   ```

4. **Add a nav entry** in `src/components/NavPanel.tsx` (or wherever `NAV_MODULES` is
   seeded). Match the `ViewKey` string exactly.

5. **Update `CommandBar/constants.ts`** (`NAV_TARGETS`) and `HelpOverlay` if those
   surfaces enumerate modules. Search the codebase for an existing ViewKey string
   (e.g. `"memory"`) to find every place that needs a new entry.

6. **Add a macOS menu item** in `src-tauri/src/menu.rs` if the page should be
   reachable from the View menu (optional).

7. **Wire keyboard shortcut** (`⌘1`–`⌘9` or page-local hotkey) in `Dashboard.tsx`
   or inside the page component.

---

## Further reading

- `docs/AGENT.md` — full turn dispatch annotated with file:line refs
- `docs/MEMORY.md` — schema, retrieval, consolidation, retention
- `docs/SKILLS.md` — recipe format, synthesis, authoring
- `docs/CONSTITUTION.md` — values, prohibitions, runtime gate
- `docs/BROWSER.md` — browser threat model, dispatcher contract, profiles
- `docs/TOOLS.md` — full tool registry reference (46+ tools)
- `docs/CONTRIBUTING.md` — dev workflow, Tauri setup, style conventions
