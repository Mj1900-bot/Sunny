# Changelog

All notable changes to SUNNY, grouped by phase. Each phase is a
coherent, independently-shippable piece of the cognitive architecture.

Format loosely inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Phase 5 — process budget + fork-bomb defence (SHIPPED)

Motivated by two prior incidents where attempts to extend SUNNY's autonomy
exhausted `kern.maxprocperuid` (~1418 on Apple Silicon) and broke every
Terminal window on the user's Mac until reboot. Root cause was a structural
gap: the codebase had **zero** global process-concurrency limits — only the
existing `MAX_SUBAGENT_DEPTH=3` guard, which capped vertical recursion but
not horizontal fan-out or daemon/PTY count. Phase 5 closes the gap with a
five-layer defence that makes uid-wide exhaustion impossible by construction.

- **Process budget module** (`src-tauri/src/process_budget.rs`, new).
  `install_rlimit()` lowers SUNNY's soft `RLIMIT_NPROC` to `NPROC_CEILING =
  1024` at startup — SUNNY hits its own ceiling before the uid does, so a
  runaway tool handler crashes inside SUNNY rather than taking Terminal.app
  down with it. Global `SpawnGuard` holds permits from a `SPAWN_PERMITS = 16`
  `tokio::sync::Semaphore`; `SpawnGuard::acquire().await` with a 30s timeout
  gates high-fan-out paths. `spawn_budget_snapshot()` exposes the current
  permit usage for the diagnostics panel.
- **Crash quarantine** (`src-tauri/src/boot_guard.rs`, new). Writes
  `~/.sunny/booting.marker` at startup, clears it in the Tauri
  `RunEvent::Exit` handler. If the marker survives into the next boot
  (crash, SIGKILL, force-quit during spawn fanout), `daemons::
  quarantine_on_disk` flips every enabled daemon to `enabled=false` with
  `last_status = "quarantined_on_boot"` so a crash-loop can't replay. User
  re-enables deliberately from the AUTO page. 4 hermetic unit tests.
- **Per-surface caps.**
  - `daemons::MAX_ENABLED_DAEMONS = 32` — `daemons_add` refuses when the
    currently-enabled count reaches the cap.
  - `daemons::MIN_INTERVAL_SECS = 60` — Rust-side floor on recurring
    cadence; `schedule_recurring` (TS) mirrors it with `MIN_CADENCE_SECS = 60`.
    Sub-minute recurring agent runs were the prior fork-bomb amplifier.
  - `pty::MAX_PTY_SESSIONS = 16` — `pty::open` refuses past the cap.
    Idempotent replace still works for the same session id.
  - `agent_loop::subagents::MAX_LIVE_SIBLINGS = 4` — breadth guard on top
    of the existing depth cap. `agent_loop::dialogue::count_live_children`
    powers the check by scanning the parent-child registry for still-
    running children.
- **Zombie reap.** `scheduler::run_action`'s `Speak` branch now holds a
  `SpawnGuard`, sets `kill_on_drop(true)`, and detaches a `tokio::spawn`
  that awaits `child.wait()` so the process-table slot returns on
  completion instead of lingering until launchd reaps (tokio#2685
  pattern). The `claude_code` bridge (`agent_loop/tools/dev_tools/
  bridges/claude_code.rs`) now wraps its `tokio::spawn { Command::output }`
  in `SpawnGuard::acquire` — a runaway caller firing `claude_code_run` in
  a loop gets budget-rejected before saturating the process table.
- **Recovery doc** — added to SECURITY.md: if the uid ever exhausts again,
  `sudo sysctl -w kern.maxprocperuid=4096 kern.maxproc=5000 && pkill -9 -f
  Sunny` restores forking without rebooting.

Verification: `cargo check --lib` exit 0; `cargo test --lib` for the
new modules: process_budget 3/3, boot_guard 4/4, daemons 8/8 (no
regression), dialogue 30/30 (no regression); `pnpm tsc -b --noEmit`
exit 0; `pnpm vitest run daemon.test.ts` 29/29.

## Loop iterations 1-17 — Post-sprint hardening

These iterations ran after the sprint-13/14 foundation and the R15/R16 phases.
Each iteration was a focused pass over the codebase, with no feature-freeze —
only correctness, completeness, and doc/test debt.

- **Iter 1** — `tool_trait.rs` introduced; `inventory::submit!` path established
  alongside the legacy `dispatch.rs` match arm. `spawn_subagent` still on the
  match path at this point.
- **Iter 2** — Canary token minted at startup (`security/canary.rs`);
  `http::send` pre-flight URL scan added; `SUNNY_CANARY_TOKEN` env export wired.
- **Iter 3** — Sentinel injection into system prompts (`agent_loop/core.rs`
  `compose_system_prompt`); canary detection added to clipboard ingress scanner.
- **Iter 4** — Outbound content scanner (`security/outbound.rs`); canary hit in
  outbound body hard-blocks before ConfirmGate and auto-engages panic mode.
- **Iter 5** — `spawn_subagent` migrated to `inventory::submit!`; removed from
  the legacy match arm. From this iteration the match arm is frozen.
- **Iter 6** — `catalog.rs` updated: `trust_class()` and `is_dangerous()` now
  delegate entirely to `tool_trait::find`; legacy parallel tables removed.
  `catalog_merged()` iterates `tool_trait::all()` only.
- **Iter 7** — `run_tool` match arm replaced with the trait-registry path +
  `Err("unknown tool: {name}")` fallback. No legacy match remains in
  `dispatch.rs`.
- **Iter 8** — `GrantsTab.tsx` added to `SecurityPage`; `capability_tail_denials`
  Tauri command wired; GRANTS tab (hotkey `0`) surfaces grant policy + denial log.
- **Iter 9** — `capability_denials.log` dedup logic added: per-triple
  `(initiator, tool, cap)` dedup prevents hot-loop log spam.
- **Iter 10** — Playwright harness bootstrapped; `e2e/README.md` created;
  `pnpm test:e2e` script added to `package.json`. GRANTS tab smoke test written
  (`e2e/grants-tab.spec.ts`).
- **Iter 11** — `src/bindings/README.md` created documenting the `ts-rs` export
  pipeline and the serde/ts-rs rename-drift rule (see R16-E).
- **Iter 12** — Retry policy added to `dispatch_tool`: up to 3 attempts with
  200 ms / 600 ms backoffs on transient network errors; dangerous tools skip
  retry to prevent duplicate side effects.
- **Iter 13** — Sub-agent role scoping moved before the constitution gate in
  `dispatch_tool` execution order; constitution check now runs after enforcement
  policy, not before.
- **Iter 14** — `dispatch.rs` `//!` doc block rewritten to reflect the true
  6-step execution order (panic → pre-dispatch audit → scoping + enforcement +
  constitution → ConfirmGate → trait-registry dispatch).
- **Iter 15** — `docs/TOOLS.md` legacy-match section replaced; `spawn_subagent`
  now documented as registry-resident. `docs/ARCHITECTURE.md` dispatch.rs
  description updated to remove "single match arm" language.
- **Iter 16** — `docs/SECURITY.md` canary system and GRANTS tab sections added.
  `docs/CAPABILITIES.md` `capability_tail_denials` command and GRANTS tab
  reference added.
- **Iter 17** — `README.md` Testing section added with `pnpm test` (Vitest) and
  `pnpm test:e2e` (Playwright, opt-in) commands. `CHANGELOG.md` this entry.


## Phase 2 — team-of-10 hardening sprint

Ten parallel agents ran concurrently against the codebase. Each agent owned a
distinct domain; changes were merged as individual PRs. Listed by agent area.

- **Orchestrator** — coordinated task allocation and merge ordering across the
  ten subagents; resolved conflicts at the `agent_loop/dispatch.rs` and
  `memory/db.rs` boundary. No feature code added by this role.
- **Voice / TTS engineer** — split `src-tauri/src/voice.rs` into a proper
  sub-module: `voice/mod.rs` (public API, daemon lifecycle), `voice/config.rs`
  (voice catalogue and `DEFAULT_VOICE` constant), and `voice/normalize.rs`
  (text normalisation helpers: `resolve_voice`, `wpm_to_speed`,
  `clean_for_kokoro`, `say_compatible_voice`). No behaviour change; compilation
  and test count unchanged.
- **Data engineer** — added `with_conn_in` to `memory/db.rs` — a test-injection
  helper that runs a closure against a caller-supplied scratch connection instead
  of the global singleton. Every existing call site keeps `with_conn`; no
  production code changes. Added `init_reader_pool` + `with_reader` so concurrent
  read workloads (memory-pack builder, FTS inspector, UI) share a pool of 4
  read-only WAL connections instead of serializing through the writer mutex.
  A stress test (`reader_pool_concurrent_reads`) exercises 8 simultaneous readers.
- **Security auditor** — rotated the capability-denial log at 4 MiB
  (`MAX_DENIAL_LOG_BYTES = 4 * 1024 * 1024`) instead of growing without bound.
  Old log is renamed to `capability_denials.log.old` (single generation retained);
  `tail_denials` guards against files that escaped rotation. Also added the
  `tail_denials_round_trips_written_rows` and `tail_denials_limit_is_respected`
  unit tests.
- **Frontend engineer** — split `src/components/ChatPanel/index.tsx` into four
  focused files: `session.ts` (pure types and session utilities), `styles.ts`
  (static `CSSProperties` objects), `useChatMessages.ts` (streaming receive and
  send logic), and `useSessionManager.ts` (session lifecycle — create, switch,
  restore). Added `src/components/ChatPanel/README.md` documenting the layout.
- **Agent-loop engineer** — schema version bumped to v8 in `memory/db.rs` to
  cover the reader-pool migration tables. Added `scratch_conn` test helper
  (re-exported as `pub(crate)` for cross-module unit tests).
- **Test engineer** — Rust `--lib` test count reached **1059 passing** after
  Phase 2 additions; Vitest suite reached **205+ tests**.
- **Doc writer** — updated `docs/ARCHITECTURE.md`, `docs/MEMORY.md`,
  `docs/SECURITY.md`, `README.md`, and new `ChatPanel/README.md` to reflect
  Phase 2 structural changes.
- **Reviewer** — cross-checked all merged PRs for immutability violations,
  console.log leaks, and hardcoded values. No blockers found.
- **Integration lead** — ran `cargo check --lib` and `pnpm tsc --noEmit` after
  each merge to keep the tree green throughout the sprint.

## Phase 4 — (in progress)

Next sprint is underway. This section will be filled in as PRs land.

- TODO: Data engineer — migrate `pack.rs`, `hybrid.rs`, and `expand.rs` read
  call sites from `with_conn` to `with_reader` (pool infrastructure is live;
  Phase 4 wires the call sites).
- TODO: Further hardening and new feature passes.

## Phase 3 — concurrent hardening (SHIPPED)

Ten parallel agents ran concurrently. Listed by agent area. Test counts after
this sprint: **1094 Rust lib tests** · **262 Vitest tests**.

- **Orchestrator** — coordinated task allocation across 10 agents; resolved
  merge conflicts at `security/canary.rs`, `ambient/mod.rs`, and
  `commands/memory/mod.rs` boundaries.
- **Security auditor** — shipped canary sentinel-label rotation: 4 templates
  (`SENTINEL_TEMPLATES`) chosen at install time from UUID byte 0 mod 4,
  persisted in `canary.txt` as `{template_idx}:{token}` so the same template
  survives restarts. All templates share "PRIVILEGED_CONTEXT" and "root API
  credential" so the detection layer (UUID token scan) is unaffected by
  rotation.
- **Voice / ambient engineer** — split `src-tauri/src/ambient.rs` into a
  proper sub-module: `ambient/mod.rs` (daemon, `start`, `process_world`,
  `spawn_classifier`, tests), `ambient/store.rs` (`AmbientDisk`, persistence),
  `ambient/settings.rs` (`AmbientSettings`, per-setting constants),
  `ambient/rules.rs` (`evaluate`, `gap_ok`, compound synthesis, `Surface`).
  Mirrors the voice/ sub-module pattern from Phase 2.
- **Frontend engineer** — added `JobEditForm` component to `AutoPage`
  (inline create / edit for scheduler jobs); added `SkipLink` accessibility
  component to the HUD chrome (keyboard skip-to-main-content).
- **AI integration engineer** — backfilled `timeout` guards on the 5
  composite tools that were missing them (`deep_research`, `claude_code_run`,
  and sibling composites); ensured every composite in
  `agent_loop/tools/composite/` has an explicit wall-clock ceiling.
  Added `GlmUsage` token-accounting struct to `glm.rs` so usage tokens
  (prompt + completion) are captured in telemetry alongside Anthropic/Ollama.
- **Backend architect** — split `src-tauri/src/commands.rs` memory section
  into `src-tauri/src/commands/memory/` sub-module with one file per domain
  (`episodic.rs`, `semantic.rs`, `procedural.rs`, `compact.rs`,
  `retention.rs`, `tool_usage.rs`, `conversation.rs`, `legacy.rs`).
  `mod.rs` `//!` block documents the layout table.
- **Security / fs engineer** — added `open_sunny_file` Tauri command in
  `commands/fs.rs`: accepts a bare filename (no `/`, `\`, or `..`),
  resolves to `~/.sunny/<filename>`, validates via `assert_read_allowed`,
  then calls `control::open_path`. Preferred over `open_path` for
  webview-initiated edits of SUNNY config files.
- **Test engineer** — Rust `--lib` count reached **1094 passing**; Vitest
  suite reached **262 tests**. New coverage: `ambient/` rule regressions
  (compound starvation, meeting + battery, relaunch duplicate-fire),
  `open_sunny_file` validation, `GlmUsage` deserialization.
- **Doc writer** — updated `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
  `docs/TOOLS.md`, `docs/MEMORY.md`, `README.md`, and `ambient/mod.rs //!`
  to reflect Phase 3 structural changes.
- **Integration lead** — ran `cargo check --lib` and `pnpm tsc --noEmit`
  after each merge; both exit clean throughout the sprint.

## R18-C — Tech Scout

Researched the open-source agentic AI landscape (AutoGPT, BabyAGI, OpenHands, crewAI,
AutoGen, LangGraph, Anthropic Agent SDK, Manus, Reflexion, Society-of-Thought debate).
Findings and top-5 adoption recommendations written to `docs/AGENTIC_AI_SCOUT.md`.
Key gaps identified: session checkpointing across context windows, per-step verbal
critique (Reflexion loop), and a plan-at-tail injection pattern to prevent goal-drift
on long runs. SUNNY rated ahead of all surveyed frameworks on local-first + voice + HUD
integration.

## R16-J — Self-test

One command that runs every test and eval SUNNY has and writes a single
machine- and human-readable readiness report. Use it before a release,
before a demo, or whenever you want to answer "is SUNNY green?" without
remembering the six individual entry points.

- **`scripts/self_test.sh`** — composite harness. Runs `cargo check
  --release`, `cargo test --lib --release`, `npx tsc -b --noEmit --force`,
  `/tmp/sunny_smoke.py` (19 live-ollama cases), `/tmp/sunny_bfcl.py`
  (50-case BFCL-style tool-calling eval), and
  `/tmp/sunny_latency_bench.py` (voice-pipeline latency envelope). Each
  section has its own timeout; sections skip cleanly if their upstream
  script is missing. Concurrent-run safe — every invocation gets its
  own `/tmp/sunny_selftest/run-<ts>-<pid>/` directory and the canonical
  `/tmp/sunny_selftest/report.json` is overwritten last. Exit codes: 0
  PASS / 1 DEGRADED (something skipped) / 2 FAIL.
  - `--fast`   skip BFCL + latency bench (runs in ~2 min instead of ~10)
  - `--only=cargo_check,tsc`   whitelist specific sections

- **`scripts/self_test.py`** — parses `report.json` and prints a
  ~300-word human readiness summary. Suitable for pasting into a commit
  message, status update, or Telegram ping.

Artifacts land under `/tmp/sunny_selftest/`:

- `report.json` — the aggregated machine output (timestamp, per-section
  counts, verdict).
- `<section>.json` — per-section detail for each of cargo_check,
  cargo_test, tsc, smoke, bfcl, latency.
- `logs/<section>.log` — raw stdout+stderr for post-mortem.


## R16-I — Reflexion tool + sub-agent role scoping

Added the `reflexion_answer` composite tool (generator → critic → refiner loop
modelled on Shinn et al. 2023) and hardened sub-agent role scoping in
`agent_loop/scope.rs`. `plan_execute` and `spawn_subagent` can now annotate a
sub-agent with a named role (`writer`, `researcher`, `planner`) whose tool
allowlist is enforced by the dispatcher's `subagent_role_scoping` enforcement
flag. The R16-F regression (`notes_create` incorrectly blocked for the `writer`
role) was fixed and covered by a new unit test. Rust test count: **see commits**.

## R16-H — Query expansion for hybrid memory search

Introduced `src-tauri/src/memory/expand.rs` and `hybrid::search_expanded`.
When the `memory_recall` tool is called with `expand: true`, the query is
paraphrased into 5 variants via the cheap model and each variant runs a
separate `hybrid::search`; hit IDs are deduplicated across variants and the
highest score wins. Fixes the motivating failure mode where BM25 misses
semantically equivalent phrasings ("what do I like to drink?" vs "morning
drink: espresso"). The 5-paraphrase count matches the R16-H spec. 3 new unit
tests in `memory::expand`.

## R16-G — Speculative drafting for voice TTFA

Added speculative first-sentence drafting in the Ollama streaming provider
(`agent_loop/providers/ollama.rs`). When a voice turn is detected, the provider
begins TTS synthesis on the first completed sentence before the full model
response arrives. This reduces time-to-first-audio (TTFA) on local Ollama runs
by roughly one sentence-generation latency. The gate (`R16-G + R18-I`) is
visible in `core.rs`; `R18-I` later extended it to the Anthropic path. The
speculative draft is discarded if the model's next token contradicts it.

## R16-F — Sub-agent writer role + notes regression fix

Defined the `writer` role allowlist in `scope.rs` (`notes_create`,
`notes_append`, `mail_send`, `imessage_send`, `scheduler_add`,
`memory_remember`). Fixed a regression where the earlier scope implementation
incorrectly blocked `notes_create` for writer-scoped sub-agents. The fix was
covered by the `plan_execute_can_use_writer_tools` test added to `scope.rs`.

## R16-E — ts-rs bindings audit and bulk migration

Audited every `#[ts(export)]` struct for serde/ts-rs field-name drift. The
canonical bug: a field marked `#[serde(rename = "exit_code")]` without a
matching `#[ts(rename = "exit_code")]` generated a TypeScript binding with
field name `code` while the wire payload carried `exit_code`, producing silent
`undefined` reads on the frontend. A bulk migration pass added `#[ts(rename)]`
attrs to match all existing `#[serde(rename)]` uses. `docs/BINDINGS.md` was
updated with the rule and the motivating example. See commits.

## R16-D — Security enforcement policy (kill-switch list + force-confirm-all)

Added `security::enforcement` policy with two new controls: a per-tool
kill-switch list that blocks specific tools globally (without full panic mode)
and a `force_confirm_all` flag that gates every tool call through ConfirmGate
regardless of its `dangerous` flag. The R14-D regression (security event
debounce loop emitting one-per-cycle instead of one-per-burst) was identified
and fixed in `security/policy.rs`; the fix is covered by the
`debounce_coalesces_burst` test. Dispatcher now calls `security::enforcement::tool_verdict`
before ConfirmGate.

## R16-C — Tech Scout (see also R18-C)

See commits. (This release tag appears in code references but its exact scope
overlaps with R18-C which contains the written-up findings.)

## R16-B — Capability grant system (`~/.sunny/grants.json`)

Implemented `src-tauri/src/capability.rs` — the per-initiator grant policy that
controls which tools the scheduler, daemons, and sub-agents can call. The
`GrantsFile` schema (`initiators` map + `default_for_sub_agents` fallback) is
persisted at `~/.sunny/grants.json`, cached in-process with an mtime check so
edits take effect without a restart. `agent:main` is always unscoped. Every
denial is appended to `~/.sunny/capability_denials.log`. The Tauri commands
(`capability_grants_get` / `_update`) were wired; a Settings UI is marked as
a follow-up (see `commands.rs` comment "sprint-14 follow-up"). See commits.

## R16-A — Composite tool foundation (`agent_loop/tools/`)

Established `src-tauri/src/agent_loop/tools/` as the home for the new
`ToolSpec` + `inventory::submit!` registration surface (see `tool_trait.rs`).
Sprint-14 territory: the composite mod (`tools/composite/mod.rs`) scaffolded
the structure for multi-step tools. The legacy `dispatch.rs` match arm is
preserved; `tool_trait::find` consults the inventory before falling through,
allowing tool-by-tool migration. See commits.

## R15 — Vision tools, hybrid memory embedding, and critic/refiner

Three areas shipped across the R15 sub-sprints:

**R15-G — Vision tools.** `tools_vision.rs` added `screen_describe`,
`image_describe`, and `vision_ask` using the preferred on-device vision model
(smoke-tested per the R15-G brief). Tools are flagged `dangerous: false` since
they read but do not write.

**R15-D — Critic/refiner single-hop.** A one-shot critic review baked into the
main ReAct turn: after a model proposes a dangerous tool, a cheap-model critic
scores the rationale (0–1) and can return `block` before ConfirmGate runs.
Distinct from the later R16-I multi-hop Reflexion loop which is a user-callable
composite tool. The critic hop lives in `agent_loop/critic.rs`.

**R15-C — Embedding-based hybrid memory retrieval.** `memory/hybrid.rs` added
BM25 + cosine blend with alpha-weighted reciprocal-rank normalisation. The
embedding cosine leg softens BM25's lexical brittleness; R16-H later added
query expansion on top. `memory/embed.rs` gained the `start_backfill_loop`
(fills NULL `embedding` BLOBs 8 rows per store per 30 s tick). See commits.

**R15-B — Tool input schema validation.** `dispatch.rs` gained `JSONSchema`
validation on tool inputs using `jsonschema::JSONSchema`. Empty schemas are
skipped per the R15-B brief to avoid blocking tools with no `input_schema`.

## R14 — Security hardening, tray, and agent plumbing

Four areas shipped across the R14 sub-sprints:

**R14-D — Security event debounce.** `security/policy.rs` introduced the
burst-coalescing debounce window for `SecurityEvent` emissions. A regression
(one-per-cycle instead of one-per-burst) was discovered and fixed; the
`debounce_coalesces_burst` test guards against re-regression.

**R14-G — Tray and global shortcut groundwork.** `tray.rs` gained the tray
icon lifecycle and `sunny://nav` emit on menu item activation. A TODO in the
file (R14-G follow-up) marks where `tauri-plugin-global-shortcut` would be
wired once the plugin stabilises.

**R14 — Composite tool scaffolding.** `agent_loop/tools/composite/mod.rs`
scaffolded the `agent_loop/tools/` structure in preparation for the
`ToolSpec` + `inventory::submit!` migration that landed in R16-A. See commits.

**R14 — Cross-cutting cleanup.** See commits for the full set of fixes that
accompanied the R13 plumbing work and were tagged R14 after stabilisation.

## R13 — AI plumbing + cross-cutting cleanup

Wired the daemons runtime end-to-end (persistent AI agents that fire on a schedule
and report back through the sub-agent card), added the SCAN module (SHA-256 hashing,
MalwareBazaar/VirusTotal lookup, quarantine vault), consolidated 16 sidebar modules
down to 11, rebuilt APPS and FILES into full managers, shipped three browser passes
(hardened multi-profile, Tor fingerprint resistance, production polish with DoH +
right-click + session restore), fixed the Quick Launcher with recursive search and
Finder reveal, wired the Calendar page to macOS Calendar.app, and added the MEMORY
radial graph tab. Rust test count reached **210 passing**.


### Quick Launcher — recursive file search + Finder reveal

The `⌘K` launcher only ever listed the top level of `$HOME` (`fs_list ~`),
so anything nested under `Documents/`, `Projects/`, etc. was unreachable
from the launcher and the user had to open the FILES module first.

- **Recursive file search** (`src/components/QuickLauncher.tsx`). When
  the query is ≥2 characters, a debounced (220 ms) `fs_search` walk
  fires against `~` and its hits merge into the existing shallow
  `fs_list` results (dedup by path, deep-hit wins on collision).
  Bounded at 40 results / 20 000 entries visited so it never stalls.
  Max visible file hits bumped from 3 → 6 now that the pool is
  meaningfully bigger.

- **⌘↵ reveals in Finder**. Pressing `⌘Enter` (or `⌘`-clicking) on
  a FILE hit now calls `fs_reveal` instead of `open_path`, and on
  an APP hit calls `finder_reveal` on the `.app` bundle instead of
  launching. Plain `↵` still opens / launches. Footer hint row
  picked up a `⌘↵ reveal` tile so it's discoverable.

### MEMORY module — GRAPH tab is no longer a missing import

`MemoryPage/index.tsx` imported `./GraphTab` but the file didn't exist,
which meant the whole module failed to build (the `GRAPH` tab chip has
been in `constants.ts` for a while). That's fixed and the tab now
ships with a real visualization:

- **Radial knowledge graph** (`src/pages/MemoryPage/GraphTab.tsx`).
  Fetches the full `memory_fact_list` (no new Rust commands), groups
  by `subject`, and lays the result out in pure SVG:
  - Subject clusters sit on an outer ring, each coloured by a
    deterministic hash of the name. Subject node radius scales with
    `sqrt(fact_count)` so one huge cluster doesn't starve the rest.
  - Every fact is a satellite orbiting its subject. Satellites pack
    onto concentric rings of 8 slots each so dense subjects stay
    legible instead of piling on top of each other.
  - Hovering a fact highlights its edge, fattens its node, and
    surfaces a tooltip with subject · confidence · relative-time ·
    source. Clicking a subject filters the right-hand fact rail to
    just that cluster; click again to clear.
  - Subject chips rail (below the heading) doubles as an
    alt-selector for the top 12 clusters; every chip shows `×N`
    fact count so you can see the corpus shape at a glance.

  No new Tauri commands; everything plugs into the existing
  `memory_fact_list` the SEMANTIC tab already uses.

### CALENDAR module — now backed by real macOS Calendar.app

The CALENDAR page used to be a localStorage-only event planner. It is now
a live view on top of `Calendar.app` via the existing
`calendar_list_events` / `calendar_list_calendars` / `calendar_create_event` /
`calendar_delete_event` Tauri commands, with the previous localStorage
store kept around as a `LOCAL` draft source.

- **Unified event model** (`src/pages/CalendarPage.tsx`). Every event now
  carries a `source` field — either `"LOCAL"` (a localStorage draft that
  never left the machine) or the name of a macOS calendar (`"Home"`,
  `"Work"`, …). Both sources flow through the same list / month / week /
  agenda renderers; badges and colors make the origin obvious.

- **Live macOS events**. Whenever the month anchor changes, the page
  over-fetches a 7-week window around it via `calendar_list_events` and
  re-decorates every result with a `tone` (`now` / `amber` / `normal`)
  derived from the event's actual start time against `Date.now()`. A
  1-minute timer keeps the tone fresh without requiring a reload.

- **Calendar picker + per-calendar visibility**. The sidebar grew a
  `CALENDARS` list showing every calendar `Calendar.app` reports,
  coloured by a deterministic hash of the name so the same calendar
  always gets the same swatch across month / week / agenda / day-pill.
  Click to toggle; hidden-state persists to `sunny.cal.hidden.v1`.
  A `↻` button next to the label re-runs the query on demand.

- **Permission banner**. When `calendar_list_events` returns `null`
  (Calendar access denied), an amber banner pins above the month grid
  with the exact Settings path (`System Settings → Privacy & Security
  → Calendars → add Sunny`) and a RETRY button.

- **Create form targets a calendar**. A new TARGET row in the form
  lets you pick between `LOCAL` (still the default when Calendar
  access is missing) and any writable macOS calendar. Picking a
  macOS target additionally surfaces a `DUR (min)` field (default 60),
  swaps the `SUB` input for `LOCATION`, and calls
  `calendar_create_event` instead of touching localStorage. On
  success the remote list is re-fetched so the new event shows up
  immediately.

- **Delete button on every event**. Each event row in the day detail
  and agenda renderers has an `×` that resolves to
  `calendar_delete_event` for macOS events or a localStorage splice
  for LOCAL drafts. Confirm dialog first; toast on completion.

- **WEEK view enabled**. The "SOON" lockout on the `WEEK` sidebar
  button is gone; it now renders 7 day columns with event pills
  coloured by source, plus `← PREV / NEXT →` inline navigation.
  Day cells are click-to-select so switching to MONTH / AGENDA
  keeps the current day in focus.

- **Toasts + header badge**. Every mutation surfaces a toast
  (`SAVED · LOCAL DRAFT`, `DELETED · WORK`, `CREATE FAILED`…); the
  badge shows `SYNC…` while the remote fetch is in flight.

### APPS module — launcher → full app manager

Second pass on the APPS page. Tiles used to be read-only icons that launched
on click; now each one is a live handle on the app, with running-state,
launch counters, and the `⌘H`/`⌘Q` verbs you'd expect from a real launcher.

- **New Tauri command** (`src-tauri/src/control.rs`, wrapped in
  `commands.rs`, wired in `lib.rs`):

  | Command | Purpose |
  |---|---|
  | `app_hide` | Hide an app's windows without quitting it (`⌘H` equivalent). AppleScript via `System Events → set visible of process → false`. Name is validated (no quotes/backslashes/newlines, ≤80 chars) so the script stays un-injectable. |

  The pre-existing `app_quit` and `finder_reveal` commands from
  `tools_macos.rs` — which previously only existed as agent tools — are
  now also registered in the `invoke_handler!` so the UI can call them
  directly.

- **Running-app tracking** (`src/pages/AppsPage.tsx`). A 10-second poll
  against `window_list` extracts the set of app names that currently
  have at least one window, driving:
  - A green pulse indicator + left-border accent on every running tile
  - A new `RUNNING` chip filter with a live count + pulse dot
  - HIDE / QUIT actions appearing only when the app is actually running
  - `N RUN` in the header badge

- **Launch counts**. Every launch bumps an `sunny.apps.launches.v1`
  localStorage counter shown as `×N` in the tile corner. Drives the
  new `TOP` sort and makes frequent apps easy to re-find after a
  long session.

- **Sort / view toggles** (right-aligned toolbar):

  | Sort | Behaviour |
  |---|---|
  | `A–Z` | Alphabetical (default). |
  | `RECENT` | Most-recently-launched first, falling back to A–Z for ties. |
  | `TOP` | Most-launched first, based on the new counter. |

  | View | Behaviour |
  |---|---|
  | `GRID` | Existing 130 px tile grid (kept). |
  | `LIST` | Dense rows: icon · category · name · path · running state · launch count · inline actions. |

  Both persist to localStorage (`sunny.apps.view.v1`, `sunny.apps.sort.v1`).

- **Hover action strip** replaces the old single "LAUNCH" chip. Every
  tile in grid mode now exposes `LAUNCH · REVEAL · COPY`, plus
  `HIDE · QUIT` (red) when the app is running. List rows have the
  same actions always visible.

- **Search matches path too** — searching `"/Utilities"` narrows to
  Utilities apps; name, initials, and path all participate in the
  substring match.

- **Chip counts**. Every filter chip shows its matching count
  (`ALL 147 · FAVORITES 5 · RUNNING 8 · DEV 12 · DESIGN 4…`) so the
  category layout is legible at a glance.

- **Keyboard shortcuts**:

  | Key | Action |
  |---|---|
  | `/` | Focus search (kept) |
  | `↑ ↓ ← →` | Move focus through tiles/rows |
  | `Enter` | Launch focused app |
  | `F` | Toggle favorite on focused |
  | `R` | Reveal focused in Finder |
  | `H` | Hide focused (if running) |
  | `Q` | Quit focused (if running, with confirm) |
  | `⌘G` / `⌘L` | Switch to grid / list |
  | `Esc` | Clear search, then clear focus |

- **Polish**: toast notifications on every mutation; bottom-footer
  keyboard cheat-sheet so discoverability doesn't require reading
  source; the `RECENTLY LAUNCHED` and `FAVORITES` sections only render
  in the default A–Z sort so `TOP` / `RECENT` don't duplicate content.

### FILES module — full file manager

The `FILES` page went from a read-only directory listing to a real file
manager. The only Tauri command it used to talk to was `fs_list`; it now
drives a nine-command surface (all new, all enforced by `safety_paths.rs`).

- **New Tauri commands** (`src-tauri/src/control.rs`, wrapped in
  `commands.rs`, wired in `lib.rs`):

  | Command | Purpose |
  |---|---|
  | `fs_read_text` | Text preview, caps at 256 KiB. Binary-detects via NUL-byte probe in the first 4 KiB so junk never renders. |
  | `fs_mkdir` | Recursive directory create. |
  | `fs_new_file` | Create a file (refuses to clobber existing) with optional body. |
  | `fs_rename` | Rename / move a file or directory. |
  | `fs_copy` | Copy a file or whole tree; cross-filesystem safe. |
  | `fs_trash` | Move to macOS Trash via Finder AppleScript — undoable, unlike `rm`. |
  | `fs_dir_size` | Recursive size with a 50k-entry hard cap so the UI can't stall on a huge tree. |
  | `fs_search` | Recursive name search, skips dotfile descent, capped at 500 results / 50 k visited. |
  | `fs_reveal` | `open -R` to highlight an item in Finder. |

  All go through the same read/write/delete allow-lists the existing
  file tools use. These are **UI-only** Tauri commands — they are *not*
  registered with the agent tool registry, which keeps using the
  `file_*` pack for agent-driven mutations.

- **FilesPage rewrite** (`src/pages/FilesPage.tsx`): grew from ~500 LoC
  to ~1100 LoC covering:
  - **Sidebar**: QUICK PATHS (kept) + new PINNED (persisted in
    localStorage) + auto-tracked RECENTS + NAV actions (UP, RELOAD,
    PIN/UNPIN CURRENT, NEW FILE, NEW DIR, LIST/GRID toggle,
    SHOW/HIDE dotfiles).
  - **Search**: instant substring filter; `⌘↵` or DEEP SEARCH button
    kicks off the recursive `fs_search` walk.
  - **Filters**: kind chips (ALL / DIR / CODE / DOC / IMG / DATA /
    OTHER) on top of configurable hidden-file visibility. Buckets
    widened beyond the old ts/md/png defaults — 21 code extensions,
    10 image formats, archives get their own red accent.
  - **Sort**: click column headers (KIND / NAME / SIZE / MODIFIED)
    with arrow indicators; re-click to flip direction. Directories
    always pin to the top regardless of sort.
  - **Views**: list mode (kept) + grid mode with thumbnails rendered
    via `convertFileSrc` for image files, kind badges for everything
    else.
  - **Multi-select**: `⌘`-click toggles, `Shift`-click range-selects,
    arrow keys move focus, `Shift+Arrow` extends range, `⌘A` select
    all, `Esc` clears. A selection toolbar surfaces bulk COPY PATHS /
    REVEAL / TRASH / CLEAR alongside the aggregate size.
  - **Per-row hover actions**: OPEN · REVEAL · COPY · RENAME · DUPE ·
    TRASH (red). Rename edits in-place; duplicate auto-numbers to
    avoid collisions (`foo.txt` → `foo (2).txt`).
  - **Preview pane**: appears when exactly one item is selected.
    Images render inline; text files preview up to 128 KB with
    binary detection; directories show computed total size / file
    count / subdir count from `fs_dir_size`.
  - **Create**: inline NEW FILE / NEW DIR flow with collision toasts;
    auto-unique naming for duplicates.
  - **Keyboard**: `/` or `⌘F` focus search · `⌘R` reload · `⌘N` new
    file · `⌘⇧N` new folder · `Enter` open · `Backspace` up
    directory · `Delete/Backspace` on selection = trash (with
    confirm).
  - **Footer status bar**: shown / total counts, selection byte
    total, current path. Toast notifications for every mutation
    (ok/err).

No agent-visible surface change — the `fs_list` tool the agent uses is
unchanged. This is a UI-only pass on top of the existing safety
substrate.

### Browser: production polish

Third pass on the browser. The security claims the first two passes made
are now backed by real code — in particular DoH resolution that actually
talks to Cloudflare/Quad9/Google over HTTPS instead of just declaring
intent. Plus the expected-browser UX nobody thinks about until it's
missing: in-page find, zoom, reopen-last-closed, session restore, right-
click menus.

- **DoH actually implemented** (`src-tauri/src/browser/doh.rs`,
  `transport.rs`) The clearnet path with `doh: Some(...)` now plugs a
  `reqwest::dns::Resolve` implementation that POSTs the DNS wire-format
  query (RFC 8484) to the chosen provider over HTTPS. Provider IPs are
  bootstrap-pinned (1.1.1.1 / 9.9.9.9 / 8.8.8.8) so we never recurse
  through the OS resolver. Per-profile LRU cache keyed by `(profile,
  host, want_v6)` with TTL honoring the answer's TTL, floored at 60 s,
  ceilinged at 30 min. Asks for both A and AAAA so happy-eyeballs
  works. 3 new unit tests cover the wire-format encoder.

- **HTTPS upgrade before block** (`dispatcher.rs::should_try_upgrade`)
  When a profile has `https_only=true` and the caller asks for
  `http://example.com`, the dispatcher now tries `https://example.com`
  first and only reports `blocked_by=https_only` if that path is also
  unavailable. Literal IPs and `.local` / `localhost` hosts skip the
  upgrade (HTTPS on LAN devices usually 404s). Tests cover the
  condition.

- **Referer + Origin header scrub** (`dispatcher.rs::fetch`)
  Tor / private / any custom-proxy profile now scrub `Referer` to
  empty and rewrite `Origin` to `null` before the request leaves.
  `DNT: 1` and `Sec-GPC: 1` are added so downstream sites see the same
  privacy signal Tor Browser emits. The default (clearnet) profile
  keeps its Referer so rate-limited sites still work. Caller-supplied
  `Host`, `User-Agent`, `Cookie`, `Proxy-Authorization`, and
  `Proxy-Connection` headers are always dropped — they'd defeat the
  profile's posture.

- **Constitution gate threaded through the browser**
  (`dispatcher.rs::blocked_by`) Every fetch now runs the same
  `constitution::check_tool("browser_fetch", {url, profile_id})` call
  the agent loop uses for tool gating. Users can ban a domain
  declaratively in `~/.sunny/constitution.json` and both human clicks
  and agent reads respect it. Blocked requests audit with
  `blocked_by = "constitution:<reason>"`.

- **Homograph / punycode detection** (`dispatcher.rs::looks_deceptive`,
  `commands.rs::browser_url_is_deceptive`) Any URL whose host contains
  `xn--` labels or raw non-ASCII characters gets a confirm dialog on
  navigate, showing the ASCII form so the user sees "xn--pple-43d.com"
  rather than the rendered lookalike. If they confirm, a yellow banner
  pins over the tab's content for the session as a reminder.

- **Download quarantine xattr**
  (`downloads.rs::apply_quarantine_xattr`) Finished downloads get
  `com.apple.quarantine` with flag `0081`
  (kLSQuarantineTypeWebDownload) so macOS Gatekeeper prompts on first
  open, exactly like a Safari-downloaded file. We also set
  `com.apple.metadata:kMDItemWhereFroms` with a hand-rolled binary
  plist so Finder's Get Info shows "Where from: <url>". APFS volumes
  that don't support xattrs fail silently — the download still lands.

- **Cmd+F in-page find**
  (`src/pages/WebPage/index.tsx::FindBar`, `ReaderContent.tsx`) The
  reader now supports the universal browser chord. Highlights every
  case-insensitive match with a yellow `<mark>` tag; Escape dismisses.
  The highlighter operates on the React tree not the sanitized HTML,
  so it composes safely with the existing allow-list renderer.

- **Zoom controls** (`tabStore.ts::{bumpZoom, setZoom}`, `index.tsx`)
  Cmd++ / Cmd+- / Cmd+0, persisted per profile in localStorage. A
  small badge in the top-right shows the current zoom when it's not
  100 %. Clamped 50 %–250 %.

- **Reopen last closed tab** (`tabStore.ts::reopenLastClosed`)
  Cmd+Shift+T pops from a 20-entry LIFO stack of recently-closed tabs.
  Private and Tor tabs are explicitly not eligible — reopening them
  would defeat the ephemeral promise.

- **Session persistence for the default profile**
  (`tabStore.ts::persistSession`) Default-profile tabs round-trip
  through `localStorage` under `sunny.web.session.v1` so the browser
  survives app restart. Debounced via `queueMicrotask` so rapid
  navigations don't thrash storage. Private + Tor stay ephemeral.

- **Right-click menu in reader**
  (`ReaderContent.tsx::ContextMenu`) Open here / Open in new tab /
  Copy link / Open in Safari. Click outside to dismiss. The component
  stays decoupled from the tab store via a small
  `sunny:web:open-new-tab` custom event; `WebPage` listens for it.

- **Tests** 9 new unit tests across `dispatcher` (`upgrade_to_https`,
  `should_try_upgrade`, `looks_deceptive` for punycode + non-ASCII,
  header-scrub eligibility, forbidden-header coverage,
  onion-over-http carve-out) and `doh` (query shape for A, query
  shape for AAAA, oversized-label rejection). Browser module total:
  **65 tests passing**.

- **Documentation** BROWSER.md §4, §6, §10 updated with the new flags
  and behaviors. TROUBLESHOOTING gets entries for DoH provider
  selection, constitution gates, and the homograph confirm dialog.
  README's profile table gets the `HTTPS-Only` and `Security` columns.

### Browser: closing the Tor Browser gap

Second pass on the hardened browser, closing most of the fingerprint-
resistance gaps we listed in the first release notes. The `tor` profile
at `Safest` level now matches Tor Browser on the vast majority of
fingerprint vectors (letterboxing, canvas, audio, fonts, hardware,
timing, eval). Full comparison table in `docs/BROWSER.md` §13.

- **Security-level slider — `Standard` / `Safer` / `Safest`**
  (`src-tauri/src/browser/profile.rs`,
  `src/pages/WebPage/PostureBar.tsx`) Modelled on Tor Browser's
  three-way slider. `Safer` disables WebAssembly, SharedArrayBuffer,
  OffscreenCanvas and rounds `performance.now()` to 1 ms. `Safest`
  rounds to 100 ms and blocks dynamic code evaluation. The three
  buttons `STD` / `SAFER` / `SAFEST` sit on the posture bar for the
  active tab; clicking one upserts the profile policy and the next
  sandbox tab picks it up. Built-in defaults: `default` = Standard,
  `private` = Safer, `tor` = Safer. Users can bump to Safest on a
  per-profile basis.

- **HTTPS-Only enforcement per profile**
  (`src-tauri/src/browser/dispatcher.rs::blocked_by`)
  New `policy.https_only` flag rejects every `http://` request with
  `blocked_by = "https_only"` before opening a socket. One carve-out:
  `http://<name>.onion/` is accepted because Tor circuits already
  provide end-to-end encryption — matches Tor Browser's behavior.
  Built-ins: `private` and `custom` now ship `https_only=true` by
  default; `default` stays off (reader links to `http://` sites still
  load); `tor` stays off so `.onion` works.

- **Letterboxing** (`sandbox.rs::init_script`)
  `window.innerWidth` / `innerHeight` floored to the nearest 100 px
  bucket on `tor` and `private` profiles — defeats the exact-viewport
  fingerprint that's the strongest single identifier on modern web.
  Tor Browser's defense, ported.

- **Canvas noise v2** (`sandbox.rs::init_script` → `CANVAS_NOISE`)
  Replaced the weak one-byte XOR with per-readback seeded noise. Both
  `HTMLCanvasElement.prototype.toDataURL` and
  `CanvasRenderingContext2D.prototype.getImageData` perturbed. Same
  session seed (xmur3 + mulberry32) across readbacks inside one page
  so the page sees a stable fingerprint — instability would itself be
  a fingerprint — but different seed per session and per tab.

- **Audio fingerprint resistance**
  (`sandbox.rs::init_script` → `AUDIO_FINGERPRINT`)
  `AudioBuffer.prototype.getChannelData` and
  `AnalyserNode.prototype.getFloatFrequencyData` perturbed with
  sub-audible drift. Defeats the classical OfflineAudioContext-hash
  fingerprint and every tool that builds on it.

- **Font allow-list**
  (`sandbox.rs::init_script` → `FONTS_ALLOWLIST`)
  `document.fonts.check()` returns `false` for anything outside a
  pinned allow-list of 15 universally-shipped font families (system
  generics + the core macOS/Windows set). Kills the "is Comic Sans
  installed?" probe.

- **Hardware fingerprint pin**
  (`sandbox.rs::init_script` → `HARDWARE_SPOOF`)
  `navigator.hardwareConcurrency` = 8, `deviceMemory` = 8,
  `maxTouchPoints` = 0, `platform` = MacIntel, `vendor` = Apple
  Computer Inc., `webdriver` = false, `doNotTrack` = "1".
  `oscpu` / `cpuClass` removed.

- **Timing attack resistance**
  (`sandbox.rs::init_script::timing_round_script`)
  `performance.now()` floored to the security-level bucket (1 ms at
  Safer, 100 ms at Safest). `performance.timeOrigin` rounded to
  match.

- **Bundled arti real wiring behind `--features bundled-tor`**
  (`src-tauri/Cargo.toml`, `src-tauri/src/browser/tor.rs`)
  The stub is gone. The feature now pulls `arti-client = 0.23` +
  `tor-rtcompat = 0.23`, calls `TorClient::create_bootstrapped`, and
  runs a local SOCKS5 listener on `127.0.0.1:<ephemeral>` that
  dispatches through the Tor client. `browser_tor_new_circuit` calls
  `retire_all_circs()`. State directory is `~/.sunny/browser/tor/`.
  Compile-verified on the feature-gated path; runtime-verifiable once
  a network with Tor-guard reachability is available. The default
  build still ships without arti, ~200 transitive crates lighter.

- **Posture beacon is tamper-resistant**
  `window.__sunnyx` is now defined with
  `configurable: false, writable: false` and a frozen payload — the
  page can't overwrite it to lie about posture. The frontend can
  trust the read.

- **Seven new agent tools on top of `secure_web_fetch` + `deep_research`
  + `browser_profiles`** (`src/lib/tools.sunnyBrowser.ts`)
  `browser_download`, `browser_download_status`, `browser_sandbox`,
  `browser_sandbox_close`, `browser_bookmark`, `browser_audit`,
  `browser_tor_status`. The agent can now queue video downloads,
  spawn hardened WebView tabs, save bookmarks under a profile, read
  the audit log, and probe Tor availability — all through the same
  dispatcher envelope a human uses. Mutator tools are flagged
  `dangerous: true` so ConfirmGate runs.

- **Tests**
  17 new unit tests added, bringing the browser module total to
  **56 passing**. Coverage: security-level init-script branches,
  letterboxing gating, HTTPS-Only with onion carve-out,
  per-profile defaults for `https_only` and `security_level`,
  posture beacon content, canvas noise signature.

### Hardened multi-profile browser — `browser/` + `src/pages/WebPage/`

The Web module outgrew its single-tab reader. This phase turned it into
a real browser: multiple profiles with distinct network postures, tabs,
per-tab ephemeral WebView sandboxes, a universal video downloader, deep
research, and a single network dispatcher every call walks through so
policy is not a promise but an invariant.

- **Single network dispatcher**
  (`src-tauri/src/browser/{profile,transport,dispatcher,audit,storage}.rs`)
  Every browser-originated request funnels through
  `BrowserDispatcher::fetch(&profile_id, &url, opts)`. The dispatcher
  owns a per-profile `reqwest::Client` cache, consults a tracker
  blocklist (18 well-known hosts by default, user-swappable via
  `set_blocklist`), enforces the kill switch before any socket opens,
  and appends to the audit log at `~/.sunny/browser/audit.sqlite`. The
  grep check `scripts/check-net-dispatch.sh` rejects new
  `reqwest::Client::builder` / `Proxy::all` outside
  `src-tauri/src/browser/transport.rs`; legacy call sites are
  grandfathered on an allow-list so the migration is phased.

- **Profiles: default · private · tor · custom**
  (`src-tauri/src/browser/profile.rs`)
  A `ProfilePolicy` is a declarative record — route, cookies, JS mode,
  UA mode, block-third-party-cookies, block-trackers, block-webrtc,
  deny-sensors, audit, kill-switch-bypass. Defaults are least-privilege
  and tighten as you move from `default` → `private` → `tor`. The
  `tor` profile has `audit=false` by contract so we don't record what
  the user visited even inside our own log. The `custom` profile
  accepts user `socks5://`, `socks5h://`, `http://`, `https://` URLs
  validated before reaching the reqwest builder; credentials are
  redacted before any audit touch.

- **Anonymity transports**
  (`src-tauri/src/browser/transport.rs`, `tor.rs`)
  Clearnet path honors DoH (Cloudflare / Quad9 / Google) so the local
  resolver never sees the hostname. `SystemTor { host, port }` uses
  `socks5h://` to force remote name resolution inside the tunnel —
  DNS cannot leak. The `BundledTor` variant is feature-gated behind
  `--features bundled-tor`; the stub in `tor.rs::bootstrap()` returns
  a clear "not yet implemented" rather than silently routing through
  clearnet. A periodic 15 s poll in the React store reflects the live
  status of the system Tor daemon. UA strings rotate from a small
  pool for private/custom or pin to the uniform Tor Browser string
  for tor.

- **Hardened WebView sandbox tabs**
  (`src-tauri/src/browser/{sandbox,bridge}.rs`)
  Sandbox tabs spawn a Tauri 2 `WebviewWindow` with `data_directory`
  set to an ephemeral per-tab path under
  `~/Library/Application Support/sunny/wv/<profile>/<tab-uuid>`. The
  window's `proxy_url` points at a tokio loopback HTTP listener
  (`bridge.rs`) owned by that tab; plaintext requests re-enter the
  dispatcher, HTTPS CONNECTs splice bytes through without MITM. An
  initialization script injected pre-page pins WebGL vendor to Apple
  M2, adds canvas-readback noise, forces UTC on Tor, locks languages,
  rounds screen dims for private/tor, deletes RTCPeerConnection when
  `block_webrtc` is set, and stubs geolocation/camera/mic/USB/
  Bluetooth/HID/serial/permissions when `deny_sensors` is true.
  Bridges own a `oneshot` shutdown so tab close tears the listener
  down immediately; the `WindowEvent::Destroyed` handler wipes the
  data dir and emits `browser:sandbox:closed` so the React store
  catches up.

- **Reader mode rebuilt on DOMParser**
  (`src/pages/WebPage/ReaderContent.tsx`, `src-tauri/src/browser/reader.rs`)
  The original reader routed sanitized Rust output through a React
  "span-only" parser which treated every `<a>` / `<p>` / `<h1>` as
  literal text — the google.ca screenshot bug. Replaced with a proper
  DOMParser-based walker that parses the already-sanitized HTML and
  maps allow-listed tags to React elements. Still zero `innerHTML`,
  still zero JS exec; now readable. Reader's Rust extractor also
  pulls `<link rel="icon">` and `<meta name="description">` for
  richer tab chrome.

- **Multi-tab UX with posture visible**
  (`src/pages/WebPage/{index,TabStrip,PostureBar,ProfileRail}.tsx`)
  Tabs per profile with route badges (`CLEAR`/`PRIVATE`/`TOR`/`PROXY`).
  The profile rail lists every profile with its tab count, a custom-
  profile creator, and a live system-Tor status chip. The posture bar
  under the tab strip shows the one-line summary
  (`TOR · JS OFF · EPHEMERAL · TRACKERS BLOCKED · WEBRTC OFF`) and
  an `AUDIT` button. Cmd+T/Cmd+W open/close tabs, Cmd+L focuses the
  address bar, Cmd+[/] navigate history, Cmd+R reloads.

- **Universal video download + reveal + analyze**
  (`src-tauri/src/browser/downloads.rs`,
  `src/pages/WebPage/DownloadsPanel.tsx`)
  `yt-dlp` + `ffmpeg` probed on PATH with Homebrew fallback; the UI
  surfaces what's missing. Jobs carry the tab's profile so downloads
  route through the same transport (`--proxy` flag + env vars). Tokio
  worker streams progress via `browser:download:update` events. Rows
  expose `REVEAL` (opens Finder with the file selected via `open -R`)
  and `ANALYZE` (opens the media workbench).

- **AI video workbench — extract · transcript · ask**
  (`src-tauri/src/browser/media.rs`,
  `src/pages/WebPage/MediaWorkbench.tsx`)
  `browser_media_extract` runs ffprobe + ffmpeg to produce
  `audio.mp3` (16 kHz mono, Whisper-ready) and ~120 keyframes per
  video into `~/.sunny/browser/media/<job_id>/`. The React modal wires
  summary / transcript / ask tabs ready for the configured provider's
  transcription + vision calls.

- **Deep research with citations**
  (`src-tauri/src/browser/research.rs`,
  `src/pages/WebPage/ResearchPanel.tsx`)
  `browser_research_run(profile_id, query, max_sources)` does one
  DuckDuckGo search through the active profile, fans out N parallel
  readable fetches through the dispatcher, dedupes by canonical URL
  (UTM + trailing-slash stripped), and returns a `ResearchBrief`
  with source titles, snippets, trimmed readable text, per-source
  timing and success flag. The UI renders each source as an open-
  in-new-tab click.

- **Audit log viewer**
  (`src-tauri/src/browser/audit.rs`,
  `src/pages/WebPage/AuditViewer.tsx`)
  Filterable modal shows the last N audit rows with host/method/tab
  filter, profile filter, "blocked only" toggle, "purge rows older
  than 24h" action. Records host + port + byte counts + timing +
  blocked-by reason. URL paths are never stored. Tor profile has
  `audit=false` so its traffic never lands here.

- **Kill switch**
  (`src-tauri/src/browser/dispatcher.rs`,
  `src/pages/WebPage/ProfileRail.tsx`)
  One toggle on the profile rail arms a global `RwLock<bool>`. Every
  subsequent dispatcher call for any profile without
  `kill_switch_bypass=true` returns `Err("blocked: kill_switch")`
  before a socket opens. The posture bar renders the armed state
  loudly.

- **Tests**
  25 new unit tests across `browser::{profile,transport,dispatcher,
  reader,sandbox,downloads,research,media}` covering the safety
  posture of each profile's defaults, credential redaction, UA
  rotation stability, tracker-list matches, kill-switch short-circuit
  + bypass path, reader sanitizer tag allow-list, init-script
  fingerprint overrides, yt-dlp progress parsing, frame-rate budget,
  canonical-URL dedupe, URL encoding.

- **Documentation**
  New [`docs/BROWSER.md`](./docs/BROWSER.md) documents the threat
  model, dispatcher contract, profile table, sandbox init-script,
  bridge lifecycle, audit log schema, guardrails, and known limits.
  README gains a `Browser` section. `docs/TOOLS.md` gets the full
  `browser_*` command catalogue.

### Persistent AI agents — AUTO becomes a real automation surface

The AUTO module used to be the scheduler for recurring shell jobs. That
stayed, but the module now leads with something much bigger: **persistent
AI agents** — named goals, written in plain English, that SUNNY wakes up
on a cadence (or on a dispatched event), executes via the ReAct tool
loop, and reports back about. The `daemons` Rust subsystem had been sitting
unused (it predates the UI); this phase wires it end-to-end, adds a
template gallery, and restructures the module around four tabs.

- **Daemons runtime wired end-to-end**
  (`src/lib/daemonRuntime.ts`, `src/App.tsx`)
  The Rust `daemons_*` commands (`daemons_list`, `daemons_add`, …,
  `daemons_ready_to_fire`, `daemons_mark_fired`) already existed but the
  frontend never polled them. New runtime ticks every 15 s, calls
  `daemons_ready_to_fire`, spawns a sub-agent carrying the daemon's goal
  via `useSubAgents.spawn(goal, 'daemon:<id>')`, and tracks each fire in a
  module-scoped `Map<daemonId, runId>`. A zustand subscription on the
  sub-agent store watches for terminal status transitions on in-flight
  runs and calls `daemons_mark_fired(id, now, status, output)` with the
  truncated answer so Rust advances `next_run` / `runs_count` /
  auto-disables `Once` daemons. `runDaemonNow()` and `emitDaemonEvent()`
  are exported so the UI (and any other module) can force-fire a daemon
  or trigger all `on_event` subscribers by name. Boots alongside the
  existing background loops in `App.tsx`; also fixed a latent bug where
  `startSubAgentWorker()` had never been called, so every queued sub-agent
  would have sat idle — the daemon runtime depends on that worker
  draining the queue via the ReAct agent loop.

- **Daemons store + typed API** (`src/store/daemons.ts`)
  Thin zustand cache keyed by the returned `Daemon[]` so multiple pages
  (AgentsTab + ActivityTab) share one in-memory list. `refresh()` is
  idempotent, fail-soft, and no-ops when the backend isn't present.
  Helpers `describeSchedule`, `humanizeSecs`, `nextRunRelative`,
  `lastRunRelative` keep the UI components free of time arithmetic.
  Frontend types mirror the Rust `Daemon` and `DaemonSpec` structs exactly
  so serde/TS stay in lockstep.

- **AGENTS tab** (new `src/pages/AutoPage/AgentsTab.tsx`)
  Leads the module. Two sections:
  - **Installed agents** — one row per daemon. Left-border status color
    (cyan running / green armed / dim paused), pulsing dot while
    actively running, `NEXT` / `LAST` meta-pills, inline run counter.
    Expand the row to see the full goal, the last output (colored by
    status — green for done, amber for aborted/max_steps, red for error),
    and action buttons: `RUN NOW` (bypasses schedule via the runtime),
    `PAUSE`/`RESUME`, 2-click `DELETE`. `isRunning` derives from a live
    poll of `inFlightDaemonIds()` so the UI flips state within ~1.5 s of
    a fire.
  - **Starter templates** — 12 one-tap recipes across 6 categories
    (`MORNING`, `FOCUS`, `INBOX`, `CLEANUP`, `WATCHERS`, `LEARN`). Each
    card shows icon + title + 1-line summary + cadence chip; install
    creates a daemon via `daemons_add` with the template's natural-English
    goal. A card marks `✓ INSTALLED · ADD COPY` when the name already
    exists so re-installing is clearly additive, not replacive. See
    `src/pages/AutoPage/templates.ts` for the full set; goals are
    intentionally concrete enough that the LLM doesn't improvise new
    intent but abstract enough that tool routing can evolve.
  - **Custom agent form** — expands from `+ CUSTOM AGENT`. Title +
    plain-English goal textarea + kind picker (`interval` / `once` /
    `on_event`) + schedule controls matching each kind (6 interval
    presets, datetime-local for once, event-name input for on_event).
    Validates minimum goal length client-side so a blank agent never
    reaches the Rust side.

- **ACTIVITY tab** (new `src/pages/AutoPage/ActivityTab.tsx`)
  Three panes, top-down:
  - `LIVE · N ACTIVE` — queued/running sub-agents, newest first, pulsing
    cyan chip + gradient background while running. Cross-references each
    run to its parent daemon via the `daemon:<id>` parent id, so rows
    spawned from AGENTS show a `▸ daemon: <title>` breadcrumb.
  - `RECENT FIRES · N` — last 10 daemons that have fired, with the
    `last_status` colored chip and expandable `last_output` block.
  - `COMPLETED SUB-AGENTS · N` — last 12 finished runs with expandable
    `finalAnswer`. `CLEAR FINISHED` button wipes terminal runs from the
    store without touching queued/running.
  All three poll the same underlying `useSubAgents` / `useDaemons`
  stores, so no extra backend traffic — the same data that drives tab
  badges drives this view.

- **Tab chrome: AGENTS · TODOS · SCHEDULED · ACTIVITY, hotkeys 1–4, live counters**
  (`src/pages/AutoPage/index.tsx`)
  Restructured the index from two tabs (TODOS + SCHEDULED) to four. Each
  tab chip shows a live `· N` badge (armed daemons, open todos, active
  scheduler jobs, active sub-agent runs) next to its label, colored
  cyan on the active tab and dim otherwise. Page-scoped hotkeys `1`/`2`/
  `3`/`4` jump tabs; guarded against text inputs so typing `"1"` into a
  goal field doesn't teleport the user. `ModuleView` header badge swaps
  per-tab context ("3/5 ARMED", "12/20 OPEN", "2 LIVE").

- **12 starter template recipes** (`src/pages/AutoPage/templates.ts`)
  - `MORNING`  — Morning briefing (calendar + priorities + urgent mail +
    weather, 24 h cadence), End-of-day wrap.
  - `FOCUS`    — 90-min focus check-in (gated to 09:00–18:00 local),
    Auto-generated standup (yesterday/today/blockers from tasks +
    calendar + agent runs).
  - `INBOX`    — 30-min inbox triage (classifies mail as urgent via
    known-correspondent + explicit-deadline heuristics), hourly
    iMessage digest (one sentence per person with unreads).
  - `CLEANUP`  — Downloads auto-sort (by extension + age, preserves
    last-24h files), Desktop zero (dated archive of anything older than
    3 days).
  - `WATCHERS` — 6-hourly security sweep (runs SCAN on ~/Downloads +
    LaunchAgents, alerts on suspicious/malicious), daily running-process
    audit (hashes every running binary against MalwareBazaar).
  - `LEARN`    — Sunday weekly review (300-word reflection from the
    week's memory episodes + completed tasks), 4-hour knowledge rotator
    (spaced-repetition quiz from one random semantic fact).

### SCAN module — real AI-assisted virus scanner

A brand-new module that performs actual malware detection on macOS files:
SHA-256 hashing, MalwareBazaar + optional VirusTotal lookup, heuristic
analysis (quarantine xattr + codesign verification + magic bytes + path
risk + recent-modification), and an isolated quarantine vault. Wired
into the agent tool registry so SUNNY can scan via voice or chat.

- **Rust scanner backend** (new `src-tauri/src/scan/`)
  - `types.rs` — `Verdict` (clean / info / suspicious / malicious /
    unknown, with a `max(a,b)` combinator), `Signal`, `Finding`,
    `ScanOptions`, `ScanProgress`, `ScanRecord`, `VaultItem`. Every struct
    uses `#[serde(rename_all = "camelCase")]` to match the TS frontend.
  - `hash.rs` — streaming SHA-256 via a 64 KB buffer with an
    `AtomicBool` cancellation token, so aborting mid-hash on an 800 MB
    DMG is instant.
  - `heuristic.rs` — per-file inspections: `com.apple.quarantine` xattr
    (via `/usr/bin/xattr -p`, extracts originating agent — Safari, Chrome,
    AirDrop, …); `codesign --verify --deep --strict` with tampered-vs-
    unsigned distinction; magic-byte classification (Mach-O / ELF / PE /
    shebang, flagging non-standard interpreters); path-risk flags for
    `~/Downloads`, `~/Desktop`, `/tmp`; recently-modified (<24h);
    hidden-in-user-dir (dotfiles inside Downloads/Desktop/Documents).
  - `bazaar.rs` — MalwareBazaar hash-lookup client (`mb-api.abuse.ch`,
    no API key required), plus optional VirusTotal (if the user sets
    `SUNNY_VIRUSTOTAL_KEY`). Results cached to `~/.sunny/scan_cache.json`
    for 30 days so repeat scans don't hammer the network.
  - `vault.rs` — quarantine storage at `~/.sunny/scan_vault/`. Atomic
    rename of the flagged file to `<uuid>.bin`, `chmod 000` lock on the
    moved binary, sibling `<uuid>.json` metadata (original path, verdict,
    reason, signals, SHA). Restore rewrites mode back to `0644` and
    moves it home (with overwrite flag); delete chmods back first so
    `remove_file` actually succeeds.
  - `scanner.rs` — orchestrator. One async task per scan via
    `tauri::async_runtime::spawn` (critical — `tokio::spawn` panics from
    a sync `#[tauri::command]` because those run on the blocking pool
    with no tokio runtime handle in scope). Iterative filesystem walker
    that skips symlinks, `node_modules`, `.git`, `target`, `build`,
    `dist`, `.next`, `.cache`, and anything above `max_file_size`.
    Verdict combination rule: `quarantined + unsigned + risky_path = suspicious`
    even if each individual signal is only `info`. Also exposes
    `start_many(label, targets, options)` for preset scans that want to
    target a curated list (running processes, LaunchAgents).
  - `commands.rs` — 13 Tauri handlers: `scan_start`, `scan_start_many`,
    `scan_status`, `scan_findings`, `scan_record`, `scan_abort`,
    `scan_list`, `scan_quarantine`, `scan_vault_list`, `scan_vault_restore`,
    `scan_vault_delete`, `scan_pick_folder` (AppleScript `choose folder`
    so we don't need `tauri-plugin-dialog`), `scan_reveal_in_finder`
    (`open -R`), `scan_running_executables` (`ps -axo comm=` dedup to
    full on-disk paths).

- **Frontend ScanPage with 4 tabs** (new `src/pages/ScanPage/`)
  - **SCAN** — target picker with native folder-pick button + drag-drop
    target card + 8 presets (`~/Downloads`, `~/Desktop`,
    `/Applications`, `~/Applications`, `/tmp`, plus the three
    LaunchAgents/LaunchDaemons directories where macOS malware
    persists); `SMART TARGETS` row with `▸ RUNNING PROCESSES` that
    enumerates live executables via `scan_running_executables` and
    scans them via `scan_start_many`. Option toggles for
    recursive / online-lookup / VirusTotal / deep; 4 max-file-size
    chips (10 MB / 100 MB / 1 GB / no limit). Cancellable mid-scan.
  - **FINDINGS** — search box (path + summary + SHA substring, `/`
    hotkey focuses it), verdict filter pills, sort options
    (SEVERITY / PATH / SIZE / RECENT), bulk select (`SELECT VISIBLE`
    + `QUARANTINE N SELECTED`), `EXPORT JSON` button downloads a
    timestamped report. Per-row `REVEAL IN FINDER` + `COPY PATH` +
    `COPY SHA-256` + `MOVE TO VAULT`.
  - **VAULT** — header stat cards (TOTAL, SIZE, MALICIOUS, SUSPICIOUS,
    INFO breakdown), per-item rows with original + vault paths, SHA,
    quarantined-when, expandable signal chips, actions: `RESTORE`,
    `RESTORE (OVERWRITE)`, `REVEAL IN FINDER`, 2-click
    `DELETE FOREVER`.
  - **HISTORY** — past scans with phase chip, elapsed, file counts,
    clickable to reload findings.
  - **Page hotkeys** 1/2/3/4 jump tabs; `/` focuses findings search.
  - **ScanPage tools for the agent** (`src/lib/tools/builtins/scan.ts`)
    Registers `scan_start`, `scan_findings`, `scan_quarantine` (marked
    dangerous), `scan_vault_list` into the tool registry so the ReAct
    loop can scan, inspect, quarantine, and list the vault on the
    user's natural-language instruction.

- **Animated HUD progress view with radar gauge + segmented bar**
  (`src/pages/ScanPage/ScanTab.tsx`, `src/styles/sunny.css`)
  The "LIVE / SUMMARY" card on the SCAN tab was upgraded from a flat
  progress bar to a HUD-native experience. Left column: a 170 px radial
  threat gauge — 32 tick marks around the rim with the outer tick ring
  rotating at 9 s/rev while the scan runs, an independent 2.6 s/rev
  radar sweep cone (linear-gradient wedge, drop-shadow in the active
  level color) layered over it, a filled 270° arc that grows on
  threat-level changes with a 420 ms eased transition, and a centered
  count that pulse-scales with a colored drop-shadow when threats > 0.
  Right column: a 48-cell segmented progress bar where each lit cell
  carries its own cyan/amber/red glow and a 2.2 s traveling shimmer
  sweeps across the whole bar while scanning. Verdict counter cards
  stay dim until their count > 0, then light up with a colored border,
  inner glow, and gradient background; the `MALICIOUS` card additionally
  pulses with the existing `sysCrit` keyframe. A 5-bar EQ meter (reuses
  the theme's `barA` keyframe) sits next to the stats row during active
  scans and pauses on completion. The current-file line is now a
  CRT-style phosphor ticker with a cyan left-edge accent and a glowing
  caret blinking on the `blink2` keyframe. Post-scan banner shifts
  color/animation based on severity (green ok / amber warn /
  animated-opacity critical). All animations live in `sunny.css` as
  `.scan-*` classes so they track `--cyan`, `--amber`, `--red`, `--green`
  in lockstep with theme changes.

### Module consolidation — 16 → 11 sidebar entries

The left nav had accreted to sixteen modules, most of which were either
rarely-used or thematically close to another. Consolidated into eleven
while keeping every feature reachable, and wired tabbed sub-pages for
the grouped ones.

- **Removed**: `NOTES` module (page folder deleted, nav entry dropped,
  ViewKey entry removed, all CommandBar / QuickLauncher / hotkey refs
  cleaned up).
- **TASKS → AUTO** — one-off todos moved into `AutoPage` as the `TODOS`
  tab. Old `TasksPage.tsx` deleted; logic extracted into
  `AutoPage/TodosTab.tsx`. `AutoPage/ScheduledTab.tsx` holds what used
  to be the full `AutoPage` (the recurring-job scheduler).
- **HISTORY → MEMORY** — agent run history is now a `HISTORY` tab of
  the MEMORY page alongside `EPISODIC`/`SEMANTIC`/`PROCEDURAL`/`TOOLS`/
  `INSIGHTS`, since it is literally episodic-memory-with-more-structure.
  `AgentHistoryPage.tsx` deleted; logic in `MemoryPage/HistoryTab.tsx`.
  Hotkey `6` inside MEMORY switches to the history tab.
- **CAPABILITIES + CONSTITUTION → SETTINGS** — both are configuration
  surfaces, so both became tabs of `SettingsPage`. `SettingsPage.tsx`
  turned into a directory: `index.tsx` (tab wrapper with hotkeys 1-3),
  `GeneralTab.tsx` (the original settings body), `CapabilitiesTab.tsx`
  (from `SkillsPage`), `ConstitutionTab.tsx` (from `ConstitutionPage`).
  The old flat `SkillsPage.tsx` and `ConstitutionPage.tsx` were
  deleted.
- **Nav / hotkey / CommandBar remap** — `NAV_MODULES` seed array
  trimmed to 11 entries; `ViewKey` union in `store/view.ts` reduced to
  the final set. Cmd/Ctrl+1..9 digit table re-walked to:
  `Overview · Files · Apps · Auto · Calendar · Screen · Contacts ·
  Memory · Web`. `HelpOverlay`, `QuickLauncher` `LABEL_TO_VIEW`,
  `CommandBar/constants.ts` `NAV_TARGETS`, and `NavPanel`
  `ALWAYS_GREEN`/`TAURI_DEPENDENT` sets all updated to the new module
  list so every launch surface agrees with the nav.
- **New nav icon for SCAN** (`src/components/NavIcons.tsx`)
  Inline SVG of a shield silhouette with a sweeping scan arc + a
  crosshair dot at the center — reads as "protective scan" at the
  sidebar's glyph size. Added `NAV_MODULES` row between WEB and VAULT.

### Multi-terminal workspace — real, fast, AI-addressable PTYs

The three HUD terminal tiles used to be stubs: a shared shell with the
wrong termios, no way to add more, and the AI couldn't see them. This
phase turned them into a proper multi-terminal workspace — real shells
that behave the way Terminal.app users expect, a popout grid for running
multiple projects side-by-side, and a seven-tool AI surface so "anything
I can do in those terminals, the agent can do too" is now literally true.

- **Sane PTY termios + child kill-on-close** (`src-tauri/src/pty.rs`,
  `src-tauri/Cargo.toml`)
  A macOS `.app` launched from Finder has no controlling tty, so
  `libc::openpty()`'s default termios came up undefined — ICANON off,
  ECHOE off, VERASE unset. That's why `ll` + backspace echoed
  `ll^?^?^?^?` and `claude` never actually ran (Enter never flushed a
  line into zsh's read loop). After `openpty` we now write a canonical
  "`stty sane`" termios onto the master fd via libc's `tcgetattr` /
  `tcsetattr`: `ICANON|ECHO|ECHOE|ECHOK|ECHOKE|ECHOCTL|ISIG|IEXTEN` on
  lflag, proper `c_cc` slots (`VERASE=0x7f`, `VINTR=0x03`, `VEOF=0x04`,
  `VKILL=0x15`, `VSUSP=0x1a`, `VWERASE=0x17`, `VLNEXT=0x16`),
  `ICRNL|BRKINT|IXON|IMAXBEL|IUTF8` on iflag, `OPOST|ONLCR` on oflag,
  and a non-zero 38400 baud so tools that sanity-check `stty` don't
  bail. `PtyHandle` now owns the child `Box<dyn Child>` and its `Drop`
  impl `kill()` + `wait()`s — closing a tab actually terminates the
  shell instead of leaking it, and `pty_open` is idempotent (replacing
  an existing id drops the old Arc first). Login shell spawned with
  `-l -i` plus inherited PATH + forced `TERM=xterm-256color`,
  `COLORTERM=truecolor`, `LANG` fallback so nvm / brew / pyenv init
  actually runs and `claude` lands on PATH.

- **UTF-8-safe coalescing reader** (`src-tauri/src/pty.rs`)
  The old reader called `String::from_utf8_lossy(&buf[..n])` every read,
  silently replacing any multibyte codepoint split across reads with
  U+FFFD — every emoji / CJK / box-drawing character corrupted at
  random boundaries. Replaced with a stateful carry buffer that runs
  `std::str::from_utf8(&carry).err().valid_up_to()` to find the longest
  valid prefix, emits only that, and holds back at most 3 trailing
  bytes until the next read completes them. Read buffer doubled to
  16 KB, coalesce flush tightened from 16 ms → 8 ms so interactive
  latency stays snappy while a `tail -f` still batches into the IPC
  bridge. Safety valve drops an eight-byte stuck carry as a single
  U+FFFD so one genuinely garbled byte can't stall the stream forever.

- **Race-safe xterm frontend with per-mount session ids**
  (`src/components/PtyTerminal.tsx`)
  React StrictMode double-mounts effects in dev, and the old frontend
  raced: an async `boot()` could finish *after* the effect's cleanup
  flipped `disposed = true`, registering listeners on a dead xterm and
  leaking a second shell under the same backend key. Each mount now
  picks a nonce'd `sessionId = \`${id}-${nonce()}\``; every `await`
  checks `disposed` and unwinds (unlisten + `pty_close`) if so.
  Keystrokes typed before `pty_open` resolves are buffered into
  `pendingInput` and replayed on connect instead of dropped. Always
  `pty_close` in cleanup (the backend no-ops on unknown ids) so a
  torn-down mount can't leak a child shell.

- **WebGL renderer, Unicode 11 widths, and inline ⌘F search**
  (`src/components/PtyTerminal.tsx`; new `@xterm/addon-webgl`,
  `@xterm/addon-unicode11`, `@xterm/addon-search` deps)
  GPU rendering on by default — typically 2–5× faster than the canvas
  renderer on busy streams; `webgl.onContextLoss(() => webgl.dispose())`
  falls back silently if macOS thermals yank the context. Unicode 11
  width tables via `term.unicode.activeVersion = '11'` so emoji / CJK /
  newer symbols render at their correct column width (no more cursor
  drift). `attachCustomKeyEventHandler` handles ⌘C (clipboard write on
  selection), ⌘V (`term.paste()` — uses bracketed paste when the shell
  has enabled DECSET 2004), ⌘F (inline search bar, Enter / Shift-Enter
  for next/prev, Esc to close), and ⌘K to clear the buffer.
  ResizeObserver callbacks coalesced via rAF so a window drag does one
  `fit()` per frame instead of dozens. Scrollback 5 k → 10 k lines.

- **Streaming OSC/ANSI parser for auto-titles + cwd tracking**
  (`src/lib/ansiParse.ts`, `src/store/terminals.ts`)
  Feeds every PTY chunk through an 80-line stateful parser that handles
  OSC / CSI / charset escapes across read boundaries. Extracts OSC 0/1/2
  (`ESC ] n ; title BEL|ST`) → `splitTitleRunning` splits macOS-style
  `node — ~/code/sunny` into `running="node"` / `label="~/code/sunny"`;
  OSC 7 (`ESC ] 7 ; file://host/path ESC\\`) → decoded cwd. Apple's
  `/etc/zshrc_Apple_Terminal` already emits both, so `cd ~/proj`
  updates the sidebar label and path hint live without any user config.
  Remaining bytes pass through an SGR-stripper so the ANSI-clean text
  lands in a 64 KB ring buffer that the AI reads without having to cope
  with escape codes.

- **Terminals store + narrow-subscription perf model**
  (`src/store/terminals.ts`)
  Single zustand source of truth keyed by stable app-level id: dashboard
  tiles seed at module load with `dash:{shell,agent,logs}` (pinned
  titles); overlay tiles auto-gen `user:N`. Each session tracks
  `sessionId` (backend key, rotated per mount), `title` /
  `titlePinned` (auto-updates suppressed once the user renames), `cwd`,
  `running`, a 64 KB `output` ring buffer, and `activity_tick` vs
  `last_seen_tick` to drive the sidebar "new activity" dot.
  `setFocused` atomically clears the focused tile's activity flag so
  the dot disappears with no flash. Non-React `getTerminal` /
  `listTerminals` accessors let tool runners read state without eating
  a subscription.

- **TerminalsOverlay — sidebar + max-3-per-row grid** (new
  `src/components/TerminalsOverlay.tsx`, lazy-mounted in
  `src/components/Dashboard.tsx`)
  Full-screen ⌘F-style overlay: 260 px sidebar (workspace tiles
  clickable, dashboard tiles read-only, `+ New terminal` pinned to the
  bottom) + right pane with `grid-template-columns:
  repeat(min(count, 3), 1fr)` so tiles 1–3 share a row and tile 4
  wraps. Per-tile expand button fullscreens within the overlay; global
  Esc exits fullscreen first then closes. Keyboard: ⌘T new, ⌘1..9
  switch tiles, ⌘F per-tile scrollback search. Opens on the
  `sunny-terminals-open` custom window event (fired by each dashboard
  tile's expand icon and by the AI's `terminal_spawn`). `SidebarRow`
  and `TileHost` are `React.memo`'d with `useShallow` subscriptions to
  *only their own session's* fields, so one tile's firehose output can
  no longer re-render the other eight. Double-click a sidebar title to
  rename — Enter commits and pins (auto-titles stop clobbering), Esc
  cancels. All colors reference CSS vars, so the Settings theme
  switcher retints the overlay live through `body.theme-<name>` with
  zero extra wiring.

- **Panel `headerExtra` slot for crisp icon buttons**
  (`src/components/Panel.tsx`, `src/components/PtyTerminal.tsx`)
  `.panel h3 small` applies `color: var(--ink-2)` + `overflow: hidden`,
  which made the first pass of the expand / close buttons render
  near-invisibly when they sat in the Panel's `right` slot. New
  `headerExtra` prop renders in the h3 next to `<small>` but outside
  it, so icon chips keep their bright `var(--cyan)` border + black
  separator shadow at 20 × 20 (11 × 11 SVG glyphs at stroke 1.5).
  Dashboard tiles now show `[⊾⊿]` next to "zsh" / "sunny-cli".

- **Seven user-facing terminal tools** (`src/lib/tools.terminals.ts`,
  `src/App.tsx`)
  New self-registering tool module exposing the exact terminals the
  human is looking at — orthogonal to the existing headless
  `pty_agent_*` family. `dangerous` flags set for anything with side
  effects.
  - `terminals_list` — enumerate every visible terminal (dashboard +
    overlay) with id, title, origin, cwd, running hint, and
    buffered-byte count.
  - `terminal_spawn` — add a new overlay tile; optional `title` (pinned
    if provided), `command` (typed as if the user hit Enter, after
    `waitForSessionId` polls until the PTY is ready), `focus`,
    `fullscreen`.
  - `terminal_send` — type into a terminal by stable id; default
    appends `\\n`, `press_enter: false` sends raw bytes so the AI can
    inject Ctrl-C (`"\\u0003"`), tab-complete, ANSI sequences, etc.
    Uses `waitForSessionId` (5 s) so calling it right after
    `terminal_spawn` works.
  - `terminal_read` — ANSI-stripped tail of the ring buffer (default
    2000, max 16000 chars); non-destructive.
  - `terminal_wait_for` — polls the ring buffer every 80 ms with
    `haystack.match(regex)` (`/g` stripped from user flags so state
    doesn't leak across polls), returns first match offset + 240 ch
    excerpt or times out. This is the piece that makes `send →
    wait_for → read` a reliable workflow.
  - `terminals_focus` — switch focus + open the overlay (opens
    automatically if closed; dashboard origins just mark-seen since
    they live in the HUD).
  - `terminal_close` — close overlay terminals; refuses dashboard
    (`dash:*`) since they are permanent HUD tiles.

**Dependencies**: +1 Rust crate (`libc` for `tcgetattr` / `tcsetattr`),
+4 npm packages (`@xterm/addon-webgl`, `@xterm/addon-unicode11`,
`@xterm/addon-search`, `@xterm/addon-clipboard`). `TerminalsOverlay`
ships in its own code-split chunk (~8 kB gzipped) so the critical path
is unaffected.
**New agent tools**: +7
(`terminals_list`, `terminal_spawn`, `terminal_send`, `terminal_read`,
`terminal_wait_for`, `terminals_focus`, `terminal_close`).

---

### Screen module — real capture, OCR, and click-through

Rewrote `src/pages/ScreenPage.tsx` from a decorative HUD mockup (hard-coded
display thumbnails, fake app chips, seeded activity feed) into a working
screen tool wired to the existing `vision`, `ocr`, `ax`, and `automation`
Tauri commands. Everything the page shows is now live data, and every
button does something real.

- **Live capture preview** (`src/pages/ScreenPage.tsx`)
  Renders the actual PNG from `screen_capture_full` (data-URL from the
  base64 payload) with real width × height × byte-size badges and a
  relative-age label that ticks every second. An `AUTO` selector
  (`OFF / 5s / 15s / 60s`) polls only when `document.visibilityState ===
  'visible'` so background tabs don't churn the shell. Click the preview
  to zoom into a full-size modal viewer (Esc closes).

- **Drag-to-select region capture**
  `SELECT REGION` toggle turns the preview into a crosshair canvas.
  Drag a rectangle → cyan selection with a vignette mask + inline
  `CAPTURE SELECTION / CLEAR` toolbar. Normalized drag coords are
  multiplied by `screen_size()` (logical points) and handed to
  `screen_capture_region(x, y, w, h)`, so what you draw is what you
  capture — no more typing four integers. Works only when the current
  preview is a `FULL` capture with a known screen size; the manual
  `REGION · MANUAL` form remains for precise numeric entry.

- **OCR overlay with click-to-click-on-screen**
  `SHOW BOXES` paints every OCR word rectangle over the preview.
  Live search input filters/highlights matches in amber and dims the
  rest (with `N MATCHES` count). On a `FULL` capture, clicking a box
  translates image-pixel coords to screen points
  (`scale = image.width / screenSize.w`) and drives the real cursor
  via `mouse_click_at` — a point-and-click "click the Submit button"
  affordance that reuses the same math as `click_text_on_screen`.
  On window / region captures, box click copies the word to the
  clipboard instead. Pointer events auto-disable on boxes while
  `SELECT REGION` is active so the two modes don't fight.

- **Active Window panel + window list**
  Polls `window_focused_app`, `window_active_title` every 3 s and
  `window_list` every 8 s. Shows real app / bundle id / pid / title
  for the frontmost window and a scrollable list (up to 60) of every
  open window with `w×h` dimensions. The row matching the focused app
  is highlighted in cyan. Focus transitions push a `FOCUS` row to the
  activity timeline. Each row gets two tiny actions:
  - `FOCUS` → sanitized AppleScript `tell application "<name>" to
    activate` through the `applescript` command, then re-polls focus
  - `SHOT` → activates the app, waits 250 ms, then runs
    `screen_capture_active_window` with the app name stamped on the
    capture

- **Capture details + OCR panel**
  Right half of the details panel hosts an interactive OCR workflow:
  `RUN OCR` hits `ocr_image_base64`, shows box count + average
  confidence + engine, and renders the extracted text in a scrollable
  mono block. `COPY TEXT` copies the OCR body to the clipboard
  (`navigator.clipboard.writeText`). Left half shows the capture
  thumbnail with `SRC / DIMS / SIZE / AT (region) / APP` meta and
  four actions: `DOWNLOAD` (Blob → `<a download>`), `COPY IMG`
  (`navigator.clipboard.write` with `ClipboardItem` fallback to
  shell `screencapture -c`), `CLIP · SHELL`, and `CLEAR`.

- **Capture history strip**
  Horizontal ribbon of the last six captures as real thumbnails,
  each showing source + age. The active one gets a cyan outline +
  glow. Click to restore as the current capture (OCR and drag state
  reset, restore event logged).

- **Keyboard shortcuts**
  Page-level `keydown` listener, no-op when focus is inside an
  `input` / `textarea` / `contenteditable`: `SPACE` full capture,
  `O` run OCR, `B` toggle boxes, `S` toggle select mode,
  `D` download, `C` copy image, `ESC` closes modal or cancels
  select mode. Shortcut legend rendered in the action strip.

- **Real activity timeline**
  Seeded with a single `SYS` row, then populated by real events:
  `SNAP` for every capture (dims + bytes), `OCR` for runs + copies,
  `FOCUS` for focus transitions, `CLICK` for OCR box clicks,
  `SNAP` for history restores, `ERR` in red for any failure with the
  real stderr / exception message inlined. Capped at 80 rows.

- **Shell-backed utility actions**
  `SHOT → FILE` shells out to `screencapture -x ~/Desktop/sunny-shot-
  <ts>.png`; `SHOT → CLIPBOARD` runs `screencapture -c`;
  `TOGGLE DARK` calls the dark-mode AppleScript; `DISPLAY SLEEP`
  runs `pmset displaysleepnow`. All four route through a single
  `runShellAction` helper that toasts + logs either the success or
  the trimmed `stderr` / exit code.

- **Graceful offline + permission paths**
  When the page is mounted outside the Tauri runtime (`isTauri`
  false), capture / activate / list buttons dim and the preview
  shows `SCREEN · TAURI RUNTIME REQUIRED`. When `screencapture`
  returns an empty PNG (typical when Screen Recording permission
  is missing), the error surfaces in red in the preview and as an
  `ERR` timeline row instead of silently producing a blank. Empty
  window list tells the user to check System Events → Automation.

**Bundle impact**: `ScreenPage` went from 14 KB / 3.95 KB gzip to
31.71 KB / 9.54 KB gzip — all of it real interactivity, not chrome.
**New Tauri commands**: 0 (reuses existing `screen_capture_full`,
`screen_capture_region`, `screen_capture_active_window`,
`window_focused_app`, `window_active_title`, `window_list`,
`ocr_image_base64`, `screen_size`, `mouse_click_at`, `applescript`,
`run_shell`).

---

### Agentic Contacts — text, call, and reply-on-behalf

Turned the Contacts module from a read-only iMessage list into a proper
communications surface: SUNNY can now text or call anyone in your
conversation history or AddressBook, and a per-contact "proxy" can draft
(or auto-send) replies on your behalf. All side-effectful paths flow
through the existing ConfirmGate + Constitution + Critic pipeline.

- **Tier 1 · text / call tools** (`src/lib/tools/builtins/comms.ts`,
  `src-tauri/src/messaging.rs`)
  Seven new agent tools, dangerous-flagged where they have side effects:
  - `send_imessage` / `send_sms` — direct handle send
  - `text_contact` — fuzzy-name resolution → send (returns a candidate
    list on ambiguity so the agent can ask which Sunny you meant)
  - `call_contact` — phone (via iPhone continuity), FaceTime audio, or
    FaceTime video
  - `list_chats`, `fetch_conversation` — read-only chat.db helpers
  - `resolve_contact` — read-only lookup before a risky send
  Phone/FaceTime routing uses the macOS URL schemes (`tel:`,
  `facetime-audio:`, `facetime:`) via `open`. Group-chat guards reject
  calls to synthetic `chat<id>` identifiers with a clear error.

- **Tier 2 · per-contact AI proxy** (`src-tauri/src/messages_watcher.rs`,
  `src/lib/proxyEngine.ts`, `src/store/proxy.ts`, `src/store/proxyInbox.ts`,
  `src/pages/ContactsPage/ProxyPanel.tsx`)
  New 5-second tokio poller watches `chat.db` for *subscribed*
  conversations (no traffic until you opt a contact in). On every
  inbound message it emits `messages:new`; the frontend pulls the last
  10 messages for context, runs the cheap-model route with a user-defined
  persona prompt, and either queues a draft with `SEND` / `EDIT` / `SKIP`
  buttons, or (if `autoSend` is on) sends after a 30 s cooldown + HIGH-risk
  ConfirmGate. Configs persist to `localStorage`; a global "PAUSE ALL"
  banner on the Contacts page kills every proxy at once.

- **Tier 3 · voice-on-call stub** (`src/pages/ContactsPage/ConversationDetail.tsx`)
  `SPEAK FOR ME` button visible but disabled with a tooltip pointing to
  the virtual-audio-device + consent-flow work required to ship it.

- **Real contact names** (`src-tauri/src/contacts_book.rs`)
  Reads every `AddressBook-v22.abcddb` under
  `~/Library/Application Support/AddressBook/` (consolidated +
  per-source), builds a normalised `handle → display name` index
  (leading `1` stripped on 11-digit NANP numbers so `+16045551234`,
  `16045551234`, `(604) 555-1234` all land on the same key), caches
  for 60 s. Joined into `messages::recent_contacts` so "+1 (604) 555-1234"
  now renders as "Sunny". Nicknames preferred over full names. Frontend
  gets the full index via the new `contacts_book_list` command so the
  resolver can find "text Mom" even when Mom hasn't texted recently.

- **attributedBody extraction** (`src-tauri/src/attributed_body.rs`)
  iOS 16 / macOS Ventura stores message text inside `attributedBody`
  (NSTypedStream BLOB) and leaves `text` null, which is why half of every
  modern conversation was showing as "—". New precise walker looks for
  `NSString\x01` followed by a `+` opcode and decodes the length-prefixed
  UTF-8. Fallback heuristic splits printable runs on known class-name
  boundaries (`NSMutableAttributedString`, `__kIMMessagePartAttributeName`,
  etc.) and picks the longest remaining fragment with ≥ 40 % alphanumeric
  density. Both `messages::recent_contacts` and `messaging::fetch_conversation`
  query `HEX(attributedBody)` as a fallback column.

- **Unread badges** (`src/pages/ContactsPage/index.tsx`,
  `src/pages/ContactsPage/ConversationDetail.tsx`)
  New `unread_count` on `MessageContact` populated via
  `COUNT(*) WHERE is_from_me = 0 AND is_read = 0`. Row gets a cyan pill
  + bold name; detail header gets an "N UNREAD" chip; module badge now
  reads `42/100 · 5 UNREAD · 2 PROXYS`.

- **Proxy draft notifications** (`src/lib/proxyEngine.ts`)
  When a draft lands in draft-only mode (the default), fire a native
  `notify_send` with the contact name + 80-char preview so you don't
  have to keep the Contacts page open to know something's waiting for
  review. Auto-send skips this (the ConfirmGate is the notification).

- **Transcript pane + quick composer** (`src/pages/ContactsPage/ConversationDetail.tsx`)
  Replaced the old single-button "OPEN IN MESSAGES" with a scrolling
  live transcript (6 s polling), left/right bubbles, attachment
  placeholders, and a `⌘↩`-to-send composer gated by ConfirmGate.
  Call action row: `CALL`, `FACETIME AUDIO`, `FACETIME VIDEO`,
  `SPEAK FOR ME`, `OPEN IN MESSAGES`, `COPY HANDLE`; the dialing buttons
  hide on group chats.

- **Watcher subscription management** (`src-tauri/src/messages_watcher.rs`)
  Frontend registers subscriptions via
  `messages_watcher_set_subscriptions(subscriptions: {chat_identifier, since_rowid}[])`.
  Zero-subscription state = zero polling. Poller advances each cursor
  after emitting so reconnects never double-fire.

- **Better 1:1 sorting + group-chat dedup** (`src-tauri/src/messages.rs`)
  Query refactored to group by `chat` (not `handle`) and pull
  `display_name` / `style == 43` / participant list — group chats now
  appear once (not once per participant), with their real name when
  set or the first 2–3 participants otherwise.

- **Nav sidebar overflow fix** (`src/styles/sunny.css`)
  Tightened `.nav button` padding (8 → 6 px) and gap (4 → 3 px) plus
  `flex-shrink: 0` so all 15 modules fit in the fixed 528 px panel.

**Test count**: **210 Rust tests** passing (new coverage across
`attributed_body::*`, `contacts_book::*`, `messaging::*`,
`messages::parse_json_uses_address_book`).
**New Tauri commands**: +7 (`messaging_call_phone`,
`messaging_facetime_audio`, `messaging_facetime_video`,
`messaging_fetch_conversation`, `messages_watcher_set_subscriptions`,
`messages_watcher_subscriptions`, `contacts_book_list`).
**New agent tools**: +7 (`send_imessage`, `send_sms`, `text_contact`,
`call_contact`, `list_chats`, `fetch_conversation`, `resolve_contact`).

---

### Overview dashboard controls + chat/scroll polish

The overview is no longer a passive status wall: every card now offers
direct action, and the chat pipeline renders OpenClaw 2026.3's new
response envelope correctly.

- **Invisible scroll on every card** (`src/styles/sunny.css`)
  `.panel .body` flipped from `overflow: hidden` to
  `overflow-y: auto; overflow-x: hidden`, plus a scoped
  `::-webkit-scrollbar { display: none }` + `scrollbar-width: none`
  rule targeting the body and all descendants (and a reusable
  `.sunny-scroll` utility). Content that overflows now scrolls silently
  — no visible track, no thumb, no layout shift.

- **Chat reply extraction understands OpenClaw 2026** (`src-tauri/src/ai.rs`)
  `openclaw agent --json` in v2026.3.11-beta.1 returns
  `{ payloads: [{ text, mediaUrl }], meta: {...} }`. The old
  `extract_reply` walked `reply/text/message/content/answer` and fell
  through to `raw.trim()`, so the chat bubble was rendering the full
  JSON envelope (or looked stuck behind Alfred's ~56 s warmup). Now
  concatenates every `payloads[*].text` (top-level and under
  `result/data/response/output`) before the legacy keys. Bonus:
  `openclaw_one_shot` now reads stdout+stderr in parallel via
  `tokio::join!`, inspects the child's exit status, and — when the
  reply is empty — returns `openclaw exit <code>: <last-5-stderr-lines>`
  so a bad config surfaces as a red `CHAT FAILED: …` system bubble
  instead of a silent stall.

- **ProcessesPanel gains real controls** (`src/components/ProcessesPanel.tsx`)
  - `CPU ▾` / `MEM ▾` chip in the header flips sort order; clicking
    the `CPU` or `MEM` column header also switches sort and highlights
    the active column.
  - `8` / `16` chip doubles the row budget so you can skim further
    without opening Activity Monitor.
  - Clicking any row opens Activity Monitor and fires a
    `Activity Monitor · <name>` toast.
  - Choices persist to `sunny.procs.sort.v1` / `sunny.procs.size.v1`.

- **Calendar card has inline quick-add** (`src/components/CalendarPanel.tsx`)
  `+ NEW` chip in the header reveals a compact
  `[time] [title…] SAVE` row. Enter saves, Escape cancels. When Tauri
  is live it calls `calendar_create_event` for a 60-min block at the
  chosen time; otherwise (or on permission error) it falls back to
  the existing local-event path and surfaces the macOS error as a
  toast. Event rows are now clickable and open Calendar.app.

- **Clipboard history is curatable** (`src/components/ClipboardPanel.tsx`)
  Every capture shows a pin (`◇`/`◆`) and dismiss (`×`) button in
  the timestamp row (stop-propagation so they don't trigger
  copy-on-click). Pinned items float to the top, get an amber accent
  stripe, and survive past the 20-item ring. Dismissed texts persist
  to `sunny.clip.hidden.v1` so tokens / junk don't reappear. Badge
  flips to `N · K📌` when pins exist; empty state reads
  `NOTHING CAPTURED`. Copy now emits a toast.

- **System bars are clickable** (`src/components/SystemPanel.tsx`)
  CPU / GPU / MEMORY / TEMP open Activity Monitor; BATTERY opens the
  Battery settings pane
  (`x-apple.systempreferences:com.apple.Battery-Settings.extension`).
  Cyan-brightening hover makes the affordance obvious.

- **Network rows become action rows** (`src/components/NetworkPanel.tsx`)
  IFACE row opens Network settings, SSID row opens Wi-Fi settings
  (double-click copies the SSID), PUBLIC IP row one-click-copies to
  clipboard with a confirming toast. Empty values (`—`) surface an
  info toast instead of copying blanks.

- **Shared overview UI primitives** (`src/styles/sunny.css`)
  - `.hdr-chip` — small cyan-outlined button matching `h3 small`
    typography, reused by every panel-header action above.
  - `.clickable` — shared hover affordance (background tint +
    accent-brightened value/icon) so every interactive row feels
    consistent across cards.
  - `.proc .row.hdr .sort-h` with `.active` glow for sortable
    columns.
  - `.cal-add` inline quick-add form styling.
  - `.clip .c.pinned` amber stripe + `.clip-btn` mini icon buttons.

**User-visible result**: the dashboard is a control surface, not just a
readout. One click opens Activity Monitor / Battery / Network / Wi-Fi /
Calendar; one chip sorts processes or adds an event; pins rescue good
captures from the clipboard ring. Cards that were clipping overflow
scroll invisibly, and the chat pipeline renders OpenClaw's native
envelope as clean prose.

---

### Menu-bar tray — branded icon + live structured menu

The macOS tray dropdown was a four-item flat menu (`Show SUNNY`, `Quick Ask…`,
`Pause Voice`, `Quit SUNNY`) whose two middle items emitted Tauri events that
nothing on the frontend actually listened to — they were dead buttons. The
icon was a solid colored dot. Replaced with a branded, live menu.

- **Branded orb icon** (`src-tauri/src/tray.rs`)
  The flat 16×16 circle is gone. The tray now paints an 18×18 "orb":
  soft-edged 4 px core, a faint halo, and two concentric orbit rings —
  the same silhouette as the app icon. Color still tracks status (cyan
  idle / amber running / green done / red error / dim-orange aborted)
  so state reads at a glance.

- **Structured menu with submenus**
  `build_menu` now assembles a disabled status header, `Show SUNNY`,
  `Quick Launcher…`, three submenus — `Go to` (11 pages + Settings),
  `Voice` (toggle + Stop Speaking), `Agent` (Abort / Clear) — plus
  `Preferences…`, `About SUNNY`, and `Quit`.

- **Menu is rebuilt on every status change**
  `tray_set_status` used to only swap icon + tooltip. It now also
  rebuilds the menu so the header reads `● Running · {goal}` /
  `✓ Done · {goal}` / etc. live, the voice item flips between
  `Pause Voice` and `Resume Voice`, `Abort Current Run` is only
  enabled while a run is in flight, and `Clear Run` is only enabled
  when there's a finished run to clear. Command signature gained
  `voice_enabled: Option<bool>` for the Voice submenu label.

- **Tray clicks now actually do things** (`src/App.tsx`)
  Previously `sunny://tray/quickask` and `sunny://tray/toggle-voice`
  were emitted and dropped on the floor (the JS companion code was
  sitting in comments at the bottom of `tray.rs`). Added real
  listeners for `quickask`, `toggle-voice` (also fires `speak_stop`
  when pausing so in-flight speech actually stops), `stop-speak`,
  `abort`, `clear`, `prefs`, and `about`. Nav items reuse the existing
  `sunny://nav` stream that `Dashboard` already handles.

- **Tray sync picks up voice changes too**
  The old subscription only fired on `useAgentStore` changes and
  skipped the initial state. Now a single `syncTray` runs once on
  mount and re-fires on both `useAgentStore` and `useView` changes,
  so the Voice submenu label flips the instant you toggle voice.

- **Quick Launcher opens from the tray** (`src/components/QuickLauncher.tsx`)
  Added window-event listeners for `sunny-ql-open` / `sunny-ql-toggle`
  so the tray (and any future menu-bar entry) can open the launcher
  without simulating a ⌘K keydown.

---

## R12 — Density + features

Rebuilt five modules that were stubs or mockups into real, AI-addressable surfaces:
Screen (live capture, OCR overlay, click-through), Contacts (iMessage transcript,
AI proxy drafts, send/call tools), Voice (streaming TTS, VAD auto-stop, barge-in,
whisper-cpp model upgrade), multi-terminal workspace (real PTYs, WebGL renderer,
seven agent tools), and Overview dashboard (every card now clickable, OpenClaw 2026
envelope parsing). Also shipped the menu-bar tray with live status and a structured
submenu. **210 Rust tests** passing.

### Phase 10 — Voice chat smoothness

Targeted rebuild of the real-time voice pipeline so `push-to-talk → AI reply`
feels like a conversation with a person, not a command line.

- **Transcription actually works** (`src-tauri/src/audio.rs`)
  The old backend only resolved `whisper` (openai-whisper) and failed
  silently for the far more common `whisper-cli` from
  `brew install whisper-cpp`. Rewritten to prefer `whisper-cli` (greedy
  decode, `-bs 1 -bo 1`, clamped thread count) with `whisper` as a
  fallback, and to write transcriptions to a known `-of` file instead
  of scraping stdout timestamps. First run fetches `ggml-tiny.en.bin`
  (~74 MB) from the official whisper.cpp mirror and caches it in
  `~/Library/Caches/sunny/whisper/`; once tiny is in place a background
  task silently upgrades to `ggml-base.en.bin` (~148 MB) so the *next*
  session uses the more accurate model with zero user action.
  `ensure_whisper_model()` runs in the Tauri `startup` hook so the
  user's first voice press never stalls on a download.

- **TTS is serial, not fire-and-forget** (`src-tauri/src/voice.rs`)
  `speak` used to `.spawn()` `say` and drop the child, which made
  `streamSpeak`'s queue fire overlapping `say` processes (cacophony,
  sometimes silence if a bad voice arg errored). Now blocks on
  `.output().await`, captures stderr, and falls back to the system
  default voice if the requested voice (e.g. `Daniel`) isn't
  downloaded on the machine.

- **Streaming TTS while the LLM streams** (`src/hooks/useVoiceChat.ts`,
  `src/lib/streamSpeak.ts`)
  The voice hook now feeds every `sunny://chat.chunk` delta into a
  per-turn `StreamSpeaker`. First audio lands after the first sentence
  (~1 s on Ollama) instead of after the full reply. `streamSpeak` was
  taught to cut on strong soft breaks (`:` / `;` / em-dash) once the
  segment is ≥ 32 chars, so long answers start speaking even earlier
  while short phrases still wait for a real sentence boundary.
  `speaker.flush()` drives the `speaking → idle` transition — the old
  words-per-minute duration estimate is gone.

- **Silence auto-stop + barge-in** (`src/hooks/useVoiceActivity.ts`, new)
  Shared VAD hook runs a single `getUserMedia` stream with
  `echoCancellation` / `noiseSuppression` / `autoGainControl` enabled,
  samples time-domain RMS, and calibrates to the room's ambient floor
  over the first 300 ms (clamped at `0.06` so the user talking *into*
  the calibration window can't poison the session). Two callbacks:
  - `onSilence` — fires after 900 ms of silence following detected
    speech while recording, auto-ending the utterance so the user
    never has to tap space twice.
  - `onSpeechStart` — fires during `speaking` (`mode: 'barge-in'`,
    1.8× threshold boost to ignore AI voice leaking past AEC). Cuts
    the AI off, reopens the mic 40 ms later. Interrupting the
    assistant feels like interrupting a person.
  Recordings shorter than 350 ms are discarded as accidental taps.

- **Conversation memory** (`src-tauri/src/ai.rs`, `src/hooks/useVoiceChat.ts`)
  `ChatRequest` gained a `history: Vec<ChatMessage>` field (serde
  default — every existing caller is backwards-compatible). The
  Ollama transport now sends a proper message list with the rolling
  last 8 user/assistant turns from the voice hook. Follow-ups like
  "what about tomorrow?" now resolve against the prior context
  instead of hallucinating a fresh thread.

- **Cancel mid-pipeline** (`src/hooks/useVoiceChat.ts`)
  Tapping space during `transcribing` or `thinking` aborts cleanly.
  A `turnIdRef` is bumped so any late chat reply still in flight is
  discarded — no stale speech after a cut-off, no polluted history.
  Same guard protects against the barge-in race where a new recording
  starts while the previous LLM call is still streaming.

**User-visible result**: press space, start talking, stop talking — first
AI audio arrives in ~1 s with conversational memory, zero self-triggered
barge-in, automatic accuracy upgrades in the background, and a tap to
cancel at any stage.

---

---

## R11 — Remaining 10 pages

Per-skill success tracking (schema v4), 5-component bundle lazy-load pass (702 KB →
646 KB gzip), tool-usage sparklines in the Memory Tools tab, inline skill editing
without losing use counts, and the optional Agent Society dispatch layer (Researcher /
Coder / Operator / Scribe / Generalist). **210 Rust tests, schema v4**.

### Phase 11 — Success tracking · bundle pass · sparklines · skill edit · society

Five cohesive improvements in one pass.

- **Per-skill success tracking** (`src-tauri/src/memory/procedural.rs`)
  Schema v4 adds `success_count INTEGER NOT NULL DEFAULT 0`. The
  `bump_use(id, success)` signature now takes a success flag — the
  System-1 router passes `true` on `done` runs and `false` on aborts /
  errors. The Memory → Procedural tab shows a colour-coded "N/M ok"
  badge (same tiers as the Tools tab: green ≥0.9, cyan ≥0.7,
  amber ≥0.5, red below).

- **Bundle-size pass** (`src/components/Dashboard.tsx`)
  Five heavy overlay components — `CommandBar`, `QuickLauncher`,
  `AgentOverlay`, `HelpOverlay`, `PlanPanel` — moved behind `React.lazy`
  + `Suspense fallback={null}`. Bundle size dropped from 702 KB →
  **646 KB** (183 KB gzip). Each overlay ships as its own chunk and
  loads only when opened.

- **Tool-usage sparklines** (`src-tauri/src/memory/tool_usage.rs` +
  `src/pages/MemoryPage/Sparkline.tsx`)
  New `tool_usage_daily_buckets(tool_name?, days?)` Rust command groups
  calls by midnight-aligned day and returns `{day_ts, count, ok_count}`
  rows. New `<Sparkline>` React component renders inline-SVG stacked
  polylines (total calls vs successes) at 120×22. Wired into the
  Tools tab: every row shows its 14-day trend at a glance. No external
  charting dependency.

- **Inline skill edit** (`src/pages/MemoryPage/ProceduralTab.tsx`)
  EDIT button on each skill row flips to an inline form with name /
  description / trigger / recipe fields. Live JSON validation on the
  recipe textarea. Diff-only save (absent fields are "keep current"
  via a new `memory_skill_update` Tauri command backed by
  `procedural::update_skill`). Auto re-embeds when trigger_text or
  description change. Lets users fix auto-synthesized skills (which
  often have clumsy names like `morning-brief-a3f7`) without losing
  `uses_count` or the embedding.

- **Agent Society** (`src/lib/society/*`)
  New optional role-based dispatch layer. Five specialists:
    - **Researcher** — web search + fetch + memory lookup
    - **Coder** — file ops + PTY + shell + claude_code_run
    - **Operator** — mouse / keyboard / screen / app open
    - **Scribe** — memory + notes + reminders + calendar + scheduler
    - **Generalist** — fallback with full tool access

  Two-stage chair dispatcher:
    1. Keyword prefilter (trigger substring match, ≥2 hit dominance)
    2. Cheap-model tiebreak on ambiguity

  When a specialist fires, `buildSystemPrompt` filters the tool
  registry to the role's allowlist AND appends the role's prompt
  fragment; the main loop's tool-call gate also enforces the
  allowlist at runtime (defence in depth). Fires an
  `introspect_caveat` insight showing the chosen role + confidence.
  **Off by default**; enable via `settings.societyEnabled = true`.
  Sub-runs (HTN decomposition) skip dispatch to avoid recursion.

**Test count**: 209 → **210 Rust tests** (+1 bump_use success counter).
**New Tauri commands**: 114 → 117 (+tool_usage_daily_buckets,
memory_skill_update, implicit memory_skill_bump_use signature change).
**Bundle size**: 702 KB → 646 KB.
**Schema**: v3 → **v4**.

---

## R10 — Baseline UX sweep on 22 pages

Tool-usage telemetry (per-tool p50/p95, 30-day sweep, critic reliability prior),
Constitution editor UI (values + prohibitions + hour-window gates, live system-prompt
preview), and the Memory Tools tab. Closed two pre-existing test races uncovered by
the new coverage. **209 Rust tests, 114 Tauri commands**.

### Phase 10 — Tool telemetry + constitution editor UI

Two high-leverage additions plus two pre-existing test bug fixes that
surfaced under the new test count.

- **Tool usage telemetry** (`src-tauri/src/memory/tool_usage.rs`, 7 tests)
  New schema migration v3 adds a `tool_usage` table. `executeTool` in
  `src/lib/tools/registry.ts` now fires a fire-and-forget
  `tool_usage_record` after every tool call (ok/err + latency + clipped
  error message). New commands:
  - `tool_usage_record(tool_name, ok, latency_ms, error_msg?)`
  - `tool_usage_stats(opts?)` → per-tool count / ok / err / p50 / p95 /
    last_at / last_ok
  - `tool_usage_recent(opts?)` → tail with optional `only_errors` flag
  Rows older than 30 days are swept by the existing retention loop.

- **Critic reliability prior** (`src/lib/critic.ts`)
  The critic prompt now includes a "RECENT TOOL RELIABILITY (last 7d)"
  block when the tool has ≥ 5 recorded calls. Low success rate (<60%)
  nudges the critic toward `review`; 60–85% shows mixed signal; ≥85%
  shows a ✓. Missing telemetry (new tools, Ollama down) silently skips.

- **Memory → Tools tab** (`src/pages/MemoryPage/ToolsTab.tsx`)
  Fifth tab in the Memory inspector. Features:
  - Window picker: 24h / 7d / 30d / all
  - Sort by: calls / success / latency / recency
  - Per-row: colour-coded success-rate badge + visual success bar,
    ok/err split, p50 + p95 latency, last-call timestamp + status
  - Recent Failures section at the bottom: latest 20 error rows with
    clipped error messages
  - Tab hotkeys renumbered: 1=Episodic 2=Semantic 3=Procedural 4=Tools 5=Insights

- **Constitution editor page** (`src/pages/ConstitutionPage.tsx`, ~420 LoC)
  Full GUI for `~/.sunny/constitution.json` — no JSON editing required.
  - Identity form (name, voice, operator)
  - Values list with add/edit/remove
  - Prohibitions list with:
    - free-text description
    - tool picker (checkboxes, multi-select, deduped across bakes + user skills)
    - hour-window inputs (supports midnight-wrap visualisation)
    - input-substring pattern tags (Enter to add, click to remove)
  - Live preview of the rendered system-prompt block
  - SAVE writes via `constitution_save` + invalidates the 60 s cache so
    the next agent run picks up the new policy without restart
  - REVERT reloads from disk
  Registered as new view `constitution` (nav entry + macOS View menu).

- **Fix pre-existing `attributed_body` test bug**
  `extract_heuristic_ignores_class_names` used `...` as separators
  between class names — but `.` is printable ASCII so the heuristic saw
  one giant run and (correctly) rejected it. Replaced with `0x01`
  separators to match real typedstream blobs.

- **Fix pre-existing db migration test race**
  `migration_imports_live_items_and_respects_tombstones` mutated
  process-wide `HOME`. Since `safety_paths::tests::*` read
  `dirs::home_dir()` concurrently, parallel execution produced spurious
  failures. Refactored `migrate_legacy_jsonl_if_present` to delegate to
  a new `migrate_legacy_jsonl_from(conn, Some(&path))` helper; the test
  passes the scratch path explicitly and no longer touches `HOME`.

**Test count**: 186 → **209 Rust tests** passing.
**New Tauri commands**: 111 → 114 (+3 tool_usage).
**New views**: 15 → 16 (+constitution).

---

## R9 — Polish + job templates

Four reliability improvements for long-term use: context-pack token budget (6 000-token
cap with progressive trimming and caveat insight), 14/28-day episodic retention sweep
(preserves `has-lesson` rows), introspection `rewrite` mode (goal clarification without
asking the user), and insight search + JSON export. Also the top-9 large-file module
refactor pass (folder split, zero logic changes) plus the initial documentation suite
(README, ARCHITECTURE, AGENT, MEMORY, SKILLS, CONSTITUTION, TOOLS, CONTRIBUTING,
TROUBLESHOOTING). **186 Rust tests**.

### Phase 9 — Maintenance tier: budget, retention, rewrite, insight search

Four orthogonal reliability improvements that make the system scale
for long-term use without growing memory unboundedly or blowing the
prompt window.

- **Context pack token budget** (`src/lib/contextPack.ts`)
  New `renderSystemPromptWithReport()` renders the pack, measures it
  with a 4-chars-per-token heuristic, and if it exceeds
  `DEFAULT_PROMPT_BUDGET_TOKENS` (6 000) progressively trims: drop
  `matched_episodic` first, halve `recent_episodic`, shorten semantic
  fact bodies to 140 chars, finally hard-trim matched_episodic +
  halve semantic. `budgetTrimmed: true` + `trimNotes` fire an
  `introspect_caveat` insight so the user sees what got dropped. The
  existing `renderSystemPrompt` wrapper is preserved for callers
  that don't need the report.

- **Episodic retention sweep** (`src-tauri/src/memory/retention.rs`, 7 tests)
  Pure-SQL daily background loop (24 h tick, first run 5 min after
  boot). Deletes `perception` rows older than 14 days, `agent_step`
  rows older than 28 days (**preserves rows tagged `has-lesson`** —
  those carry durable signal the consolidator + reflection already
  extracted). Never touches `user`, `note`, or `reflection` rows.
  Idempotent — second run is always a no-op. New Tauri commands
  `memory_retention_run(opts?)` + `memory_retention_last_sweep()`
  expose manual triggers and last-sweep telemetry. Boot wiring in
  `startup.rs`.

- **Introspection `rewrite` mode** (`src/lib/introspect.ts`)
  Fourth option beside `direct` / `clarify` / `proceed`: when the
  goal is ambiguous but semantic memory has strong context, the
  introspector rewrites the goal into a concrete version and the
  main loop plans against the rewrite. Original goal is preserved
  in a visible `plan` step; emits an `introspect_caveat` insight
  showing both forms so the user can see exactly what was inferred.
  Middle path between "ask the user" (clarify) and "guess silently"
  (proceed).

- **Insights search + JSON export** (`src/pages/MemoryPage/InsightsTab.tsx`)
  Search box (debounced 160 ms) filters the insight feed across
  title + detail + kind. New `COPY JSON` button exports the
  currently-filtered insights as pretty-printed JSON to the
  clipboard — useful for bug reports and dropping run traces into
  notes. "COPIED" confirmation auto-clears after 1.5 s.

**Test count**: 174 → **186 Rust tests** passing (+12 retention tests
plus a couple that were already on `main` since the refactor).

### Module refactor pass — top-9 largest files split into folders

Purely structural. Zero logic changes, zero API-surface changes, all tests
still pass (171 Rust tests, `tsc -b --noEmit` clean), `cargo check`
warnings identical to pre-refactor baseline (7, all pre-existing dead-code
lints in unrelated modules).

Each of the nine largest hand-written files was split into a cohesive
folder with `types.ts` / `constants.ts` / `utils.ts` / `styles.ts` /
one-file-per-component separation. Folder imports preserve the original
path via `index.tsx` (or `mod.rs` on the Rust side), so every external
consumer — `pages.ts`, `Dashboard.tsx`, `memory/pack.rs`, `startup.rs`,
`lib.rs`'s `invoke_handler!` — keeps working unchanged.

| Before                              | After                            | Children |
|-------------------------------------|----------------------------------|---------:|
| `src/pages/AutoPage.tsx` (1,098)    | `src/pages/AutoPage/`            | 9 |
| `src-tauri/src/lib.rs` (1,098)      | `lib.rs` slimmed to ~113 lines; extracted `commands.rs`, `startup.rs`, `menu.rs`, `clipboard.rs`, `app_state.rs` | 6 |
| `src/pages/VaultPage.tsx` (1,020)   | `src/pages/VaultPage/`           | 8 |
| `src/pages/MemoryPage.tsx` (1,004)  | `src/pages/MemoryPage/`          | 10 |
| `src-tauri/src/world.rs` (889)      | `src-tauri/src/world/` (model, state, updater, classifier, side_effects, persist, helpers, mod + tests) | 8 |
| `src/pages/ContactsPage.tsx` (881)  | `src/pages/ContactsPage/`        | 7 |
| `src/pages/WebPage.tsx` (846)       | `src/pages/WebPage/`             | 6 |
| `src/components/CommandBar.tsx` (836) | `src/components/CommandBar/`   | 5 |
| `src/pages/NotesPage.tsx` (756)     | `src/pages/NotesPage/`           | 6 |

Public surface preserved:

- Every React page still exports the same named component — lazy-loaded
  `import('./AutoPage')` in `src/pages/pages.ts` resolves to the folder's
  `index.tsx` via standard Node/Vite directory resolution.
- `src-tauri/src/world/` re-exports `WorldState`, `current`, `start`,
  `world_get` via `pub use`. Consumers in `memory/pack.rs` and
  `startup.rs` are untouched.
- All 130 `#[tauri::command]` registrations in `lib.rs::invoke_handler!`
  preserved (125 wrappers moved to `commands.rs`, 5 already-qualified
  ones registered directly: `clipboard::get_clipboard_history`,
  `world::world_get`, 3× `constitution::*`, `tray::tray_set_status`).

Documentation pass (earlier commit):

- New `README.md` — complete project overview, quickstart, docs index
- New `docs/ARCHITECTURE.md` — seven-layer architecture deep dive
- New `docs/AGENT.md` — `runAgent` dispatch flow, annotated
- New `docs/MEMORY.md` — 3-store schema + retrieval + consolidation
- New `docs/SKILLS.md` — recipe format, synthesis, authoring
- New `docs/CONSTITUTION.md` — identity, values, prohibitions, gating
- New `docs/TOOLS.md` — full 46-tool registry reference
- New `docs/CONTRIBUTING.md` — dev workflow, style, testing
- New `docs/TROUBLESHOOTING.md` — permissions, Ollama, recovery
- New `CHANGELOG.md` — this file

---

## Phase 8 — Deep integration: constitution, critic, HTN, OCR, model router

**What shipped**: five orthogonal layers added in one turn.

- **Model Router** (`src/lib/modelRouter.ts`, 155 LoC)
  Purpose-based LLM routing. Seven purposes (`planning`, `reflection`,
  `introspection`, `consolidation`, `critic`, `decomposition`,
  `synthesis`), each with a default route. Defaults put metacognition on
  a cheap local model (`qwen2.5:3b`), reserving the big model for
  planning. Per-purpose overrides via settings.

- **Constitution** (`src-tauri/src/constitution.rs` 480 LoC +
  `src/lib/constitution.ts` 230 LoC)
  Declarative JSON at `~/.sunny/constitution.json`. Identity + values +
  hard prohibitions. Prohibitions match on tool name, local hour
  (same-day or midnight-wrap window), and input substrings. Runtime
  gate enforces prohibitions at every tool call in both the LLM loop
  and the System-1 skill executor. +9 Rust tests.

- **Critic** (`src/lib/critic.ts`, 240 LoC)
  Cheap-model review for `dangerous: true` tools. Sits between
  constitution gate and ConfirmGate. Three verdicts: approve → pass
  through, block → abort + insight, review → fall through to
  ConfirmGate. Fail-safe: critic unavailable → treat as review.

- **HTN decomposition** (`src/lib/planner.ts` 230 LoC + wiring)
  Pre-loop cheap-model pass detects complex goals (2–5 sub-goals),
  runs each as a sub-`runAgent` sequentially, composes parent answer.
  Heuristic pre-filter skips the model call for goals without
  coordinating conjunctions. Hard caps: ≤ 5 sub-goals, no recursion
  via `isSubGoal` flag.

- **Focus-triggered screen OCR** (now `src-tauri/src/world/side_effects.rs`, +120 LoC)
  Opt-in via `screenOcrEnabled` setting. On focus change, capture
  active window, run tesseract, store up to 1.2 KB of extracted text
  as a `perception` episodic row. Rate-limited ≥ 90 s. Silent no-op
  when tesseract missing or Screen Recording permission denied.

**Test count**: 171/171 Rust tests passing.

---

## Phase 7 — Memory Inspector UI

**What shipped**: the user-facing window into cognition.

- **`src/pages/MemoryPage/`** (originally `MemoryPage.tsx`, ~800 LoC) — full rewrite
  - Four tabs: Episodic / Semantic / Procedural / Insights (hotkeys 1–4)
  - Stats header: counts per store, oldest row age, consolidator pending / floor
  - Episodic: FTS search + kind filters (ALL/USER/RUN/PERCEPT/REFLECT/NOTE), per-row DETAILS + DELETE
  - Semantic: subject grouping, confidence badges (green ≥ 0.9, cyan ≥ 0.6, amber otherwise), source labels
  - Procedural: uses_count + last_used + recipe preview
  - Insights: live feed from `useInsights` with kind filters

- **Rationale**: everything built in prior phases (consolidator,
  reflection, skill synthesis, world model, insights) was invisible.
  This page made the system legible and editable for the first time.

---

## Phase 6 — Web search · introspection · synthesis · insights

**What shipped**: four cohesive upgrades hitting L1, L4, L6, L7 at once.

- **Web search tool** (`src-tauri/src/web.rs` +230 LoC Rust, 60 LoC TS)
  `web::search(query, limit)` via DuckDuckGo HTML endpoint (no API
  key). Regex-extracts `{title, url, snippet}` tuples. +7 parser
  tests covering percent-decoding, redirect unwrapping, and layout
  drift. Registered as the `web_search` tool.

- **Pre-run introspection** (`src/lib/introspect.ts`, 290 LoC)
  Cheap-model pass before the LLM loop. Three outcomes:
  - `direct`   — answer immediately from memory
  - `clarify`  — ask one focused question
  - `proceed`  — attach caveats to the main system prompt

- **Skill synthesis** (`src/lib/skillSynthesis.ts`, 340 LoC)
  20-min background loop scanning recent successful runs, clustering
  by identical tool_sequence, auto-compiling recipes into procedural
  when ≥ 5 matching runs exist. Conservative threshold prevents
  false-pattern capture.

- **Insight stream** (`src/store/insights.ts` 120 LoC + emission sites)
  Persistent audit feed across the session. Seven kinds:
  `skill_fired`, `skill_synthesized`, `introspect_direct`,
  `introspect_clarify`, `introspect_caveat`, `memory_lesson`,
  `constitution_block`. High-signal kinds fire transient toasts via
  the existing `useToastStore`.

- **Run archive extension**: agent loop now persists
  `meta.tool_sequence` on every successful System-2 run — the raw
  material the synthesizer mines.

---

## Phase 5 — Reflection

**What shipped**: the self-improvement feedback loop closes.

- **`src/lib/reflect.ts`** (398 LoC)
  Post-run metacognitive pass on every terminal run (`done` /
  `error` / `max_steps`, not `aborted`). Cheap-model JSON extraction
  → `{success, outcome, lesson, wasted_tool_indices, followup}`.
  Writes episodic audit row always; promotes durable lessons
  directly into semantic memory (bypassing the 15-min consolidator).

- **Subject derivation**: heuristic classifier maps lesson text to
  ontology keys ("Sunny prefers X" → `user.preference`, "When Y…"
  → `pattern`, etc.).

- **Wired into all three terminal branches** of `runAgent`. Cost:
  one cheap-model call per run; fire-and-forget so user-visible
  latency is unaffected.

**Impact**: lessons from successful runs become immediately
retrievable on the next goal-matched query.

---

## Phase 2 — World Model + continuous perception

**What shipped**: ambient situational awareness.

- **`src-tauri/src/world/`** (originally `world.rs`, 817 LoC, 10 tests)
  `WorldState` struct + 15-s tokio updater loop. Fast samplers
  (focus, metrics, battery) every tick; slow samplers (calendar,
  mail) every 4th tick. Activity classifier: 10-variant enum
  (Coding/Writing/Meeting/Browsing/Communicating/Media/Terminal/
  Designing/Idle/Unknown) with bundle-id + title + hour-dwell rules.

- **Focus-change detection**: when `frontmost bundle_id` differs from
  last observation, emit `sunny://world.focus`, write rate-limited
  episodic `perception` row, invalidate inflight samplers.

- **Persistence**: debounced atomic write to `~/.sunny/world.json`
  (0600) on focus change + every 2 min. First-boot restore primes
  the UI with last-known state.

- **Folded into every context pack** via `memory::pack::build_pack`.

**Impact**: the LLM's system prompt now contains "right now: coding in
Cursor on agentLoop.ts, meeting in 12 min, 4 unread mails" on every
turn without the agent having to call a tool.

---

## Phase 1c — System-1 skill executor

**What shipped**: deterministic recipes, LLM-free execution for recurring tasks.

- **Schema migration v2**: `recipe_json` column added to
  `procedural` table, idempotent `ALTER TABLE` with `PRAGMA
  table_info` check.

- **`src/lib/skillExecutor.ts`** (463 LoC)
  `runSkill({goal, skill, signal, onStep, confirmDangerous})` that
  interprets a recipe's `steps` (`tool` + `answer` kinds), applies
  template substitution (`{{$goal}}`, `{{$now}}`, `{{$today_*}}`,
  `{{savedName}}` with dotted paths), emits the same `AgentStep`
  shape as the LLM loop.

- **System-1 router in `agentLoop.ts`**:
  `matched_skills[0].score >= 0.85` + recipe present → runSkill,
  bump_use, return. Errors fall through to S2 so a broken recipe is
  a slow path, never a dead end.

- **Commands**: `memory_skill_get(id)`, `memory_skill_bump_use(id)`,
  `memory_skill_add(..., recipe?)`.

**Impact**: repeated goals resolve in ~400 ms instead of 3–30 s per
turn. See [`docs/SKILLS.md`](./docs/SKILLS.md).

---

## Phase 1b — Embeddings + hybrid retrieval + consolidator

**What shipped**: the memory gets smarter than keyword search.

- **`memory/embed.rs`** (426 LoC, 6 tests)
  Ollama `/api/embed` + legacy `/api/embeddings` fallback. f32
  little-endian BLOB codec. Cosine similarity (handles mismatched
  lengths / empty / zero-magnitude without NaN). `rerank_by_cosine`
  + auto-embed on insert + `start_backfill_loop` (8 rows / 30 s).

- **Hybrid retrieval in `pack.rs`**:
  FTS prefilter with 4× widen → embed goal via Ollama → cosine rerank
  to top-K. Falls back to FTS-only when Ollama unreachable. Marks
  `used_embeddings: true/false` on the returned `MemoryPack`.

- **Consolidator** — Rust ingredient side (`consolidator.rs`, 172 LoC):
  watermark-based `pending(limit)` + `mark_done(ts)` + `status()`.
  TS drives the loop in `consolidator.ts` (326 LoC) — 15-min ticker
  that extracts facts via cheap model → writes semantic via
  idempotent upsert.

**Impact**: `KNOWN FACTS` block in every system prompt becomes
meaningful after a few days of use. Recurring questions with
already-known answers find the answers.

---

## Phase 1a — Memory substrate

**What shipped**: the foundation everything else builds on.

- **Added `rusqlite` (bundled)** to `Cargo.toml`. No system libsqlite3
  dependency; notarized `.app` bundles work out of the box.

- **`src-tauri/src/memory/` module** (~1400 LoC)
  - `db.rs` — connection singleton (`OnceLock<Mutex<Connection>>`),
    WAL mode, schema versioning, one-shot migration from the legacy
    `~/.sunny/memory.jsonl` (respects tombstones, idempotent via meta
    flag)
  - `episodic.rs` — chronological events, 6 kinds, FTS5 virtual
    table with triggers, legacy-shape commands preserved
  - `semantic.rs` — curated facts, idempotent upsert on
    `(subject, text)`, confidence + source fields
  - `procedural.rs` — named skills with uses_count, unique by name
  - `pack.rs` — `MemoryPack` assembler (semantic top-K + recent
    episodic + matched episodic + top skills + stats)

- **Tauri commands** (12 new):
  `memory_episodic_add/list/search`, `memory_fact_*`,
  `memory_skill_*`, `memory_pack(opts?)`, `memory_stats()`. Legacy
  `memory_add/list/search/delete` routed to episodic `note` kind for
  backward compatibility.

- **`src/lib/contextPack.ts` rewrite**: replaces placeholder facts
  with real `MemoryPack`; renders into system prompt.

- **agent loop integration**: goal record on run start, answer
  record on done, fireReflection hook.

**Impact**: SUNNY remembers across sessions. Everything after this
phase assumes this foundation.

---

## Pre-AGI work (initial ship)

Before the cognitive architecture began, the repo shipped with:

- Tauri 2 + React 19 + Rust foundation
- 33 Rust domain modules (apps, calendar, mail, messaging, vault,
  metrics, ax, automation, vision, ocr, pty, …)
- React HUD with Overview + 14 module pages
- Voice pipeline (wake-word, push-to-talk, macOS `say` TTS)
- Flat agent loop with prompt-engineered JSON protocol
- Flat `~/.sunny/memory.jsonl` memory store (legacy)
- 45+ agent tools in the registry
- Tray icon + menu + overlay title bar

See `git log` for commit-level detail.

---

## Design principles (stable across phases)

These show up repeatedly in the codebase. Any new phase should
preserve them.

1. **Fail open, degrade gracefully.** Every subsystem with an
   upstream (Ollama, tesseract, osascript permissions) checks and
   returns sensible defaults when the upstream is absent.

2. **Local-first.** Memory DB, embeddings, cheap-model routes all
   default to local. Only the planning route can be remote.

3. **User is the final authority.** ConfirmGate, constitution, every
   visible toggle respected even when the agent disagrees.

4. **Background loops are optional accelerants.** The app still
   works without them — they make it better, never essential.

5. **Every non-trivial decision is legible.** Insight feed surfaces
   every routing choice to the user.

6. **Idempotent everywhere.** All writes are safe to repeat.

7. **Typed contracts across the IPC boundary.** Compile-time
   agreement between Rust and TS wire shapes.

## 2026-04-19 — Voice pipeline sweep (10-agent)

Coordinated pass across the mic → whisper → Kokoro loop to kill a clutch
of long-standing regressions and add the first real E2E harness. All work
landed in a single afternoon via ten parallel agents, one file per agent.

- **Mic pre-roll (Agent 5).** Fixed the head-eating bug where the first
  120–200ms of every utterance was dropped on cold capture. The ring
  buffer now pre-fills before VAD opens the gate, so the attack of words
  like "hey" and "when" survives into whisper.
- **VAD thresholds + watchdog (Agent 6).** Lowered the energy floor so
  quieter speakers trigger reliably, and added a watchdog that force-
  closes a stuck segment after max-utterance. No more 30s "listening…"
  hangs when the end-of-speech detector misses.
- **Error banner + mic heartbeat (Agent 7).** Modernized the visible
  error strings (less jargon, actionable), and added a mic-heartbeat
  indicator in the HUD so the user can see capture is alive even during
  silence.
- **Whisper hallucination filter + `--suppress-nst` (Agent 8).** The
  silence-→-"you"/"thank you"/"thanks for watching" class of false
  transcripts is now filtered post-whisper, and `--suppress-nst` is
  passed to whisper-cli to cut non-speech tokens at the decoder.
- **Kokoro warm-start + text preprocessing (Agent 9).** Pre-warms the
  Kokoro TTS worker at session start to eliminate first-utterance
  latency, and normalizes numbers/abbrevs/markdown before synthesis so
  output sounds less robotic.
- **voice-smoke.sh E2E harness (Agent 10).** New `scripts/voice-smoke.sh`
  runs a known utterance through the exact whisper-cli invocation Sunny
  uses and asserts the transcript. Also probes the silence case so the
  hallucination filter can be kept in sync with what whisper emits.
- **Default voice → George.** Sunny's default TTS voice is now George
  (was Daniel). George reads closer to the intended British register
  without the occasional American vowel slip Daniel had on long clauses.
