# Tools

SUNNY exposes **64 built-in tools** to the agent via the global tool
registry. Each tool is a JSON-schema'd function with a safety flag. The
agent's ReAct loop picks one per turn and invokes it with inputs the
model composed.

This document lists every built-in, groups them by domain, and explains
how to add new ones.

## The registry

**File**: `src/lib/tools/registry.ts` + `src/lib/tools/types.ts`

```ts
type Tool = {
  schema: {
    name: string;                          // unique global id
    description: string;                   // shown to the LLM
    input_schema: Record<string, unknown>; // JSON Schema
  };
  dangerous: boolean;                      // gates via critic + ConfirmGate
  run: (input: unknown, signal: AbortSignal) => Promise<ToolResult>;
};

type ToolResult = {
  ok: boolean;
  content: string;      // what the model sees in the next turn
  data?: unknown;       // structured payload (ignored by the model prompt)
  latency_ms: number;
};
```

Tools are registered into a module-level Map and exposed read-only via
`TOOLS`. `listToolSchemas()` is what `buildSystemPrompt` uses to render
the AVAILABLE TOOLS block on every run.

## Safety

Every tool call (from System-1 recipes or System-2 loops) passes through
three layers before it runs:

1. **Constitution gate** — hard rules from `~/.sunny/constitution.json`
2. **Critic review** — cheap-model approval on `dangerous: true` tools
3. **ConfirmGate** — user-facing modal

See [`docs/CONSTITUTION.md`](./CONSTITUTION.md) and
[`docs/AGENT.md`](./AGENT.md#d-tool-branch--three-layer-defense) for
details.

## Tool catalog

### Core — OS + apps

| Name | Dangerous | Purpose |
|---|---|---|
| `open_app` | yes | Launch a macOS app by name |
| `fs_list` | no | List directory contents at an absolute path |
| `run_shell` | yes | Run a shell command via `/bin/zsh -lc` (30 s cap, safety preflight) |
| `speak` | no | Speak text via macOS `say` (blocks until playback finishes; falls back to system voice if the configured one is missing) |
| `get_clipboard_history` | no | Read recent clipboard entries (bounded ring) |
| `openclaw_ping` | no | Check whether OpenClaw is reachable |
| `messages_recent` | no | Last N iMessage contacts with preview text (Full Disk Access required) |

### Comms — text, call, converse

Registered from `src/lib/tools/builtins/comms.ts`. Requires Full Disk
Access for chat.db reads and Automation (Messages) for sends. `text_contact`
and `call_contact` resolve fuzzy names against recent chats first, then the
macOS AddressBook (`~/Library/Application Support/AddressBook/`), returning a
structured candidate list on ambiguity so the agent can ask the user which
"Sunny" to reach.

| Name | Dangerous | Purpose |
|---|---|---|
| `resolve_contact` | no | Fuzzy name → handle lookup (or candidate list on ambiguity). Use before a risky send. |
| `send_imessage` | yes | Send an iMessage to an explicit handle (phone / email). |
| `send_sms` | yes | Send an SMS via the paired iPhone's Text Message Forwarding. |
| `text_contact` | yes | Send a message by fuzzy name (`text_contact({ name: "Mom", body: "on my way" })`). Picks iMessage by default; pass `service: "sms"` to force SMS. |
| `call_contact` | yes | Place a `phone` / `facetime_audio` / `facetime_video` call. Phone mode routes through iPhone continuity via the `tel:` URL. |
| `list_chats` | no | List recent conversations with participants, preview text, and unread flags. Read-only. |
| `fetch_conversation` | no | Read the last N messages of one conversation (by peer handle or `chat<id>`). Decodes Ventura+ `attributedBody` blobs where `text` is null. |

The backing Tauri commands (`messaging_send_imessage`, `messaging_call_phone`,
`messaging_fetch_conversation`, `messages_watcher_set_subscriptions`, …) plus
the per-contact AI proxy engine live outside the tool surface — see
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) and `src/lib/proxyEngine.ts`.

### Web

Two surfaces exist: the **legacy `web_*`** commands (single-tab reader,
preserved for backwards compatibility with existing tool callers), and
the **policy-enforced `browser_*`** commands introduced with the
multi-profile browser. New code should use `browser_*` so every call
picks up the active profile's tor/proxy/adblock/audit posture. See
[`docs/BROWSER.md`](./BROWSER.md) for the full architecture.

| Name | Dangerous | Purpose |
|---|---|---|
| `web_search` | no | DuckDuckGo HTML search → top-K `{title, url, snippet}` (legacy wrapper — same DDG parser now lives behind the dispatcher) |
| `web_fetch_readable` | no | Fetch a URL and return its main readable text (legacy; clearnet only) |
| `browser_fetch_readable` | no | Fetch + sanitize through a chosen profile. Returns `{status, final_url, extract: { title, description, body_html, text, favicon_url }}` |
| `browser_fetch` | no | Low-level policy-enforced fetch — method/headers/body/base64 body in + out. Use when `browser_fetch_readable` is too opinionated |
| `browser_research_run` | no | Parallel multi-source research through a profile. Returns `ResearchBrief { query, profile_id, sources[], elapsed_ms }` with trimmed readable text per source |
| `browser_profiles_list` | no | All known profiles + posture |
| `browser_profiles_get` / `_upsert` / `_remove` | no | Manage custom profiles (e.g. Mullvad SOCKS) |
| `browser_kill_switch` / `_status` | yes | Arm/disarm the global "no traffic leaves" switch |
| `browser_bookmarks_list` / `_add` / `_delete` | no | Per-profile bookmarks |
| `browser_history_list` / `_push` / `_clear` | no | Per-profile visit history (Tor profile skips writes by contract) |
| `browser_audit_recent` / `_clear_older` | no | Audit log reader + retention |
| `browser_sandbox_open` / `_close` / `_list` | yes | Spawn / close hardened WebView tabs. Each gets a loopback bridge + ephemeral data dir |
| `browser_tor_bootstrap` / `_status` / `_new_circuit` | no | System Tor probe (9050) or bundled arti when built with `--features bundled-tor` |
| `browser_downloads_probe` | no | Is `yt-dlp` / `ffmpeg` installed? |
| `browser_downloads_enqueue` / `_list` / `_cancel` / `_get` / `_reveal` | yes | Start / manage video downloads (routed through the tab's profile) |
| `browser_media_extract` | no | Run ffprobe + ffmpeg to produce `audio.mp3` + keyframes for a local video. Feeds the MediaWorkbench |

### Automation — mouse + keyboard

| Name | Dangerous | Purpose |
|---|---|---|
| `mouse_move` | yes | Move cursor to absolute screen coordinates |
| `mouse_click` | yes | Click at current cursor position |
| `mouse_click_at` | yes | Move to `(x, y)` then click |
| `mouse_scroll` | yes | Scroll by delta (wheel clicks) |
| `keyboard_type` | yes | Type a string into the focused field |
| `keyboard_tap` | yes | Tap a single key (e.g. `Enter`, `Escape`) |
| `keyboard_combo` | yes | Press a key combination (e.g. `Cmd+C`) |
| `cursor_position` | no | Read the current cursor coordinates |
| `screen_size` | no | Read the main display's resolution |

### Vision + OCR

| Name | Dangerous | Purpose |
|---|---|---|
| `screen_capture_full` | no | Full-display PNG + base64 + dims |
| `screen_capture_region` | no | Rectangular region capture |
| `screen_capture_active_window` | no | Frontmost window capture |
| `find_text_on_screen` | no | OCR + text search; returns bounding boxes |
| `click_text_on_screen` | yes | Find text then click its center |

### Memory

| Name | Dangerous | Purpose |
|---|---|---|
| `memory_add` | no | Write an episodic `note` row (free-form user memory) |
| `memory_list` | no | List episodic `note` rows, newest first |
| `memory_search` | no | FTS search across episodic `note` kind |
| `memory_delete` | no | Delete by id |

The richer typed surface (`memory_episodic_*`, `memory_fact_*`,
`memory_skill_*`, `memory_pack`, `memory_stats`) is exposed as Tauri
commands but **not** as tools — we don't want the agent synthesizing
arbitrary semantic facts about the user without going through the
consolidator or reflection. See [`docs/MEMORY.md`](./MEMORY.md).

### Scheduler

| Name | Dangerous | Purpose |
|---|---|---|
| `scheduler_list` | no | Show active + upcoming scheduled jobs |
| `scheduler_add` | yes | Create a one-off / interval / on-event job |
| `scheduler_delete` | yes | Remove a job |
| `scheduler_set_enabled` | yes | Enable/disable without deleting |
| `scheduler_run_once` | yes | Fire a job immediately regardless of timing |

### Virus scan

Registered from `src/lib/tools/builtins/scan.ts`. Full module details
in [`docs/SCAN.md`](./SCAN.md).

| Name | Dangerous | Purpose |
|---|---|---|
| `scan_start` | no | Start a malware scan on a file or folder; polls up to 45 s for completion and returns a progress summary with per-verdict counts. |
| `scan_findings` | no | List findings for a given scan id, elides CLEAN entries. |
| `scan_quarantine` | yes | Atomically move a flagged finding into the isolated vault (`~/.sunny/scan_vault/`, chmod 000). |
| `scan_vault_list` | no | List every file currently quarantined in the vault. |

### Files (opt-in pack)

Registered from `src/lib/tools.filesys.ts`.

| Name | Dangerous | Purpose |
|---|---|---|
| `file_write` | yes | Overwrite or create a file with content |
| `file_append` | yes | Append text to a file |
| `file_read_text` | no | Read a UTF-8 text file |
| `file_edit` | yes | In-place `find/replace` edit |
| `file_delete` | yes | Delete a file (moved to Trash when possible) |
| `file_rename` | yes | Rename / move a file |
| `file_mkdir` | yes | Create a directory (recursive) |
| `file_exists` | no | Check whether a path exists |

All file operations go through `safety_paths.rs` which enforces read and
write allow-lists (home-relative, denies `/System` / `/Library` etc.).

#### UI-only `fs_*` commands

The `FILES` page drives a richer set of filesystem commands that are **not**
registered as agent tools. They are Tauri-only (invoked directly from
`src/pages/FilesPage.tsx`) so the agent goes through the `file_*` pack
above and its Critic/ConfirmGate review, while the user gets a full file
manager in the HUD.

| Command | Purpose |
|---|---|
| `fs_list` | (also an agent tool — listed above) Enumerate a directory. |
| `fs_read_text` | Preview a text file, capped at 256 KiB. NUL-byte probe detects binary content so previews never render garbage. |
| `fs_mkdir` | Recursive directory create. |
| `fs_new_file` | Create a file with optional body; refuses to clobber an existing path. |
| `fs_rename` | Rename / move a file or directory. |
| `fs_copy` | Copy a file or entire tree (cross-filesystem safe). |
| `fs_trash` | Move to macOS Trash via Finder AppleScript — undoable, unlike `rm`. |
| `fs_dir_size` | Recursive size; bounded by a 50 k-entry cap so huge trees can't stall the UI. |
| `fs_search` | Recursive name search from a root, skips dotfile descent, capped at 500 results / 50 k entries visited. |
| `fs_reveal` | `open -R` — highlight an item in Finder. |

Same allow-lists apply: `fs_read_text` / `fs_search` / `fs_dir_size` /
`fs_reveal` require read access; `fs_mkdir` / `fs_new_file` / `fs_rename` /
`fs_copy` require write; `fs_trash` requires delete (which additionally
refuses to wipe top-level user landmarks like `~`, `~/Documents`,
`~/Downloads`).

#### UI-only `app_*` commands

The `APPS` page drives three `app_*` Tauri commands (also not registered
as agent tools — the agent controls apps through `open_app` / `run_shell`
with Critic + ConfirmGate).

| Command | Purpose |
|---|---|
| `app_quit` | Graceful quit via `tell application "X" to quit`. Already defined in `tools_macos.rs` for agent tool wrappers; now also registered in the frontend invoke handler. |
| `app_hide` | Hide an app's windows without quitting (`⌘H`). Uses `System Events → set visible of process → false`. |
| `finder_reveal` | Reveal an arbitrary path in Finder via `open -R`. Scoped in the UI to the two app roots (`/Applications` + `/System/Applications`) that `list_apps` enumerates. |

All three validate the supplied name for `"` / `\` / newline before it
ever reaches AppleScript, so the script stays un-injectable regardless of
what the UI (or a future caller) passes in.

### PTY agent (drive a terminal as the agent)

Registered from `src/lib/tools.ptyAgent.ts`.

| Name | Dangerous | Purpose |
|---|---|---|
| `pty_agent_open` | yes | Open a PTY with a shell or custom command |
| `pty_agent_send_line` | yes | Send a line + newline to the PTY |
| `pty_agent_wait_for` | no | Block until a regex matches the PTY buffer |
| `pty_agent_read_buffer` | no | Read the current accumulated buffer |
| `pty_agent_clear_buffer` | no | Truncate the buffer |
| `pty_agent_stop` | yes | Close the PTY |

These open **headless** PTYs the user never sees — good for installers,
REPLs, non-interactive automation, etc. When the agent should act on
the terminals **the user is actually looking at** (dashboard tiles or
the multi-terminal workspace overlay), use the `terminal_*` family
below instead.

### Terminals (user-facing, shared with the HUD)

Registered from `src/lib/tools.terminals.ts`. Self-registers on
`import './lib/tools.terminals'` from `src/App.tsx`. Every session is
addressed by a stable app-level id (`dash:shell`, `dash:agent`,
`dash:logs`, or `user:N` for overlay tiles); the backend PTY key is
nonce'd per mount and intentionally not exposed — it would go stale
between agent turns.

State for these tools lives in `src/store/terminals.ts`. Each terminal
carries a 64 KB ANSI-stripped output ring buffer (so the LLM doesn't
have to cope with escape codes), an auto-derived title + cwd pulled
from OSC 0/1/2 and OSC 7 sequences by `src/lib/ansiParse.ts`, and an
`activity_tick` that drives the overlay sidebar's "new activity" dot.

| Name | Dangerous | Purpose |
|---|---|---|
| `terminals_list` | no | Enumerate every visible terminal (dashboard + overlay) with id, origin, title, cwd, running-command hint, and buffered-byte count. Use the returned id with the other tools. |
| `terminal_spawn` | yes | Open a new tile in the multi-terminal workspace overlay. Opens the overlay automatically, focuses the new tile, and types an optional `command` once the PTY is ready. Returns the new stable id. |
| `terminal_send` | yes | Type text into a terminal as if the human had pressed those keys. `press_enter: true` (default) appends `\n`; `press_enter: false` sends raw bytes so you can inject Ctrl-C (`"\u0003"`), tab-completion, ANSI control sequences, etc. |
| `terminal_read` | no | Return the last N (default 2000, max 16000) ANSI-stripped chars of a terminal's output. Non-destructive — reading doesn't consume the buffer. |
| `terminal_wait_for` | no | Poll the output ring buffer every 80 ms with a JS regex until it matches or times out. Returns the first match offset and a 240-char excerpt. This is what makes `send → wait_for → read` a reliable workflow (no guessing at prompt-ready timings). |
| `terminals_focus` | no | Switch the overlay's focused tile and open the overlay if it's closed. Use after `terminal_send` when you want the user to watch the output live. |
| `terminal_close` | yes | Close an overlay terminal. Refuses to close dashboard terminals (`dash:*`) since they are permanent HUD tiles. |

**Typical agent workflow** (the AI equivalent of opening a terminal and
running a command):

```ts
// 1. Open a fresh tile in the workspace overlay.
terminal_spawn({ title: 'deploy', command: 'cd ~/proj && ./deploy.sh' });
// → { id: "user:4" }

// 2. Wait for the deploy script to finish or error out.
terminal_wait_for({
  id: 'user:4',
  pattern: '^(Deploy complete|Error)',
  timeout_sec: 120,
});
// → { matched: true, offset: 18320, match: "Deploy complete" }

// 3. Grab the tail to summarize for the user.
terminal_read({ id: 'user:4', tail_chars: 4000 });
```

### Claude Code (self-registering)

| Name | Dangerous | Purpose |
|---|---|---|
| `claude_code_run` | yes | Drive the `claude` CLI via PTY with prompt + auto-confirm rules |

## Composite tool timeouts

Every composite tool registered under `src-tauri/src/agent_loop/tools/composite/`
and the backing implementation files has an explicit wall-clock timeout (Phase 3
backfill). Key ceilings:

| Tool | Timeout |
|---|---|
| `deep_research` | 15 min overall; 5 min per worker; 2 min planner; 4 min aggregator |
| `claude_code_run` | 30 min overall; 10 min per `claude` CLI call; 2 min criteria check |

All other composites inherit the agent loop's `TOTAL_TIMEOUT_SECS = 120` ceiling
from `agent_loop/core.rs`, which wraps every `agent_run` invocation. No composite
tool can run silently forever.

## Adding a tool

### 1. In-tree (built-in)

For tools that should ship with SUNNY, add them to
`src/lib/tools/builtins/<domain>.ts` (or register via side-effect import
like `tools.filesys.ts` does).

```ts
// src/lib/tools/builtins/example.ts
import type { Tool } from '../types';
import { invokeSafe } from '../../tauri';

export const weatherTool: Tool = {
  schema: {
    name: 'weather_current',
    description: 'Current weather for a location.',
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
  run: async (input, signal) => {
    const started = Date.now();
    const loc = (input as { location?: string }).location ?? '';
    if (!loc) {
      return { ok: false, content: '"location" required', latency_ms: 0 };
    }
    if (signal.aborted) {
      return { ok: false, content: 'aborted', latency_ms: 0 };
    }
    const data = await invokeSafe('weather_current', { location: loc });
    return {
      ok: true,
      content: `Weather for ${loc}: ${JSON.stringify(data)}`,
      data,
      latency_ms: Date.now() - started,
    };
  },
};
```

Then register it in `src/lib/tools/builtins/index.ts` (or the
appropriate bundle file).

### 2. Via a skill

For user-added tools that shouldn't live in-tree, use a skill file — see
[`docs/SKILLS.md`](./SKILLS.md). `src/skills/example-weather.ts` is a
template.

### 3. Best practices

- **Namespace** user-added tool names: `skill.weather.current`,
  `custom.foo`, etc. Built-ins use bare names (`open_app`, `fs_list`)
  to match their Tauri commands.
- **Validate inputs defensively**. Treat `input` as `unknown`. Use the
  project's `requireString` / `isParseError` helpers in `tools/parse.ts`.
- **Honor `signal.aborted`** twice — once before async work, once after
  it returns.
- **Set `dangerous: true`** for any tool with user-visible side effects:
  shell, file writes, deletes, sends, UI automation.
- **Return `ok: false`** for expected failures; throw only for bugs.
  The registry wraps thrown errors in graceful `ok: false` results
  anyway, but the string you control will be clearer.
- **`content` is what the model sees next turn.** Keep it concise and
  informative. Big structured payloads belong in `data`, truncated in
  `content`.

### 4. Input schema conventions

We lean on JSON Schema to both constrain the model and validate inputs:

```ts
input_schema: {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path' },
    count: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['path'],
  additionalProperties: false,  // strict: reject unknown fields
}
```

`additionalProperties: false` is important — it catches the LLM passing
extra fields, which is a common failure mode that would otherwise be
silently ignored.

## Tool-call lifecycle

```
agent proposes { action: "tool", tool: "<name>", input: {...} }
    │
    ▼
TOOLS.get(name) → Tool | undefined
    │
    ├── undefined → tool_result err "Unknown tool 'X'"
    │                (helpful: lists available tools)
    │
    └── defined:
         │
         ▼
       constitution gate (layer 1) — hard rules
         │
         ▼
       if tool.dangerous:
         critic review (layer 2)
         ConfirmGate    (layer 3)
         │
         ▼
       executeTool(name, input, signal):
         start = Date.now()
         if signal.aborted: return aborted error
         try:
           result = await tool.run(input, signal)
           if signal.aborted: return aborted-after error
           return result
         catch err:
           return {
             ok: false,
             content: `Tool "X" threw: ${err.message}`,
             latency_ms: Date.now() - started,
           }
```

The try/catch in `executeTool` is the final backstop — no tool can
escalate an unexpected error into an unhandled rejection; the agent
always sees a graceful `ToolResult`.

### Telemetry on every call

Every executed call also fires a fire-and-forget telemetry write to
the `tool_usage` SQLite table — tool name, ok flag, latency, clipped
error message. This feeds:

- The Memory → Tools tab (success rate, p50/p95 latency, recent failures)
- The critic's "RECENT TOOL RELIABILITY (last 7d)" prompt block,
  which nudges the verdict toward `review` when a tool has a poor
  recent track record

Telemetry is best-effort: a missing Tauri backend or DB error is
silently dropped, never affecting the agent's visible result. See
[`docs/MEMORY.md`](./MEMORY.md#tool-usage-telemetry).

## Tools vs Tauri commands

Not every Tauri command is a tool:

| Exposed as a tool? | Examples |
|---|---|
| **Yes** | `open_app`, `run_shell`, `web_search`, `fs_list`, automation suite |
| **No — infrastructure** | `memory_pack`, `memory_stats`, `world_get`, `constitution_get`, `chat` |
| **No — UI-only** | `tray_set_status`, `notify_send`, `app_icon_png` |
| **No — dangerous primitives** | raw `memory_fact_add` (only consolidator/reflection write semantic) |

The policy: a command becomes a tool only if it's a capability we want
the agent to reach for directly, with an input schema the LLM can
reliably fill.

## Discoverability

The agent sees tool schemas as part of every system prompt's
`AVAILABLE TOOLS` section. Tool names can also be mined by:

- `pnpm dev`, then open `/capabilities` (Skills) module → shows all
  registered skills + their bundled tools
- Agent log panel shows every tool_call step in real time
- `src/pages/MemoryPage/InsightsTab.tsx` → Insights tab surfaces every
  `skill_fired` / `constitution_block` event

## Tool registration architecture

SUNNY's Rust side uses a single-layer dispatch table managed in `agent_loop/`.
The migration from the old `dispatch.rs` match table is complete: every tool
— including `spawn_subagent` — is registered via `inventory::submit!`.

### `ToolSpec` + `inventory::submit!`

Defined in [`src-tauri/src/agent_loop/tool_trait.rs`](../src-tauri/src/agent_loop/tool_trait.rs):

```rust
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: &'static str,   // JSON Schema literal
    pub required_capabilities: &'static [&'static str],
    pub trust_class: TrustClass,
    pub dangerous: bool,
    pub invoke: for<'a> fn(ToolCtx<'a>, Value) -> ToolFuture<'a>,
}
```

Tool modules under `agent_loop/tools/` call `inventory::submit!(ToolSpec { … })`
at link time. `tool_trait::find(name)` looks up the registered spec; there is
no legacy `match` fallback.

Advantages:
- **No `dispatch.rs` touch required** — new tools don't create merge conflicts.
- **Capability strings on the spec** — `trust_class`, `dangerous`, and
  `required_capabilities` live on the `ToolSpec` itself, so `catalog.rs`
  doesn't need parallel tables updated.

### Flow

```
dispatch_tool(name, input)
    │
    └── run_tool(name, input)
          │
          └── tool_trait::find(name) → Some(spec) → invoke(ctx, input)
                                     → None        → Err("unknown tool: <name>")
```

A name miss surfaces as an `unknown tool` error in the agent audit log.
There is no legacy match arm.

## Further reading

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — where tools sit in the L1 effector layer
- [`docs/SKILLS.md`](./SKILLS.md) — packaging tools into shareable skills
- [`docs/CONSTITUTION.md`](./CONSTITUTION.md) — how prohibitions gate tool calls
- [`src/skills/README.md`](../src/skills/README.md) — hands-on authoring guide
