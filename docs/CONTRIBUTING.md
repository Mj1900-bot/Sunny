# Contributing

Workflow, style, and testing for hacking on SUNNY. New to the repo? Read
[`ONBOARDING.md`](./ONBOARDING.md) first. The full documentation index is
[`docs/README.md`](./README.md) (architecture, security, HUD pages, tools).

## Dev setup

```bash
# Clone + install
git clone <your-fork>
cd sunny
pnpm install

# Optional smart-parts dependencies (strongly recommended)
brew install ffmpeg whisper-cpp tesseract
#   ffmpeg        — mic capture (or `sox`)
#   whisper-cpp   — local speech-to-text (`whisper-cli`); model fetched lazily
# Ollama: https://ollama.com
ollama pull nomic-embed-text   # embeddings (~275 MB)
ollama pull qwen2.5:3b         # cheap metacognition model (~2 GB)
# Optional big model for planning
ollama pull qwen2.5:14b        # or llama3.2:70b, etc.

# First-time build compiles ~600 Rust dependencies — grab coffee.
pnpm tauri dev
```

After the first run, HMR applies to the React side without rebuilding
the Rust backend. A full reload (`Cmd+R` in the app window) is rarely
needed.

## Developer setup

A fresh clone needs a bit more than `pnpm install` to feel like the real
app. The [Prerequisites](../README.md#prerequisites) section of the README
is the canonical list; this section covers the day-to-day ergonomics of
working against that setup.

### Where state lives

SUNNY spreads its working state across a handful of directories. If
anything feels stale or wedged, `rm -rf` any of these (they will be
recreated on next launch, minus the obvious data loss):

- `~/.sunny/` — memory DB, world state, constitution, settings, skills.
- `~/.openclaw/` — OpenClaw gateway state (if you installed it).
- `~/.cache/kokoros/` — Kokoro ONNX weights + voice pack.
- `~/.local/bin/koko` — the Kokoro CLI itself.
- `~/Library/Caches/sunny/whisper/` — lazily downloaded whisper models.

### Resetting TCC grants during rebuild churn

If your dev build isn't signed with a stable identity, macOS treats each
rebuild as a different app and the existing Accessibility / Screen
Recording / AppleEvents grants stop applying. Two ways out:

1. Set a real `signingIdentity` in `src-tauri/tauri.conf.json` (see the
   README's Prerequisites note on code signing). Grants persist.
2. Reset the grants and re-approve the prompts on next launch:

```bash
tccutil reset Accessibility     ai.kinglystudio.sunny
tccutil reset ScreenCapture     ai.kinglystudio.sunny
tccutil reset AppleEvents       ai.kinglystudio.sunny
tccutil reset SystemPolicyAllFiles ai.kinglystudio.sunny
```

Dev builds (`pnpm tauri dev`) use an ad-hoc signature that is distinct
from the release bundle's, so grants do not carry over between
`tauri dev` and `app:build`. Plan on re-approving prompts when you
switch modes.

`scripts/doctor.sh` prints a one-shot `OK`/`MISS` summary of every
dependency — use it whenever something feels off.

### "App launched but voice is silent"

Three common causes, in order of frequency:

- **`koko` CLI missing.** `which koko` should resolve to
  `~/.local/bin/koko`. If it doesn't, voice falls back to the macOS `say`
  command and sounds robotic. Install `koko` (see README).
- **Kokoro model files missing.** `ls ~/.cache/kokoros/` should show
  both `kokoro-v1.0.onnx` and `voices-v1.0.bin`. If either is absent,
  `koko` refuses to synthesize and SUNNY falls back to `say`.
- **Mic permission never granted.** Without Microphone access, whisper
  has nothing to transcribe and the turn ends silently. Check System
  Settings → Privacy & Security → Microphone.

### Lint and type checks

```bash
pnpm tsc -b                  # TypeScript across the workspace
cd src-tauri && cargo check  # Rust compile-only, ~2s after the first build
```

Both should be clean before opening a PR.

### Local dev loop

```bash
pnpm tauri dev
```

Note the signing caveat above — dev builds do not share TCC grants with
release builds, so the first voice press / first screen capture after
switching modes will re-prompt.

## Project layout

```
sunny/
├─ src/                    React frontend (HUD + pages + agent stack)
│  ├─ components/            HUD panels, overlays
│  ├─ pages/                 Module pages (memory, files, calendar, …)
│  ├─ lib/                   Pure-TS agent stack (no React imports)
│  │  ├─ agentLoop.ts         turn dispatcher
│  │  ├─ planner.ts           HTN decomposer
│  │  ├─ introspect.ts        pre-run
│  │  ├─ skillExecutor.ts     System-1 recipe runner
│  │  ├─ critic.ts            dangerous-action review
│  │  ├─ constitution.ts      policy + prompt
│  │  ├─ reflect.ts           post-run
│  │  ├─ consolidator.ts      episodic → semantic
│  │  ├─ skillSynthesis.ts    recipe compilation
│  │  ├─ modelRouter.ts       purpose-based LLM routing
│  │  ├─ contextPack.ts       memory + world assembly
│  │  └─ tools/               tool registry
│  ├─ store/                zustand stores
│  ├─ skills/               drop-in skill packs
│  └─ hooks/                React-specific helpers
│
├─ src-tauri/src/          Rust backend
│  ├─ lib.rs                 crate root: mods + pub fn run()
│  ├─ startup.rs             .setup hook body + background tokio loops
│  ├─ commands.rs            #[tauri::command] wrappers (slim forwarders)
│  ├─ menu.rs                macOS application menu
│  ├─ clipboard.rs           clipboard sniffer types/helpers
│  ├─ app_state.rs           Tauri-managed AppState struct
│  ├─ memory/                3-store SQLite + FTS + embeddings
│  ├─ world/                 continuous world model (model/updater/classifier/…)
│  ├─ constitution.rs        declarative values + gate
│  └─ …26+ domain modules
│
└─ docs/                   Technical docs (this directory)
```

## Useful commands

```bash
pnpm install            # install node deps
pnpm tauri dev          # run the desktop app (dev)
pnpm tauri build        # production .app / .dmg
pnpm app:build          # build + patch Info.plist + refresh desktop alias
pnpm dev                # vite-only (for UI-only work, no backend)
pnpm build              # vite build (frontend only)
pnpm lint               # eslint
pnpm tsc -b --noEmit    # TypeScript typecheck

cd src-tauri
cargo check             # quick compile check (~2s after first build)
cargo test --lib        # run 171 Rust tests
cargo test --lib constitution    # filter to a module
cargo test --lib -- --nocapture  # see println output
cargo clippy --all-targets       # lint Rust (pre-existing warnings on some modules)
```

## Coding style

Written rules are short. Reading the existing code is the better guide,
but here are the conventions we lean on:

### TypeScript

- **Strict mode everywhere.** `tsc -b --noEmit` is green on `main`.
- **Pure functions where possible.** Anything under `src/lib/` should be
  importable without React and testable with a mock Tauri IPC.
- **Defensive input validation.** Treat `unknown` as `unknown`. The
  helpers in `src/lib/tools/parse.ts` (`requireString`, `optionalNumber`,
  …) are good primitives.
- **Fail open.** Missing Tauri / missing Ollama / permission denied →
  return null / empty / fallback. Never throw from a background loop.
- **Extensive comments explaining *why*.** The agent stack is full of
  decisions that matter (e.g. "we block on embed because…", "we use
  `reqIdRef` to discard stale responses because…"). Match that style.
- **`readonly` on public types** — zustand states, store reads, and
  cross-module shapes all use `readonly` and `ReadonlyArray`.
- **No default exports** for modules (exceptions: React page
  components, skill manifests — both driven by external glob
  conventions).

### Rust

- **Serde for wire types.** Every struct exposed as a command derives
  `Serialize` and `Deserialize` and has a TypeScript mirror.
- **`Result<T, String>` for command returns.** String errors cross the
  IPC boundary cleanly and render well in frontend errors.
- **`with_conn(|c| { ... })`** for any memory access. Don't expose
  raw `Connection` references outside the `memory::db` module.
- **Prefer `OnceLock` for module-level singletons.** See
  `world/state.rs` (state cell) and `memory/db.rs` (connection) for the
  pattern.
- **Timeouts on every external call.** `tokio::time::timeout` on
  osascript (3 s), tesseract (10 s), reqwest (15 s default in
  `web::build_client`).
- **Graceful permission errors.** Full Disk Access, Accessibility,
  Screen Recording, Calendar, Mail — each has a user-facing hint string
  the frontend surfaces verbatim.

### Comments

We write comments to explain **intent, trade-offs, and constraints** the
code itself can't convey — not what the next line does. A good comment
answers one of:

- Why was it structured this way?
- What breaks if you change this?
- What alternatives were considered and why not?
- What's the invariant this relies on?

A bad comment restates the code. Match the former; skip the latter.

## Testing

### Rust

171 tests across the `src-tauri/src/` tree. Run all:

```bash
cd src-tauri && cargo test --lib
```

Test organization:

- **Per-module `#[cfg(test)] mod tests`** inside each file — primary.
- **`db::scratch_conn`** helper creates an isolated scratch SQLite for
  memory tests; tests use this instead of the global cell.
- **No integration tests yet** — Tauri's harness isn't great for cross-
  command tests. The existing unit-test density compensates.

When adding a new store or major module, port the scratch-dir pattern
and aim for 4–8 tests covering:

- Happy path
- Edge cases (empty input, malformed JSON, missing fields)
- Idempotence (can you run the same operation twice?)
- Rate-limit / gate behavior (if applicable)

### TypeScript

No runtime test harness currently. `pnpm tsc -b --noEmit` catches
contract breaks. Pure helpers are exported under an `__internal`
namespace on modules that need testing (e.g. `reflect.ts::__internal`)
so a future Vitest pass can target them without public-API churn.

If you're adding a non-trivial pure helper, export it under
`__internal` so testability is preserved.

## Adding a new capability

A rough map of where different kinds of additions go:

| Add this | Where |
|---|---|
| New agent tool | `src/lib/tools/builtins/<domain>.ts` + register in index |
| New Tauri command (infrastructure) | real implementation in `src-tauri/src/<domain>.rs`; thin `#[tauri::command]` wrapper in `src-tauri/src/commands.rs`; register path in `lib.rs`'s `invoke_handler!` |
| New memory subsystem | `src-tauri/src/memory/<new>.rs` + wire into `pack.rs` |
| New page | `src/pages/<NewPage>/index.tsx` (folder convention: `types.ts` / `utils.ts` / component files) + register in `src/pages/pages.ts` |
| New background loop | start in `App.tsx` (TS) or `startup::setup` in `src-tauri/src/startup.rs` (Rust) |
| New constitution rule kind | extend `Prohibition` in `constitution.rs` + mirror TS |
| New skill (not in-tree) | `src/skills/*.ts` or `~/.sunny/skills/*.ts` |
| New cognitive layer | new `src/lib/<layer>.ts` + thread through `agentLoop.ts` |

## Pull request workflow

1. Branch from `main`.
2. One logical change per PR. If you can split, split.
3. Add tests for Rust changes. Typecheck + lint must stay green.
4. Update the relevant doc in `docs/` if you change observable behavior.
5. Add a line to `CHANGELOG.md` under "Unreleased".
6. Open PR with description, screenshots (for UI), benchmarks (for perf).

## Philosophy

A few design principles repeat across the codebase. If you're uncertain
about a choice, re-ask whether it preserves these:

1. **Fail open, degrade gracefully.** No single upstream failure takes
   out the app.
2. **Local-first.** Anything that touches the user's data should work
   entirely locally when possible. Cloud is a user choice.
3. **User is the final authority.** Constitution, ConfirmGate, every
   user-visible toggle is respected even when the agent disagrees.
4. **Background loops are optional accelerants.** They make SUNNY better
   but their absence must not break anything.
5. **Every non-trivial decision is legible.** If the agent chooses
   between System-1 / System-2 / introspect-direct / HTN-split, the
   user sees which one fired and why.
6. **Idempotent everywhere.** Any write should be safe to repeat. Keys
   on `(subject, text)` for semantic, `id` for episodic, `name` for
   procedural.
7. **Typed contracts across the IPC boundary.** Every Rust command
   struct has a TypeScript mirror. Changes caught at compile time.

## Where to find me

Open an issue or PR. Bug reports with the contents of `~/.sunny/settings.json`
(redact the provider keys!) and a `pnpm tauri dev` log are maximally useful.

Skills, constitution recipes, and tool packs welcome in any form — a
gist URL is fine for starters.

## Further reading

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — big-picture stack
- [`docs/AGENT.md`](./AGENT.md) — agent loop internals
- [`docs/MEMORY.md`](./MEMORY.md) — memory schema
- [`docs/SKILLS.md`](./SKILLS.md) — skill authoring
- [`docs/CONSTITUTION.md`](./CONSTITUTION.md) — policy
- [`docs/TOOLS.md`](./TOOLS.md) — registry reference
- [`CHANGELOG.md`](../CHANGELOG.md) — history
