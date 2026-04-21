# AGI Readiness

A candid read on how close SUNNY is to Sunny's stated goal —
"as close to AGI as possible" / "able to do anything the user asks"
— and what it would actually take to close the gap.

No marketing, no wishful framing. This is the architect's pass.

---

## Current capabilities — honest inventory

SUNNY today is a single-user voice-driven personal OS layer with
**~226 Tauri IPC commands**, **~154 agent-exposed tools** (via
`inventory::submit!` in `agent_loop/tools/**`), and **37 first-class
HUD pages** (`docs/TOOLS.md`, `src-tauri/src/lib.rs`, `src/pages/`).

- **Action surface:** `open_app`, `run_shell`, full `file_*`/`fs_*`
  with safety-path allowlists (`safety_paths.rs`); AppleScript for
  Mail/Notes/Reminders/Calendar; real mouse/keyboard (`automation.rs`),
  AX tree (`ax.rs`), OCR (`ocr.rs`), screen capture; iMessage + SMS
  with fuzzy contact resolution and per-chat AI proxy
  (`src/lib/proxyEngine.ts`); hardened multi-profile browser with
  Tor/Mullvad + kill switch + audit (`docs/BROWSER.md`); headless and
  user-visible terminals (`pty_agent_*`, `terminal_*`); `claude_code_run`
  driving the real Claude CLI under a PTY.
- **Cognition:** three-store memory (episodic / semantic / procedural)
  with FTS5, 768-dim embeddings, idempotent upsert, daily retention
  (`memory/`, `docs/MEMORY.md`). Procedural retrieval now ranks by
  Laplace-smoothed success rate (`memory::procedural::SKILL_RANK_ORDER_BY`)
  so proven skills surface first in the context pack. ReAct loop with
  constitution + critic + ConfirmGate (`agent_loop/core.rs`, 1,998 lines).
  HTN decomposition, System-1 recipe executor, frontend Society role
  dispatch over six roles — chair / researcher / coder / operator /
  scribe / generalist (`src/lib/society/roles.ts`,
  `src/lib/society/dispatcher.ts`). Sub-agent delegation with depth cap
  `MAX_SUBAGENT_DEPTH = 3` via `spawn_subagent`
  (`agent_loop/tools/composite/spawn_subagent.rs`); join and
  inter-agent message tools under `tools/agents/` (agent_broadcast,
  agent_message, agent_list_siblings, agent_wait). Council multi-LLM
  vote with researcher + critic + skeptic roles (`council.rs`, 978
  lines) — fires only on opt-in paths, not wired into the main ReAct
  loop. Post-run reflection into semantic memory (`reflect.ts`).
  Speculative decoding gated by `SUNNY_SPECULATIVE` env var (`1` =
  voice-only, `chat` = all sessions; both limited to iteration 1) via
  Ollama drafter+target (`providers/ollama.rs`). OFF by default.
- **Autonomy:** persistent daemons with interval / once / on-event
  cadence and twelve starter templates (`daemons.rs`, `docs/AUTO.md`);
  classic scheduler; continuous world model writing perception rows.
- **Voice:** whisper-cli STT → ReAct → Kokoro `bm_george` TTS, 900ms
  silence end-of-turn, 220ms barge-in (`useVoiceChat.ts`, `voice.rs`).

**Verification (2026-04-20 pass):** `cargo check --lib` exit 0, 13
warnings. `pnpm build` (tsc -b + vite) exit 0 in 362 ms. `cargo test
--lib memory::` 142 passed / 0 failed / 1 ignored. Earlier
multi-target self-test results (650 / 3) are now stale — the
three test failures (`dialogue::*`, `voice::interrupt_*`) and the
TSC prop-drift errors should be re-verified against current code
before citing as known-broken.

---

## What's AGI-grade

Five features that meaningfully approach open-ended autonomy:

1. **Persistent daemons with the full tool loop.** A plain-English goal
   runs forever on cadence — the daemon re-reads context, picks tools,
   writes results back to memory (`daemonRuntime.ts`). Closest thing
   to set-and-forget autonomy in a local agent. Voice-reachable via the
   `schedule_once` and `schedule_recurring` tools (`src/lib/tools/builtins/daemon.ts`)
   which parse natural-language cadence ("every morning at 7", "in 15 minutes")
   and create daemons through the `daemons_add` IPC. Phase 5 added hard
   caps — `MAX_ENABLED_DAEMONS = 32`, `MIN_INTERVAL_SECS = 60` — so an
   autonomous loop can't install a fork-bomb's worth of daemons or
   schedule itself at sub-minute cadence. A crash during fan-out is
   caught by the boot-guard marker, which quarantines all daemons on
   the next launch; the user re-enables from AUTO deliberately.
2. **Three-store memory with reflection writeback.** Idempotent upsert
   on semantic facts, embedding backfill, reflection that promotes
   lessons directly into semantic memory. Consolidator ties it together.
3. **Skill synthesis → recipe executor.** Successful tool sequences
   become procedural recipes the System-1 executor replays
   deterministically, bypassing the LLM. Self-improvement that
   lowers cost over time (`skillSynthesis.ts`).
4. **Multi-agent delegation with safety ledger.** `spawn_subagent`
   (`agent_loop/tools/composite/spawn_subagent.rs`) with a depth cap
   of `MAX_SUBAGENT_DEPTH = 3` in `agent_loop/core.rs` AND a breadth
   cap of `MAX_LIVE_SIBLINGS = 4` per parent in `agent_loop/subagents.rs`
   (Phase 5) — the two caps together bound worst-case concurrent agents
   at 4³ = 64, comfortably inside the global spawn budget. Plus
   cancel-cascade and inter-agent tools (`agent_broadcast`,
   `agent_message`, `agent_wait`). Parallel fan-out is explicit —
   repeated `spawn_subagent` calls followed by `agent_wait`. Good for
   "audit deps across 10 repos" (batched in groups of 4).
5. **Constitution + critic + ConfirmGate.** Declarative user-editable
   policy enforced prompt-side AND runtime-side with LLM critic and
   human-in-the-loop modal. Production-grade, not theatre.

---

## What's not

Features that read grander than they actually are:

- **Council vote.** 807 lines of Rust, but it currently only fires on
  opt-in paths — most turns never see it. Claims of "multi-model
  consensus" overstate real routing.
- **Society roles.** The specialists work, but the tool allowlists
  are hand-curated; there is no learned role selection — the chair is
  a keyword count with a cheap-model tiebreak.
- **Speculative decoding.** Gated behind `SUNNY_SPECULATIVE` env var
  (OFF by default) and still only fires on iteration 1 of a turn
  (`agent_loop/core.rs` — `iteration == 1` guard around
  `ollama_turn_speculative`). `SUNNY_SPECULATIVE=chat` extends the
  drafter to non-voice sessions too, but there's no cross-iteration
  speculation and nothing like ICL-style draft-whole-loop.
- **Reflection → behavior (partial).** Reflection writes lessons to
  semantic memory, and the procedural store now ranks skills by a
  Laplace-smoothed success rate (`memory::procedural::list_skills`,
  `SKILL_RANK_ORDER_BY`) so low-success skills demote on retrieval.
  Still missing: prompt-selection priors tuned from reflection, and
  hard skill decay / retirement on persistent failure.
- **Vision grounding on arbitrary GUIs.** HUD page driving has
  shipped (`navigate_to_page`, `page_action`, plus 6 `page_state_*`
  tools under `agent_loop/tools/hud/`), so the agent can flip between
  SUNNY's own pages. The gap now is third-party apps: there's no UI
  element graph for arbitrary macOS windows, and `click_text_on_screen`
  remains a fragile text match.
- **Vision grounding.** OCR + AX exist, but there's no UI element
  graph; `click_text_on_screen` is a fragile text match.
- **Planning horizon.** Plan-execute exists (1,001 lines,
  `plan_execute.rs`) but `MAX_ITERATIONS` is 8 with a 120s wall-clock
  ceiling. Hours-long tasks still require daemon scaffolding.

---

## Competitive positioning

| Dimension | SUNNY | AutoGPT | OpenDevin | crewAI | Computer Use |
|---|---|---|---|---|---|
| Local-first | Yes | Partial | Partial | No | No |
| Voice-native | **Yes** | No | No | No | No |
| Persistent memory | 3 stores + FTS + embed | Pickle | Docker vol | Short-term | None |
| OS control | AppleScript+AX+mouse | Shell | Sandbox | None | Screenshot+click |
| Daemons | **Native** | No | No | No | No |
| Safety gate | Constitution+critic+modal | Minimal | Sandbox | Minimal | Server-side |

**Wins:** voice-first, local-first, identity/memory across sessions,
real macOS integration, daemons, user-editable constitution.
**Loses:** headless cloud deployment, general-purpose repo coding
(OpenDevin), enterprise team workflows (crewAI), vision-grounded
automation on arbitrary GUIs (Computer Use).

---

## Top 3 blockers to genuine AGI-range autonomy

1. **Closed learning loop (partial).** Success-rate-weighted skill
   retrieval has shipped — `list_skills` ranks by the Laplace-smoothed
   rate `(success_count + 1) / (uses_count + 2)` so reliable skills
   surface first in the memory pack. Still missing: feeding reflection
   lessons into prompt-selection priors, and periodic consolidation that
   actively retires skills below a success-rate floor. Until both land,
   the learning loop only closes halfway — retrieval improves but
   prompts and skill composition don't yet evolve from experience.
2. **Long-horizon planning.** 8-iter ReAct with 120s wall-clock
   can't run multi-hour tasks alone. Daemons paper over it but don't
   plan *across* invocations. Fix: durable plan objects with
   checkpoint/resume so "finish the Virgin research packet" can span
   a day of tool calls.
3. **UI grounding for arbitrary apps.** HUD self-navigation is
   shipped (`navigate_to_page` + `page_action`); the outstanding gap
   is automating *third-party* macOS apps. `click_text_on_screen` is
   still a fragile text match. Fix: AX-tree element graph keyed by
   window + role + identifier, and screenshot-diff confirmation after
   each click.

---

## Closing verdict

For a single-user, voice-driven, local-first personal OS on macOS
today — **yes, this is the best local agent Sunny could be running.**
Nothing else ships: three-store persistent memory, a real
constitution gate, daemons, voice-native turn-taking, multi-agent
delegation, a hardened multi-profile browser, and real
AppleScript-grade OS control in one app.

It is **not AGI**, and nothing in the tree pretends otherwise. It is
a capable, honest, auditable personal-agent substrate with a clear
path to the next tier: close the learning loop, teach it to plan
across invocations, and give it real UI grounding. Those are
engineering problems, not research ones.

### Footnote — Phase 5 safety floor (2026-04)

Two early attempts at pushing SUNNY closer to set-and-forget autonomy
exhausted `kern.maxprocperuid` on the user's Mac because the codebase
had no global process-concurrency limit. Phase 5 installed a five-layer
budget (`process_budget.rs`, `boot_guard.rs`, per-surface caps, zombie
reap, crash quarantine) that makes uid-wide fork exhaustion impossible
by construction. Details in [`SECURITY.md#process-budget-phase-5`](../docs/SECURITY.md#process-budget-phase-5).
Reading for authors of future autonomy features: any change that raises
spawn pressure must acquire a `SpawnGuard` at the call site or justify
why the `RLIMIT_NPROC` backstop alone is sufficient.
