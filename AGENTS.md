# AGENTS.md

Instructions for coding agents (Claude Code, Cursor, Codex, Aider, Copilot)
working on the SUNNY codebase at `/Users/sunny/Sunny Ai`.

This file follows the [agents.md](https://agents.md) open standard.

## Project overview

SUNNY is a native macOS HUD assistant — a Tauri 2 desktop app with a Rust
backend and a React 19 frontend. It runs a tool-using ReAct agent loop
over local Ollama models (default: `qwen3:30b-a3b-thinking-2507-q4_K_M`),
with a persistent sub-agent system, memory subsystem (SQLite + FTS5),
voice pipeline (Whisper STT, Kokoro TTS daemon), and a HUD-style UI
around a canvas orb.

- **Owner:** Sunny (Kingly Studio)
- **Bundle id:** `ai.kinglystudio.sunny`
- **Signing identity:** `Apple Development: 8844422@gmail.com (4J59FQTPUV)`
- **Targets:** macOS 11.0+ (Apple Silicon primary; M3 Ultra, 512 GB)

## Directory layout

```
src/                   React 19 + TypeScript frontend (Vite)
  components/          Panels, Orb, ChatPanel, AgentsPanel
  hooks/               useVoiceChat, useAgentStepBridge, useSubAgentsBridge
  store/               Zustand stores (view, agent, subAgentsLive, terminals)
  lib/
    tools/             Frontend tool registry (Tool schemas + TS shims)
    tools.*.ts         Per-family tool registration files
    streamSpeak.ts     Sentence-boundary TTS queue
    agentLoop.ts       TS-side agent loop (separate from Rust agent_loop)
  pages/               Full-page views routed through ModuleView
src-tauri/
  src/
    agent_loop.rs      Rust ReAct loop (primary). Reads qwen3 via Ollama.
    ai.rs              Provider routing (ollama → agent_loop)
    audio.rs           whisper-cli invocation + ensure_whisper_model
    audio_capture.rs   cpal native mic capture with VAD level emission
    voice.rs           Kokoro daemon (persistent stdin) + afplay
    memory/            SQLite FTS5 episodic/semantic/procedural + pack
    tools_weather.rs   weather + time (open-meteo)
    tools_web.rs       web_fetch + tool_web_search (DDG/Brave)
    tools_browser.rs   Safari via osascript
    tools_macos.rs     Mail/Cal/Notes/Reminders/Messages/Shortcuts via osascript
    tools_compute.rs   calc, unit convert, timezones, regex, json, hash, uuid
    http.rs            Shared reqwest::Client (OnceLock)
    secrets.rs         Keychain-backed ANTHROPIC_API_KEY / ZAI_API_KEY
    scheduler.rs       JobKind: Once/Interval + JobAction: Shell/Notify/Speak
    startup.rs         Tauri .setup() hook
    lib.rs             Module declarations + tauri::generate_handler!
scripts/
  patch-info-plist.sh  Post-bundle: inject NSUsageDescriptions + re-sign
  install-anthropic-key.sh
  install-zai-key.sh
docs/                  README.md (index), ONBOARDING.md, PAGES.md (HUD modules),
                       ARCHITECTURE.md, AGENT.md, MEMORY.md, SKILLS.md, AUTO.md, SCAN.md,
                       SECURITY.md, BROWSER.md, CONSTITUTION.md, TOOLS.md, BINDINGS.md,
                       SHORTCUTS.md, PAGE_COVERAGE.md, TROUBLESHOOTING.md, CONTRIBUTING.md,
                       SETUP-API-KEYS.md
```

## Build commands

```bash
# Dev (frontend only, Tauri dev won't use prod code signing)
pnpm dev

# Type-check everything
pnpm tsc -b --noEmit

# Rust check (in src-tauri/)
cd src-tauri && cargo check

# Full release build + sign + re-sign after Info.plist patch
pnpm app:build

# Run the freshly built app
open src-tauri/target/release/bundle/macos/Sunny.app
```

`pnpm app:build` runs `tauri build --bundles app`, then
`scripts/patch-info-plist.sh` injects the four `NS*UsageDescription`
keys AND **re-signs** the bundle (otherwise launchd rejects it with
"plist or signature have been modified"). Do not skip the re-sign step.

## Coding conventions

### Rust

- `#[tauri::command]` fns return `Result<T, String>` where T is serde.
- New tool modules follow `src-tauri/src/tools_<name>.rs` pattern with
  a module-level doc comment, async fns, and a matching TS registry
  file at `src/lib/tools.<name>.ts` that calls `registerTool({ schema,
  run })`.
- Shared HTTP lives in `crate::http::client()` — do not build fresh
  `reqwest::Client` instances on hot paths.
- Errors: Clear short strings suitable for the user's ears. Never
  `.unwrap()` on user-facing paths.
- New `#[tauri::command]` fns must be registered in `lib.rs`'s
  `tauri::generate_handler!` list.

### TypeScript

- Strict mode. No `any` unless unavoidable. Prefer `unknown` + narrow.
- Functional components, hooks for effects, Zustand for cross-cutting state.
- Tool registrations are side-effect imports (`import './lib/tools.foo'`)
  added to `src/App.tsx`.
- No `console.log` left in committed code; `log::info!` / `log::debug!`
  on the Rust side and `console.info` with a `[scope]` prefix on the
  TS side.

### Immutability

- No mutation. Always spread / rebuild. See existing
  `src/store/subAgentsLive.ts` for the canonical pattern.

### File size

- 400 lines is the typical target, 800 is the hard max. Split large
  components into focused subfiles.

### No speculative backwards-compat

- When renaming a symbol, delete the old name. Don't add re-exports.
- Don't ship feature flags for behaviour the user can already toggle in
  settings.

## Tool-use architecture

Voice turns route: `useVoiceChat` → `invoke('chat', { provider: 'ollama' })`
→ `ai::stream_chat` → `agent_loop::agent_run` (Rust ReAct loop). The
agent loop:

1. Picks backend via `pick_backend` (Anthropic if `ANTHROPIC_API_KEY` in
   Keychain, else Ollama).
2. Builds system prompt = `SAFETY_AMENDMENT` + `TOOL_USE_DIRECTIVE` +
   `compose_system_prompt(…)` + memory-digest + query-hint +
   name-seed-hint. (See `agent_loop.rs::compose_system_prompt`.)
3. Runs up to `MAX_ITERATIONS = 8` turns, dispatching tool_calls via
   `dispatch_tool`. Per-tool timeout `TOOL_TIMEOUT_SECS = 30`.
4. Emits `sunny://agent.step` and `sunny://chat.chunk` / `chat.done`.
5. `spawn_subagent` starts nested `agent_run_inner` on its own
   `session_id = "sub-<uuid>"`, depth-capped at 3.

The **tool catalog** lives in `AGENT_TOOLS: &[ToolSpec]` in
`agent_loop.rs` (~40 entries). When you add a Tauri command that you
want the model to be able to call, you add BOTH:

1. A `ToolSpec` entry with strong description.
2. A match arm in `dispatch_tool`.

## Memory subsystem

- SQLite at `~/.sunny/memory/memory.sqlite`, FTS5 on all text columns.
- Three stores: `episodic` (events), `semantic` (facts), `procedural`
  (skills). Embeddings are live: `spawn_embed_for` fires on every write
  (see `memory/episodic.rs`, `semantic.rs`, `procedural.rs`), and
  `start_backfill_loop` runs unconditionally from `startup.rs` to
  backfill older rows. Recall is hybrid BM25 + cosine via `hybrid.rs`;
  falls back to FTS-only when `nomic-embed-text` isn't available.
- `build_memory_digest` injects into every turn's system prompt
  (500 ms timeout via `spawn_blocking`).
- `memory_remember` / `memory_recall` are LLM-callable tools.

## Known gotchas

- **Settings precedence:** `~/.sunny/settings.json` takes priority over
  the in-app view.ts defaults AND overrides the runtime model picker
  if `model` is set. If the runtime picker isn't choosing the model
  you expect, check that field first.
- **Thinking-mode Ollama models** (e.g. qwen3:30b-a3b-thinking-2507)
  emit prose in `message.thinking` not `message.content`.
  `ollama_turn` already falls back — do not re-introduce the content-only read.
- **Kokoro `-ngl` flag does not exist** on the homebrew whisper-cpp
  build. Metal is default-on. Do not re-add `-ngl 99` to the
  whisper-cli invocation in `audio.rs`.
- **WKWebView getUserMedia** races the native `cpal` mic capture. The
  legacy `useVoiceActivity.ts` WebAudio path has been replaced with a
  `sunny://voice.level` event listener — do not revert.
- **Rebuild invalidates TCC grants** only for the *ad-hoc* signature
  path. Because we pin `signingIdentity` in `tauri.conf.json`, grants
  now persist across rebuilds. `scripts/patch-info-plist.sh` re-signs
  with the same cert after editing Info.plist.

## Testing instructions

No automated test suite yet (see `docs/CONTRIBUTING.md` for plan).
For voice changes, the manual smoke sequence is:

1. Quit any running Sunny.
2. `pnpm app:build`.
3. `open src-tauri/target/release/bundle/macos/Sunny.app`.
4. Hold Space, say "Who's the president of the USA right now?".
5. Expect: `[tool-use]` log line showing `web_search` call, not a
   training-data answer.

For memory, follow the 3-turn sequence:
1. "My name is Sunny" → expect `memory_remember` call.
2. "What's my name?" (new session or after pack refresh) → expect
   `memory_recall` call and answer "Sunny" from the recalled fact.

For agent dispatch, any research-shaped query should spawn at least one
sub-agent and light up `AgentsPanel` (replaces the old CalendarPanel in
the Overview grid).

## PR / commit guidelines

- Commit format: `<type>: <imperative subject>` where type ∈
  `feat | fix | refactor | docs | test | perf | chore | ci`.
- Body: focus on WHY, not WHAT (the diff is the what).
- Attribution: Claude Code auto-attribution is disabled globally; if
  you want an author line, write it explicitly.

## Security considerations

- Never write API keys to source files. Use
  `scripts/install-anthropic-key.sh <key>` / `install-zai-key.sh <key>`
  which store in macOS Keychain.
- `py_run` is NOT sandboxed. It is in the tool catalog but gated
  behind ConfirmGate. Do not add it to any sub-agent role that
  auto-approves.
- `web_fetch` has SSRF guards in `tools_web.rs` — rejects loopback,
  private, link-local, multicast, metadata endpoints, and re-validates
  after every redirect. Do not remove.
- `browser_open` is scheme-allowlisted to http/https only (no file://,
  javascript:, data:). Do not re-open the allowlist.
- The SECURITY module ([`src-tauri/src/security/`](src-tauri/src/security/),
  [`src/pages/SecurityPage/`](src/pages/SecurityPage/)) is the live
  runtime watchdog — distinct from the on-demand SCAN module. Every
  tool call, HTTP request, TCC flip, LaunchAgent / login-item change,
  and unsigned-binary launch lands on the `SecurityBus` and in
  `~/.sunny/security/events.jsonl`. See [`docs/SECURITY.md`](docs/SECURITY.md)
  for the full threat model + Phase 2/3 hardening roadmap (Rust-side
  constitution enforcement, positive egress allowlist, pre-send prompt
  redaction, hash-chained audit log).
- When adding a new egress path, wrap the `RequestBuilder` in
  `crate::http::send(req)` instead of calling `.send().await` directly
  — the wrapper emits `SecurityEvent::NetRequest`, honours the
  panic-mode kill-switch, runs the canary tripwire, consults the
  Phase-3 egress allowlist, and feeds the DNS-tunnelling /
  screen-exfil / byte-burst heuristics.
- When adding a new agent entry point, wrap the async body in
  `crate::http::with_initiator(label, fut)` so all nested egress
  carries a meaningful initiator tag on the Security Network tab
  (and the enforcement policy can distinguish agent vs non-agent
  traffic).
- Before adding a new tool to the dispatcher catalog, also add it to
  the role allowlists in
  [`src-tauri/src/agent_loop/scope.rs`](src-tauri/src/agent_loop/scope.rs)
  if you want sub-agents to be able to call it. Otherwise only the
  main agent will see it when policy.subagent_role_scoping is on
  (the default).
- When adding a new sensitive ingress path (reads attacker-controlled
  text into the LLM context), route it through
  `crate::security::ingress::inspect(source, text)` so prompt
  injection + invisible-Unicode + typoglycemia patterns surface in
  the audit log.
- If you add a new host to the scanner / world-model / etc. egress
  set, append it to the default allowlist in
  [`src-tauri/src/security/enforcement.rs`](src-tauri/src/security/enforcement.rs)
  `default_allowed_hosts()`. Otherwise users running in Block mode
  will hit a puzzling connection refused.

## References

- Standard: <https://agents.md>
- Canonical: <https://github.com/openai/codex/blob/main/AGENTS.md>
