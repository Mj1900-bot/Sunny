<div align="center">

# Sunny

**A sci-fi HUD-style personal assistant for macOS — with a real cognitive architecture.**

Three-store memory · continuous world model · hybrid retrieval · self-compiled skills ·
post-run reflection · HTN decomposition · constitutional values · critic review.

Built on **Tauri 2 + React 19 + Rust**. Runs entirely local when you want it to.

[Quickstart](#quickstart) · [Architecture](#architecture) · [Docs](./docs/README.md) · [HUD pages](./docs/PAGES.md) · [Security](./docs/SECURITY.md) · [Onboarding](./docs/ONBOARDING.md) · [Changelog](./CHANGELOG.md)

</div>

---

## What is SUNNY?

SUNNY is an assistant that **remembers you, gets smarter with use, and operates
autonomously** on your Mac. It has access to your apps, calendar, mail, files,
terminals, clipboard, web, and — with opt-in — your screen.

Unlike most assistants, SUNNY is built around a proper **cognitive architecture**
rather than a single prompt loop:

```
         ┌─────────────────────────────────────────────────────┐
 L7      │  CONSCIOUSNESS   pre-run introspection, post-run    │
         │                  reflection, constitutional values  │
         ├─────────────────────────────────────────────────────┤
 L6      │  PLANNER         HTN decomposition, System-1 skill  │
         │                  router, System-2 ReAct loop        │
         ├─────────────────────────────────────────────────────┤
 L5      │  SOCIETY         critic review gate, sub-agent      │
         │                  dispatch, ConfirmGate              │
         ├─────────────────────────────────────────────────────┤
 L4      │  MEMORY          episodic · semantic · procedural   │
         │                  FTS + embedding hybrid retrieval   │
         ├─────────────────────────────────────────────────────┤
 L3      │  WORLD MODEL     focus · activity · calendar · mail │
         │                  · machine · recent switches        │
         ├─────────────────────────────────────────────────────┤
 L2      │  PERCEPTION      clipboard · push-to-talk · focus OCR│
         ├─────────────────────────────────────────────────────┤
 L1      │  EFFECTORS       60 tools: OS, files, web, apps,    │
         │                  automation, vision, memory, audio, │
         │                  iMessage + calls + per-contact     │
         │                  AI proxy, multi-terminal workspace │
         └─────────────────────────────────────────────────────┘
```

Every agent turn flows up the stack for perception and memory, then down for
decision and action. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for
a full walkthrough.

## What makes it interesting

| Property | What SUNNY does |
|---|---|
| **Remembers you** | Three-store SQLite memory (episodic · semantic · procedural) with FTS5 keyword + Ollama embedding hybrid retrieval |
| **Gets smarter with use** | A 15-min consolidator mines events into durable facts; a 20-min synthesizer auto-compiles 5+ repeated successful runs into deterministic skills |
| **Skips the LLM when it can** | System-1 router runs a learned skill in ~400 ms when goal similarity ≥ 0.85 — no model call required |
| **Knows what you're doing now** | Continuous world model updates every 15 s: focused app, activity classifier, next calendar event, unread mail count, recent app switches |
| **Thinks before it asks** | Pre-run introspection can answer from memory (`direct`), ask one clarifying question (`clarify`), or attach caveats to the main loop (`proceed`) |
| **Splits complex goals** | HTN decomposer recognizes multi-part goals and runs each sub-goal independently, then composes the answer |
| **Honors your values** | `~/.sunny/constitution.json` — declarative identity + values + hard prohibitions, enforced at every tool-call gate |
| **Double-checks itself** | A cheap-model critic reviews dangerous actions before ConfirmGate — three-layer defense |
| **Shows its work** | Visible insight feed: every routing decision (skill fired, skill synthesized, memory hit, caveat, block) surfaces as a toast and persists in the Memory page |
| **Speaks for you** | Text or call anyone by name (iMessage, SMS via iPhone continuity, FaceTime). Per-contact AI proxy drafts (or auto-sends) replies on your behalf, with a 30 s rate limit + global kill switch. |
| **Owns your terminal** | Real PTYs with sane termios, WebGL-rendered xterm.js, Unicode 11 widths, inline ⌘F search. A popout workspace overlay runs multiple shells side-by-side (max 3 per row) with auto-derived titles / cwd from OSC sequences. The agent can `terminals_list` / `spawn` / `send` / `wait_for` / `read` the exact same terminals you're looking at. |
| **Sees your screen** | Screen module does live capture, drag-to-select regions, OCR with a searchable box overlay, and point-and-click: tap a recognized word in the preview and SUNNY drives the real cursor to it via `mouse_click_at`. |
| **Local-first** | Memory/world/consolidator/synthesizer/critic all run against local Ollama by default. Cloud providers optional. |
| **Browses safely** | Multi-profile browser with tor/private/clearnet/custom-proxy routing, per-tab ephemeral WebView sandboxes with fingerprint resistance + WebRTC disablement + sensor denial, a single Rust dispatcher every network call walks through, plus audit log, kill switch, tracker blocking, and universal video download via yt-dlp. See [`docs/BROWSER.md`](./docs/BROWSER.md). |
| **Runs agents for you, forever** | Persistent AI "daemons" with a 12-template gallery (morning briefing, inbox triage, security sweep, weekly review…). Write a goal in English, pick a cadence, SUNNY wakes up on its own schedule and executes via the ReAct tool loop. Full live activity view, bypass-schedule `Run now`, event-triggered daemons for cross-module automation. See [`docs/AUTO.md`](./docs/AUTO.md). |
| **Scans for malware** | On-device virus scanner: streaming SHA-256 + MalwareBazaar (+ optional VirusTotal) hash lookups, 8 macOS heuristics (quarantine xattr, codesign, magic bytes, path risk, …), and an atomic quarantine vault at `~/.sunny/scan_vault/` with chmod 000 isolation and restore/delete. Animated HUD gauge, bulk-quarantine, reveal-in-Finder, findings export. See [`docs/SCAN.md`](./docs/SCAN.md). |
| **Watches itself** | The **Security** module (not the virus scanner) streams tool calls, egress, TCC changes, and launch-item deltas to an in-app audit trail and `~/.sunny/security/events.jsonl`, with a one-click **panic** mode that stops tools and network I/O. See [`docs/SECURITY.md`](./docs/SECURITY.md). |
| **Degrades gracefully** | Ollama off → FTS-only retrieval. tesseract missing → no OCR, no crash. Any background loop can fail without breaking foreground runs. |

## Quickstart

### Requirements

- macOS 11+
- [Node.js 20+](https://nodejs.org) (we use `pnpm`)
- [Rust 1.77+](https://rustup.rs)
- **Recommended (for the smart parts):**
  [Ollama](https://ollama.com) with:
  - `ollama pull nomic-embed-text` — 768-d embeddings (~275 MB)
  - `ollama pull qwen2.5:3b` — cheap model for introspection, reflection,
    consolidator, critic, decomposer (~2 GB)
  - Your preferred big model for planning (e.g. `llama3.2`, `qwen2.5:14b`)
- Optional CLI tools: `ffmpeg` or `sox` (mic input), `whisper-cpp`
  (local speech-to-text — preferred; `openai-whisper` also works),
  `tesseract` (screen OCR), `openclaw` (chat fallback)

```bash
brew install ffmpeg whisper-cpp tesseract
```

### Voice (Kokoro TTS)

SUNNY uses the **Kokoro** neural TTS engine for British voice output. Without it,
voice falls back to the macOS `say` command (audibly different quality).

1. **Install the `koko` CLI** to `~/.local/bin/koko`:

   ```bash
   # Download the latest koko binary for macOS arm64:
   curl -fsSL https://github.com/thewh1teagle/kokoro-onnx/releases/latest/download/koko-macos-arm64      -o ~/.local/bin/koko
   chmod +x ~/.local/bin/koko
   ```

   Verify: `which koko` should resolve to `~/.local/bin/koko`. Make sure
   `~/.local/bin` is on your `$PATH` (add `export PATH="$HOME/.local/bin:$PATH"`
   to your `.zshrc` if needed).

2. **Download the model weights** to `~/.cache/kokoros/`:

   ```bash
   mkdir -p ~/.cache/kokoros
   # ONNX model (~310 MB):
   curl -fsSL https://github.com/thewh1teagle/kokoro-onnx/releases/latest/download/kokoro-v1.0.onnx      -o ~/.cache/kokoros/kokoro-v1.0.onnx
   # Voice pack (~28 MB):
   curl -fsSL https://github.com/thewh1teagle/kokoro-onnx/releases/latest/download/voices-v1.0.bin      -o ~/.cache/kokoros/voices-v1.0.bin
   ```

   Verify: `ls ~/.cache/kokoros/` should show both `kokoro-v1.0.onnx` and
   `voices-v1.0.bin`. If either is absent, `koko` refuses to synthesize and
   SUNNY silently falls back to `say`.

3. **Test**:

   ```bash
   echo "hello sunny" | koko --voice af_heart
   ```

On first voice press, SUNNY lazily downloads `ggml-tiny.en.bin`
(~74 MB) into `~/Library/Caches/sunny/whisper/` and silently
upgrades to `ggml-base.en.bin` in the background. Set
`SUNNY_WHISPER_MODEL=/path/to/ggml-*.bin` to force a specific model.

### Dev mode

```bash
pnpm install
pnpm tauri dev
```

First build compiles a lot of Rust — give it a few minutes. After that,
HMR applies to the React side without rebuilding the Rust backend.

### Build a shippable `.app`

```bash
pnpm app:build
```

Artifact lands in `src-tauri/target/release/bundle/macos/Sunny.app`. The
`scripts/patch-info-plist.sh` step adds the permission strings macOS
requires for Screen Recording, Accessibility, Full Disk Access, Calendar,
Contacts, Mail, and Notes.

## Testing

### Unit tests (Vitest)

```bash
pnpm test
```

Runs all TypeScript unit tests via Vitest. This includes the agent stack
(planner, introspect, reflect, critic), memory helpers, skill synthesis,
tool registry, and the ingress/canary scanner stubs. Coverage is reported
to the terminal; the target threshold is 80 %. **262+ tests** as of Phase 3.

### End-to-end tests (Playwright, opt-in)

Playwright and Chromium binaries (~300 MB) are not installed by default.
One-time setup:

```bash
pnpm add -D @playwright/test
npx playwright install chromium
```

Then:

```bash
pnpm test:e2e            # headless, single pass
pnpm test:e2e --headed   # watch the browser
pnpm test:e2e --ui       # Playwright interactive mode
```

The `webServer` block in `playwright.config.ts` auto-spawns `pnpm dev` on
port 5173 for each run (or reuses an existing server). Specs live in
`e2e/` — see [`e2e/README.md`](./e2e/README.md) for what to write there.

### Rust tests

```bash
cd src-tauri && cargo test --lib
```

Covers security redaction, memory retrieval, canary detection, behavior
anomaly logic, reader-pool concurrency, and the agent loop helpers.
**1094+ tests** as of Phase 3. The composite self-test script
(`scripts/self_test.sh`) chains all of these together with a smoke eval
and a latency benchmark — run it before a release.

## Usage

- **`⌘K`** — open the command bar
- **Hold `Space`** — push-to-talk
- **`⌘,`** — settings
- Type any natural-language goal; SUNNY figures out which sub-system to use

> **Roadmap — coming soon:** always-on wake-word ("hey sunny"). The setting in
> General is currently inert; a proper keyword-spotting model
> (openwakeword / porcupine) is queued to replace the whisper-poll prototype.
> Until then, hold `Space` to talk.

Voice chat is a full conversation: press space once, talk naturally, pause, and
SUNNY replies. VAD auto-ends your utterance, the AI starts speaking as the first
sentence streams in, and speaking *while* the AI talks interrupts it (barge-in
with echo-cancellation so the AI's own voice can't self-interrupt). Tap space
again at any stage — recording, transcribing, thinking, speaking — to cancel.
The last 8 turns are threaded as conversation history so follow-ups ("what
about tomorrow?") land in the right context.

A few examples you can try:

```
search for rust async runtime benchmarks
what's on my calendar today
summarize this page  ← while browsing
text sunny that i'm on my way  ← resolves name → ConfirmGate → iMessage
call mom on facetime
deploy sunny and text mom about it  ← HTN splits this into two sub-goals
my morning brief  ← after running it 5× it becomes a learned skill
scan my downloads for malware  ← spawns scan_start, reports verdict counts
install the morning briefing agent  ← creates a persistent daemon
```

See [`docs/AGENT.md`](./docs/AGENT.md) for how a turn is routed.

## Browser

The **Web** module is a hardened multi-profile browser built around a single
network dispatcher every tab and download walks through.

**Profiles.** Three built-ins plus user-authored:

| Profile | Route | JS | Cookies | HTTPS-Only | Security | Audit | Use for |
|---|---|---|---|---|---|---|---|
| `default` | Clearnet + DoH | opt-in | persistent | no | Standard | yes | everyday research |
| `private` | Clearnet + DoH, UA rotation, WebRTC off | opt-in | ephemeral | yes | Safer | no | no-trace browsing |
| `tor`     | System Tor or bundled arti | off | ephemeral | no (onion carve-out) | Safer | no | true anonymity |
| `custom`  | User SOCKS5/HTTPS proxy | opt-in | ephemeral | yes | Safer | yes | VPN / proxy chains |

Every profile has a declarative `ProfilePolicy` — `block_third_party_cookies`,
`block_trackers`, `block_webrtc`, `deny_sensors`, `audit`, `kill_switch_bypass`,
`https_only`, `security_level`. Forgetting to set one never relaxes posture;
defaults tighten as you move down the table. Posture is shown above every
tab: `TOR · JS OFF · SAFER · EPHEMERAL · TRACKERS BLOCKED · WEBRTC OFF`.

**Security slider.** Three buttons on the posture bar (`STD` / `SAFER` /
`SAFEST`) mirror Tor Browser's slider. Safer disables WebAssembly,
SharedArrayBuffer, and OffscreenCanvas and rounds `performance.now()` to
1 ms. Safest blocks dynamic code evaluation entirely and rounds timing to
100 ms. Sunny's `tor` + `Safest` combination matches Tor Browser on most
fingerprint vectors — the full comparison is in
[`docs/BROWSER.md`](./docs/BROWSER.md) §13.

**Tabs.** Each tab picks between two render modes:

- **Reader** (default) — Rust sanitizes remote HTML to an allow-list of 15
  tags (no script, no inline handlers, no `img[src]`, href scheme-checked)
  and the React side parses that through `DOMParser` into a React tree.
  No JS ever executes on untrusted markup.
- **Sandbox** — spawns a Tauri `WebviewWindow` with `data_directory` set to
  an ephemeral per-tab path, a fingerprint-hardening init-script, and
  `proxy_url` pointed at a loopback HTTP listener we own. That listener
  re-enters the dispatcher, so the tab's traffic picks up tor/adblock/audit/
  kill-switch the same way reader fetches do. TLS is terminated by the
  destination — we CONNECT-splice the bytes through, never MITM.

**Downloads & media.** `yt-dlp` + `ffmpeg` are probed on PATH (brew paths
fallback). Jobs carry the tab's profile so downloads route through the same
transport. `browser_media_extract` calls ffprobe + ffmpeg to produce
`audio.mp3` + ~120 keyframes per video for downstream AI analysis; the
workbench drawer wires this to transcript / summary / ask panels.

**Research.** `browser_research_run` fans out 8 parallel readable fetches
through the active profile, dedupes by canonical URL (UTM params stripped),
and returns trimmed source text with citations the user can open into new
tabs.

**Guardrails.** A grep-based CI check (`scripts/check-net-dispatch.sh`)
rejects new `reqwest::Client` constructions outside
`src-tauri/src/browser/transport.rs`. The kill switch in the profile rail
short-circuits every dispatcher call before a socket opens. The audit log at
`~/.sunny/browser/audit.sqlite` records host:port + sizes + timing (never URL
paths) — with the Tor profile opted out so we don't even record what the
user visited there.

## Project structure

```
sunny/
├─ src/                          React frontend (the HUD)
│  ├─ components/                  HUD panels + overlays
│  ├─ pages/                       33 lazy-loaded module pages (today, security,
│  │                               audit, memory, web, scan, auto, …) + Overview grid
│  ├─ lib/                         Agent stack (pure TS, no React)
│  │  ├─ agentLoop.ts                the turn dispatcher
│  │  ├─ planner.ts                  HTN decomposer
│  │  ├─ introspect.ts               pre-run direct/clarify/proceed
│  │  ├─ skillExecutor.ts            System-1 recipe runner
│  │  ├─ critic.ts                   dangerous-action review
│  │  ├─ constitution.ts             policy gate + prompt block
│  │  ├─ reflect.ts                  post-run lesson extraction
│  │  ├─ consolidator.ts             episodic → semantic extractor
│  │  ├─ skillSynthesis.ts           auto-compile recipes from runs
│  │  ├─ modelRouter.ts              purpose-based cheap/main routing
│  │  ├─ contextPack.ts              memory + world assembly per run
│  │  └─ tools/                      tool registry + domain bundles
│  ├─ store/                       zustand stores (view, agent, insights…)
│  └─ skills/                      optional TS-backed skill packs
│
├─ src-tauri/src/                Rust backend
│  ├─ lib.rs                       crate root: mods + pub fn run()
│  ├─ startup.rs                   setup hook + background emitter loops
│  ├─ commands.rs                  thin #[tauri::command] wrappers
│  ├─ menu.rs                      macOS application menu
│  ├─ clipboard.rs                 clipboard sniffer types + helpers
│  ├─ app_state.rs                 Tauri-managed AppState
│  ├─ memory/                      3-store SQLite + FTS5 + embeddings
│  ├─ world/                       continuous world model (model, updater,
│  │                               classifier, side_effects, persist, …)
│  ├─ constitution.rs              declarative values + gate
│  ├─ automation.rs                mouse + keyboard via enigo
│  ├─ vision.rs, ocr.rs            screen capture + tesseract OCR
│  ├─ ax.rs                        window / focus introspection
│  ├─ ai.rs                        OpenClaw + Ollama transports
│  └─ …30 more modules             apps, calendar, messaging, vault, …
│
├─ docs/                         Technical docs ([index](./docs/README.md))
├─ CHANGELOG.md                  Phase-by-phase history
└─ README.md                     this file
```

Rough scale: on the order of tens of kLOC Rust + TypeScript, **~130** `#[tauri::command]` registrations in the invoke handler, a large agent tool catalog, **33** lazy HUD pages plus Overview, multiple background loops (memory, learning, consolidator, synthesizer, browser proxy, sub-agent worker, daemon runtime, tray sync), and layered enforcement (constitution, ConfirmGate, critic, **Security** bus).

## Documentation

The canonical **index** is [`docs/README.md`](./docs/README.md) (grouped by topic). Highlights:

| Document | What's in it |
|---|---|
| [`docs/PAGES.md`](./docs/PAGES.md) | **What each HUD screen does** (Today, Security, Audit, Scan, …) |
| [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) | First-time contributor path: clone → dev → doc order → PR checklist |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Threat model, panic mode, audit log, egress/ingress roadmap (live Security module) |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Tauri layout, `agent_loop`, memory, world model, events |
| [`docs/AGENT.md`](./docs/AGENT.md) | How a turn is routed: introspect → HTN → S1 → S2 → reflect |
| [`docs/MEMORY.md`](./docs/MEMORY.md) | Three memory stores, retrieval, consolidation |
| [`docs/SKILLS.md`](./docs/SKILLS.md) | Skills format, synthesis, manual packs |
| [`docs/AUTO.md`](./docs/AUTO.md) | Schedulers, daemons, templates, AUTO page |
| [`docs/SCAN.md`](./docs/SCAN.md) | On-demand malware scan, quarantine vault, signatures |
| [`docs/CONSTITUTION.md`](./docs/CONSTITUTION.md) | `constitution.json`, values, gates |
| [`docs/TOOLS.md`](./docs/TOOLS.md) | Tool registry, adding a tool (Rust + TS) |
| [`docs/BROWSER.md`](./docs/BROWSER.md) | Web module: profiles, dispatcher, Tor, sandbox |
| [`docs/BINDINGS.md`](./docs/BINDINGS.md) | Generated `ts-rs` types in `src/bindings/` |
| [`docs/SHORTCUTS.md`](./docs/SHORTCUTS.md) | Keyboard shortcuts |
| [`docs/PAGE_COVERAGE.md`](./docs/PAGE_COVERAGE.md) | Agent-tool coverage audit per page (developer roadmap) |
| [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) | Dev setup, tests, style |
| [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) | Permissions, Ollama, OCR, voice |
| [`CHANGELOG.md`](./CHANGELOG.md) | Phase / release history |

## Privacy & local-first

SUNNY is designed to run **entirely on your Mac**:

- **Memory DB** at `~/.sunny/memory/memory.sqlite` (SQLite + FTS5), file mode `0600`
- **World state** at `~/.sunny/world.json` (0600)
- **Constitution** at `~/.sunny/constitution.json` (0600, user-editable)
- **Vault secrets** in the macOS Keychain (never on disk)
- **Security audit** append-only log at `~/.sunny/security/events.jsonl` (rotated; redacted fields) — see [`docs/SECURITY.md`](./docs/SECURITY.md)
- **Embeddings** via local Ollama — no network calls for embeddings
- **Consolidator/reflection/critic/introspection** default to local cheap model
- **Screen OCR** is **off by default** and rate-limited when on
- **Vault reveals** are rate-limited to 5 per 60 s to prevent agent runaway

Your configured planning provider is the one thing that can leave the
machine. Swap it for Ollama in settings to run fully offline.

### Security at a glance

- **Scan** ([`docs/SCAN.md`](./docs/SCAN.md)) — optional hash/heuristic malware checks and quarantine.
- **Security** ([`docs/SECURITY.md`](./docs/SECURITY.md)) — runtime monitoring of tools, network, permissions, and system integrity, plus panic stop for everything at once. These are different modules; both show up in the nav under different names.
- **Process budget** ([Phase 5](./docs/SECURITY.md#process-budget-phase-5)) — `RLIMIT_NPROC` floor, 16-permit spawn semaphore, daemon/PTY/sibling/cadence caps, and a boot-guard marker that quarantines daemons after any abnormal exit. SUNNY is incapable of exhausting the user's uid-wide process table by construction.

## License & contributing

- Plugin-style skills live in `src/skills/`. See
  [`src/skills/README.md`](./src/skills/README.md) to add your own.
- Constitution edits are a direct path to personalize SUNNY without touching
  code — see [`docs/CONSTITUTION.md`](./docs/CONSTITUTION.md).
- Code PRs, skill packs, and bug reports welcome. Start with
  [`docs/ONBOARDING.md`](./docs/ONBOARDING.md), then
  [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) for day-to-day workflow.

---

<div align="center">
<sub>Built by <a href="https://github.com/sunnybak">Sunny</a> · Tauri 2 · React 19 · Rust · sqlite-vec-ready · Ollama-first</sub>
</div>
