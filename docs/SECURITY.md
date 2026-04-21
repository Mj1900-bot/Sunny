# Security

Sunny runs with Full Disk Access, Accessibility, Automation (AppleScript /
System Events), Screen Recording, Microphone, Contacts, Calendar,
Reminders, a Keychain-backed vault, and a ReAct agent that can shell
out, fetch URLs, open apps, send iMessages, and spawn sub-agents. That
is a lot of capability to attach to a single binary. The
[`src/pages/SecurityPage`](../src/pages/SecurityPage/) module (distinct
from the on-demand virus scanner under SCAN) exists so you can see,
record, and — when something goes wrong — cut off every one of those
powers in one click.

This document describes the threat model, the watchers, the panic
kill-switch, the audit log, and the Phase 2/3 hardening roadmap.

---

## Threat model

The live security module is designed against the following adversaries.
It is **not** a replacement for kernel-level EDR, XProtect, or
Little Snitch — those remain macOS's job.

### 1. Remote attacker via prompt injection

A web page, email, or file feeds the agent hidden instructions that
attempt to exfiltrate secrets, screen pixels, or contacts via
"innocent" tool calls (`web_fetch`, `mail_send`, `imessage_send`,
`messaging_send_sms`, `notes_append`). This is the most likely attack
vector on an agentic app.

**What we do today**: every tool call — including the input preview,
agent identity, outcome, and duration — is emitted to
[`src-tauri/src/security/`](../src-tauri/src/security/), visible on
the Overview / Agent Audit tabs, and persisted to
`~/.sunny/security/events.jsonl`. Every outbound HTTP request is also
logged with host, path prefix, initiator (`agent:main` /
`agent:sub:<role>:<id>` / `unknown`), bytes, and duration. Dangerous
tools (`mail_send`, `imessage_send`, `calendar_create_event`, `notes_*`,
`app_launch`, `shortcut_run`, `browser_*`, `scheduler_add`, etc.) still
require the user's confirm-gate approval.

**What we don't do yet**: the agent can still reach any public host
subject to the existing SSRF block (private IPs refused) — see
Phase 2 for a positive egress allowlist. Prompts aren't scrubbed
before going to cloud LLM providers either — Phase 2 again.

### 2. Malicious local process

An unrelated process on your Mac drops a LaunchAgent / LaunchDaemon to
persist, adds a login item, or spawns an unsigned binary that attaches
itself to an existing TCC grant.

**What we do today**:

- On first launch we snapshot
  `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`
  to `~/.sunny/security/launch_baseline.json` with SHA-1 of each plist
  body. Every 15 s thereafter we rescan and emit
  `SecurityEvent::LaunchAgentDelta` on any add / change / remove. New
  plists in the user dir are raised to `Warn`.
- Every 30 s we probe the current login-items list via System Events
  (AppleScript) and emit `LoginItemDelta` on any add / remove.
- The codesign tripwire verifies any binary Sunny is about to launch
  via `control::open_path`; failures raise `UnsignedBinary` events.
- The TCC permission grid is re-probed every 10 s; any bit flipping
  (Accessibility revoked, Screen Recording denied, etc.) emits a
  `PermissionChange` event.

**What we don't do**: kernel-level process monitoring. We only see
what Sunny itself can see via user-space APIs.

### 3. Compromised / swapped agent config

`AGENTS.md`, `.cursorrules`, `.claude/…`, `.codex/…` tell the agent how
to behave. A malicious edit could redirect tool use, add an MCP server,
or whitelist unusual egress.

**What we do today**: the on-demand SCAN module has an "AGENT CONFIGS"
preset that walks those directories + the LaunchAgents/Daemons tree
and flags known-bad patterns (OWASP LLM01, prompt injection) against
the curated signature database in
[`src-tauri/src/scan/signatures.rs`](../src-tauri/src/scan/signatures.rs).

**What we don't do**: continuous monitoring of config files. Run the
AGENT CONFIGS preset from the SCAN page after any unattended pull.

### 4. Accidental leakage

Screen pixels, clipboard contents, iMessage transcripts, or email
bodies shipped to a cloud LLM provider without realizing it.

**What we do today**: the Network tab shows exactly where every byte
is going; the Agent Audit tab shows the redacted input preview of
every tool call (so you can tell whether a `web_fetch` or `mail_send`
was run with sensitive input). Secrets `resolve()` emits a
`SecretRead` event with the provider id (no value) so you can confirm
which keys the agent reached for during a given run.

**What we don't do**: pre-send prompt redaction. Phase 2.

### 5. User mistake

You approve a dangerous confirm-gate without understanding the payload.

**What we do today**: the confirm-gate preview shows the tool name
and compacted args; the post-dispatch audit row shows the full
redacted input so you can double-check in the Audit Log tab.

**What we could do**: require two-factor confirm for a small set of
tier-0 tools (`mail_send`, `messaging_send_sms`, `calendar_create_event`),
with a typed keyword confirmation. Tracking in Phase 3.

---

## Architecture

Everything routes through a single `SecurityBus`
([`src-tauri/src/security/mod.rs`](../src-tauri/src/security/mod.rs)):

- Producers: `agent_loop::dispatch::dispatch_tool`,
  `agent_loop::confirm`, `http::send`, `secrets::resolve`, and the
  background watchers under
  [`src-tauri/src/security/watchers/`](../src-tauri/src/security/watchers/).
- Store: an in-process ring buffer (2000 entries) + a JSONL file at
  `~/.sunny/security/events.jsonl` (rotated at 10 MB, one `.prev`
  generation retained).
- Policy loop: subscribes to the bus, computes a per-bucket severity
  summary (`AGENT / NET / PERM / HOST`) over a sliding 2-minute
  window, and broadcasts `sunny://security.summary` to the frontend at
  most twice per second.
- Panic: `security_panic` sets a shared flag (`panic_mode`) that
  `dispatch_tool` and `http::send` read on every call. While engaged:
  every tool short-circuits to a structured error, every outbound
  request is refused, and every daemon is disabled. `security_panic_reset`
  clears the flag but daemons stay disabled — re-enable them from AUTO.

### Event shape

Every emission is a tagged enum (`SecurityEvent`). Canonical JSON
fields live in
[`src/pages/SecurityPage/types.ts`](../src/pages/SecurityPage/types.ts).

### Redaction

Before any event leaves Rust, `security::redact::scrub_event` strips:

- API-key-like prefixes (`sk-ant-…`, `sk-proj-…`, `sk-or-…`, `sk-…`,
  `xoxb-…`, `ghp_…`, `github_pat_…`, `AIza…`, `AKIA…`, `ASIA…`),
- `Bearer` / `Token` / `Authorization: …` header patterns,
- JWTs (three base64url segments),
- hex runs of 32+ chars,
- email addresses,
- 11+ digit runs.

All matches become `***`. 17 unit tests in `redact.rs` guard the
regex set — extend them if you add a new class.

---

## Panic kill-switch

When you hit PANIC (nav-strip button, Overview button, or `!` hotkey
on the Security page — full key list in [`SHORTCUTS.md`](./SHORTCUTS.md)):

1. `security::panic::engage` sets the shared `panic_mode` flag.
2. `daemons::disable_all` flips every daemon to `enabled=false` and
   clears their `next_run` — the React-side daemon runtime stops
   polling them.
3. A `SecurityEvent::Panic` is emitted with the reason string
   (user-supplied or the default `"user-requested"`).
4. Every subsequent call into `agent_loop::dispatch::dispatch_tool`
   short-circuits with a `panic_mode` error before the tool runs.
5. Every subsequent call into `http::send` short-circuits with a
   refused connection before the actual egress.

Release is explicit: you hit the `◎ RELEASE PANIC` button on the
Overview tab or `P` on the Security page. Daemons remain disabled —
re-enable them deliberately from the AUTO page. This is the whole
point: the panic button is the button you're supposed to press when
you're not sure what Sunny is doing, and resuming should be a
considered act.

---

## Process budget (Phase 5)

SUNNY has broad authority to spawn child processes — PTY shells,
`claude_code_run`, `py_run`, `osascript`, AppleScript, sandbox
interpreters. The panic kill-switch covers the *user-initiated* abort
path. The process budget covers the path where nobody gets to press
panic — a runaway daemon, a mis-scoped `schedule_recurring`, an agent
fan-out that escalates faster than the operator can react.

The design assumption is simple: **SUNNY should be incapable of
exhausting the user's uid-wide process table, even under worst-case
adversarial prompting**. `kern.maxprocperuid` on Apple Silicon defaults
to ~1418; once that's hit, every `fork(2)` for the uid fails with
`EAGAIN` — including Terminal.app launching a login shell — and only
logout or reboot clears it.

### Five-layer defence

1. **Hard floor — `RLIMIT_NPROC`.** At startup,
   `process_budget::install_rlimit()` lowers SUNNY's soft `RLIMIT_NPROC`
   to `NPROC_CEILING = 1024`. SUNNY forks fail inside SUNNY when its
   own process count hits 1024 — well before the uid ceiling — so
   Terminal.app still has ~400 slots.
2. **Global semaphore — `SPAWN_PERMITS = 16`.** `SpawnGuard::acquire().await`
   gates high-risk spawn sites (the `scheduler::Speak` branch, the
   `claude_code` bridge). Acquire blocks up to 30s, then surfaces a
   structured "spawn budget exhausted" error that the LLM can reason
   about. `spawn_budget_snapshot()` reports current usage for
   diagnostics.
3. **Per-surface caps.** `daemons::MAX_ENABLED_DAEMONS = 32` on active
   daemon count; `daemons::MIN_INTERVAL_SECS = 60` (mirrored in the
   `schedule_recurring` tool as `MIN_CADENCE_SECS = 60`) rejects sub-
   minute cadence; `pty::MAX_PTY_SESSIONS = 16` on open terminals;
   `agent_loop::subagents::MAX_LIVE_SIBLINGS = 4` on concurrent children
   per parent agent (breadth cap complementing the existing
   `MAX_SUBAGENT_DEPTH = 3`).
4. **Zombie reap.** `scheduler::run_action`'s `Speak` branch now
   acquires a spawn permit, sets `Command::kill_on_drop(true)`, and
   detaches a waiter that awaits `child.wait()` so the process-table
   slot returns on completion. Previously the `say` subprocess was
   fire-and-forget (tokio#2685 zombie pattern).
5. **Crash quarantine.** `boot_guard::arm()` writes
   `~/.sunny/booting.marker` at startup; the Tauri `RunEvent::Exit`
   handler calls `boot_guard::disarm()` to remove it. If the marker
   survives into the next boot (crash, SIGKILL, force-quit),
   `daemons::quarantine_on_disk()` loads every daemon with
   `enabled=false` and `last_status="quarantined_on_boot"`. Panic mode
   handles user-initiated kill; the quarantine handles the "no human
   in the loop" case.

### Sources

| Layer | File | Constant / function |
|---|---|---|
| 1 | `src-tauri/src/process_budget.rs` | `NPROC_CEILING`, `install_rlimit` |
| 2 | `src-tauri/src/process_budget.rs` | `SPAWN_PERMITS`, `SpawnGuard::acquire` |
| 3 | `src-tauri/src/daemons.rs` | `MAX_ENABLED_DAEMONS`, `MIN_INTERVAL_SECS` |
| 3 | `src/lib/tools/builtins/daemon.ts` | `MIN_CADENCE_SECS` |
| 3 | `src-tauri/src/pty.rs` | `MAX_PTY_SESSIONS` |
| 3 | `src-tauri/src/agent_loop/subagents.rs` | `MAX_LIVE_SIBLINGS` |
| 4 | `src-tauri/src/scheduler.rs` | `run_action` Speak branch |
| 4 | `src-tauri/src/agent_loop/tools/dev_tools/bridges/claude_code.rs` | `launch` |
| 5 | `src-tauri/src/boot_guard.rs` | `arm`, `disarm`, `BootState` |
| 5 | `src-tauri/src/daemons.rs` | `quarantine_on_disk` |

### Recovery without reboot

Should `fork: Resource temporarily unavailable` ever surface anyway
(e.g. a user who had SUNNY plus a parallel workload before the Phase 5
ceiling was installed), run from any surviving shell (iTerm tab, VS
Code terminal, `ssh` from another device):

```bash
sudo sysctl -w kern.maxprocperuid=4096 kern.maxproc=5000
pkill -9 -f "Sunny"; pkill -9 -f "claude"; pkill -9 -f "osascript"
sleep 3 && ps -u "$USER" | wc -l
```

To make the raised kernel ceiling persist across reboots, append to
`/etc/sysctl.conf`:

```
kern.maxproc=5000
kern.maxprocperuid=4096
```

---

## Audit log

- In-memory ring buffer: last 2000 events.
- File: `~/.sunny/security/events.jsonl` (one JSON per line), rotated
  at 10 MB with a single `.prev` generation kept.
- Each line is flushed synchronously — a crash can lose at most the
  most recent event.
- Export: the AUDIT LOG tab's "EXPORT JSONL" button copies the current
  file to `~/Desktop/sunny-security-audit-<timestamp>.jsonl`.

### Rotation semantics

At each push we check the current file size; if it's past 10 MB we
release the writer, rename it to `events.jsonl.prev`, and let the
next push re-open a fresh file. No cross-session log aggregation
beyond that.

---

## Phase 2 — proactive detection (SHIPPED)

All built in the live runtime and flowing into the Security page tabs.

1. **Ingress prompt-injection scanner**
   ([`src-tauri/src/security/ingress.rs`](../src-tauri/src/security/ingress.rs)).
   Every piece of external text about to enter the LLM context is
   run against:
   - `scan::signatures` PromptInjection + AgentExfil patterns,
   - invisible-Unicode / BIDI / zero-width smuggling detector,
   - typoglycemia + jailbreak-marker heuristic (`ignore all previous
     instructions`, `ignroe…`, `you are dan`, `<|system|>`, …),
   - long-base64 / hex blob heuristic (≥ 1024-char continuous run).

   Wired into `web_fetch` result path and `clipboard_history` tool
   dispatch. Emits `SecurityEvent::PromptInjection` at
   Info/Warn/Crit depending on the worst pattern weight. Aligned
   with OWASP LLM01 2025 guidance on direct + indirect injection.

2. **Canary / honeypot token**
   ([`src-tauri/src/security/canary.rs`](../src-tauri/src/security/canary.rs)).
   On startup we mint a distinctive fake API key
   (`sk-canary-<uuid>`), persist it at
   `~/.sunny/security/canary.txt` (0600), export it as
   `SUNNY_CANARY_TOKEN`, and have `http::send` scan every outbound
   URL for it. If the token ever appears in an egress payload —
   that's a confirmed exfiltration attempt (no legitimate code path
   sends it anywhere) — we emit `CanaryTripped` and auto-engage
   panic mode. Adapted from the AgentSeal "regression canary" +
   classic honeypot-token pattern.

3. **Per-tool rate anomaly detection**
   ([`src-tauri/src/security/behavior.rs`](../src-tauri/src/security/behavior.rs)).
   Rolling 15-minute per-tool call history. Current-rate is derived
   over the last 60 s; baseline is the per-minute mean across the
   window (zero-padded bins so a burst after a long idle flags).
   Fires `ToolRateAnomaly` when:
   - rate ≥ 5 × baseline AND > 8 calls/min, or
   - ≥ 20 calls in 10 s (Crit), or
   - z-score ≥ 3.0 AND rate > 3 calls/min, or
   - ≥ 10 calls in 10 s (Warn burst).

   Rate-limited to one emit per tool per 30 s so a runaway model
   can't saturate the audit log.

4. **System-integrity poller**
   ([`src-tauri/src/security/integrity.rs`](../src-tauri/src/security/integrity.rs)).
   Every 2 min: `csrutil status` (SIP), `spctl --status`
   (Gatekeeper), `fdesetup status` (FileVault),
   `defaults read …/com.apple.alf globalstate` (Application
   Firewall), `codesign --verify --deep --strict` on the Sunny
   bundle itself, `profiles list/status` (MDM / configuration
   profiles). Diffs emit `IntegrityStatus` events; the UI renders
   the current state on the Overview strip + the SYSTEM tab.

5. **Active connections snapshot**
   ([`src-tauri/src/security/connections.rs`](../src-tauri/src/security/connections.rs)).
   `lsof -iP -n -a -p <pid>` parsed into a typed list, refreshed
   every 15 s on the SYSTEM tab.

6. **File integrity monitor**
   ([`src-tauri/src/security/fim.rs`](../src-tauri/src/security/fim.rs)).
   SHA-256 hashes of `~/.sunny/settings.json`, `constitution.json`,
   `daemons.json`, `scheduler.json`, `world.json`,
   `security/canary.txt`, `security/launch_baseline.json`.
   Re-hashed every 30 s; any change emits
   `FileIntegrityChange`. Baseline persisted at
   `~/.sunny/security/fim_baseline.json`.

7. **Threat score + live charts**.
   [`security/policy.rs`](../src-tauri/src/security/policy.rs) now
   computes a 0–100 composite score (panic_mode = 100) and per-minute
   buckets for the last 60 min (events, tool calls, egress bytes) +
   top-hosts rollup. Drives the big radial gauge on Overview and
   the nav-strip indicator colour.

## Phase 3 — hard enforcement (SHIPPED)

All live, persistent, and user-configurable from the new POLICY tab.

1. **Persistent enforcement policy**
   ([`src-tauri/src/security/enforcement.rs`](../src-tauri/src/security/enforcement.rs)).
   Struct with `egress_mode`, `allowed_hosts`, `blocked_hosts`,
   `disabled_tools`, `force_confirm_all`, `scrub_prompts`,
   `subagent_role_scoping`. Stored at
   `~/.sunny/security/policy.json` (0600). Every mutation emits a
   Notice event so the audit log carries a record of every policy
   change.
2. **Egress allowlist / blocklist enforcement** — `http::send`
   consults `egress_verdict(host, initiator)`. In `Block` mode,
   agent-initiated requests to hosts not on the allowlist are refused
   with a `blocked=true` NetRequest event + a deterministic
   connect-refused failure to the caller. Non-agent egress (scanner,
   provider bootstrap, weather, login flow) is unaffected. Hosts can
   be exact (`api.anthropic.com`) or suffix (`.anthropic.com`).
3. **Rust-side constitution** — `dispatch_tool` now calls
   `constitution::current().check_tool()`. Closes the drift flagged
   in the original audit: the Rust ReAct path now respects the same
   prohibitions as the TS agent loop (time windows, match_input,
   per-tool denies).
4. **Force-confirm-all** — when set, every tool dispatch (not just
   `is_dangerous` ones) routes through `request_confirm`. Useful
   while reviewing an unfamiliar automation.
5. **Pre-send prompt redaction** — Anthropic + GLM providers walk
   the outgoing system prompt + history JSON tree and scrub every
   string leaf through the Phase-1 redaction regex pack (API keys,
   bearer headers, JWTs, long hex, emails, long digit runs). Opt-out
   via `scrub_prompts=false`. Ollama skipped (local — no leak risk).
6. **Hash-chained audit log** — every JSONL line is now
   `{"h":"<sha256(prev_h || body)>","e":<event>}`. The `SecurityStore`
   tail-reads the last line on install so the chain survives restarts
   (even if the app process died mid-write). Tamper-evidence without
   a signature: a post-hoc edit invalidates the chain for every line
   after it, making deletion / insertion detectable by re-running the
   hash.
7. **Sub-agent role scoping**
   ([`src-tauri/src/agent_loop/scope.rs`](../src-tauri/src/agent_loop/scope.rs)).
   `spawn_subagent` wraps each sub-agent run in a `tokio::task_local`
   scope carrying a role-appropriate tool allowlist. `dispatch_tool`
   refuses anything not in the set when policy is on. Roles:
   - `summarizer` / `writer` / `critic` — base + reading tools
   - `researcher` — base + reading + web + `spawn_subagent`
   - `coder` — researcher + `py_run` + `claude_code_supervise`
   - `browser_driver` — base + reading + browser tools + web
   - `planner` — base + reading + web + `spawn_subagent`
   - Unknown role — falls back to read-only.
8. **DNS tunnelling heuristic**
   ([`src-tauri/src/security/egress_monitor.rs`](../src-tauri/src/security/egress_monitor.rs)).
   60-second sliding window of outbound hosts grouped by apex. Any
   apex with ≥ 30 distinct sub-labels OR a single label > 60 chars
   within the window emits a Warn Notice — the canonical shape of
   iodine / dnscat2 / base64-chunk exfil channels. Cooldown 60 s
   per apex so legit CDN fan-out doesn't spam.
9. **Screen-capture → egress correlator**. When `dispatch_tool` sees
   any of `screen_capture_full` / `screen_ocr` / `remember_screen` /
   `ocr_full_screen` / `ocr_region`, it stamps a timestamp. A
   subsequent agent-initiated request within 30 s to a host that
   isn't a known LLM provider emits a `screen_exfil_suspect` Warn.
10. **Burst-bytes detector** — cumulative egress ≥ 20 MB in 60 s
    (agent-initiated) emits a Warn Notice with the recent host.
11. **Sunny descendant process watcher**
    ([`src-tauri/src/security/watchers/process_tree.rs`](../src-tauri/src/security/watchers/process_tree.rs)).
    Every 10 s, `sysinfo` gives us the live process table; we DFS
    from Sunny's PID and emit Notice events for new descendants +
    fire the codesign tripwire for their executable paths.

## Phase 4 — pre-dispatch scanners + forensics (SHIPPED)

1. **Outbound content scanner**
   ([`src-tauri/src/security/outbound.rs`](../src-tauri/src/security/outbound.rs)).
   Scans every `mail_send` / `imessage_send` / `messaging_send_sms` /
   `messaging_send_imessage` / `notes_create` / `notes_append` /
   `calendar_create_event` / `scheduler_add` payload BEFORE the
   ConfirmGate modal opens. 9 detectors run per outbound message:
   - canary token (auto-panic, hard-block the send)
   - anthropic / openai / github / bearer / jwt / long-hex
   - SSH private key PEM header (Crit)
   - BIP-39-shaped 12/15/18/21/24-word seed phrases (Crit)
   - email clusters (>=2 distinct)
   - invisible-Unicode runs
   - long base64 blobs
   
   Findings are appended to the ConfirmGate preview as
   `[SCAN/<severity>: <kinds>]` so the user can reject with full
   context. Canary hits hard-block without the modal.

2. **Dangerous-shell detector**
   ([`src-tauri/src/security/shell_safety.rs`](../src-tauri/src/security/shell_safety.rs)).
   `run_shell` invocations are scanned against three regex sets:
   - **Absolute blocks** (refused before ConfirmGate): fork bombs,
     `rm -rf /`, `dd if=/dev/zero of=/dev/disk…`, `>/dev/sd[a-z]`,
     `mkfs.*`, `diskutil secureErase`, `chmod -R 777 /`,
     `chown -R … /`.
   - **Warn** (surfaced in preview): `curl|sh`, `wget|sh`, base64-
     to-shell, bash reverse-TCP, netcat backconnects, python/perl
     reverse shells, chisel/ngrok/frpc/gost tunnels, launchctl
     plist load, osascript `do shell script` escape, keychain
     dump, `pbpaste | curl`, IFS/hex-escape obfuscation.
   - **Info** (logged): long base64 args, `/dev/tcp/` redirects,
     removing Gatekeeper quarantine, disabling SIP.

3. **Per-tool daily quotas**
   ([`security::enforcement`](../src-tauri/src/security/enforcement.rs)).
   Each `tool_quotas` entry caps calls per local day; exceeding
   returns `Err("quota exceeded")` from `dispatch_tool`. Defaults:
   mail_send=20, imessage=50, sms=30, calendar_create_event=20,
   notes_create=30, notes_append=50, reminders_add=30,
   scheduler_add=10, app_launch=40, shortcut_run=20,
   browser_open=60, run_shell=40. Fully editable via POLICY tab.
   Resets at local midnight.

4. **Incident response bundles**
   ([`src-tauri/src/security/incident.rs`](../src-tauri/src/security/incident.rs)).
   `panic::engage` spawns a background capture that writes a
   self-contained forensic JSON to
   `~/.sunny/security/incidents/incident-<iso>.json` (0600). The
   bundle includes: last 500 events, current summary, full integrity
   grid, active policy, canary status, lsof connections,
   descendant process tree, per-tool rates, FIM baseline, and
   bundle identity. Manual "Capture now" button on the SYSTEM tab
   for pre-incident baselines.

5. **XProtect posture probe**
   ([`src-tauri/src/security/xprotect.rs`](../src-tauri/src/security/xprotect.rs)).
   Reads
   `/Library/Apple/System/Library/CoreServices/XProtect.bundle`
   to surface Apple's YARA engine version, rule count, rules file
   size, and a SHA-256 fingerprint. Shown on the SYSTEM tab so
   users see how many independent signature detectors are covering
   them (Apple + Sunny's own DB + MalwareBazaar/VT on demand).

6. **Behavior baseline persistence** — `behavior.rs` now persists
   per-tool call-timestamp history to
   `~/.sunny/security/behavior_baseline.json` every 2 min. On
   restart, timestamps younger than the 15-minute window are
   restored so z-score + rate anomaly detection has a warm baseline
   immediately instead of needing 5 samples from scratch.

7. **Event-type breakdown** on Overview — horizontal bar chart
   showing event counts grouped by kind, coloured by the worst
   severity observed for each kind. Sits beside the top-hosts
   rollup so you can spot unusual activity patterns at a glance.

## Phase 5 — further hardening (roadmap)

- **ed25519-signed audit log** — per-install key in Keychain, sign
  the chain head every N lines so even a root user can't forge
  entries without stealing the signing key.
- **Outbound body canary scan** — scan streaming request bodies
  for the canary, not just URLs. Requires a wrapper around the
  reqwest Body type.
- **Unified path policy** — merge `filesys.rs` + `safety_paths.rs`.
- **MCP allowlist** — when the MCP client lands, gate which servers
  any given sub-agent role can talk to.
- **Real-time threat feed** — subscribe to MalwareBazaar's daily
  SHA-256 list + auto-block matching file sends.
- **Geo-based egress flagging** — pair host names with IP/CC geo
  lookup + flag requests leaving the user's country.
- **Inbound secret redaction** — the ingress scanner currently
  records hits; next step is to replace detected secrets with
  placeholders before the text enters the LLM context so an
  injected prompt can't leak what it's looking at.

---

## Not doing

- **Kernel EDR** — out of scope for a Tauri app; would require a
  system extension.
- **A replacement firewall** — the panic button refuses egress *from
  Sunny*. Other processes on your Mac are PF / Little Snitch's job.
- **Signature-based AV at kernel level** — complements XProtect /
  MalwareBazaar; doesn't replace it.

---

## File map

| File                                                                              | Purpose                                         |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| [`src-tauri/src/security/mod.rs`](../src-tauri/src/security/mod.rs)               | Bus, event types, install, panic-mode flag.     |
| [`src-tauri/src/security/store.rs`](../src-tauri/src/security/store.rs)           | Ring buffer + JSONL writer + rotation.          |
| [`src-tauri/src/security/redact.rs`](../src-tauri/src/security/redact.rs)         | Secret scrubbing regex pack (17 tests).         |
| [`src-tauri/src/security/policy.rs`](../src-tauri/src/security/policy.rs)         | Summary aggregator + threat score + minute buckets. |
| [`src-tauri/src/security/panic.rs`](../src-tauri/src/security/panic.rs)           | Kill-switch engage / release.                   |
| [`src-tauri/src/security/canary.rs`](../src-tauri/src/security/canary.rs)         | Honeypot token mint + leak detector.            |
| [`src-tauri/src/security/ingress.rs`](../src-tauri/src/security/ingress.rs)       | Prompt-injection / agent-exfil ingress scanner. |
| [`src-tauri/src/security/behavior.rs`](../src-tauri/src/security/behavior.rs)     | Per-tool rolling rate + anomaly detection.      |
| [`src-tauri/src/security/integrity.rs`](../src-tauri/src/security/integrity.rs)   | SIP / Gatekeeper / FileVault / Firewall / bundle / profiles. |
| [`src-tauri/src/security/connections.rs`](../src-tauri/src/security/connections.rs) | Active `lsof` socket snapshot.                 |
| [`src-tauri/src/security/fim.rs`](../src-tauri/src/security/fim.rs)               | File integrity monitor for `~/.sunny/*`.         |
| [`src-tauri/src/security/commands.rs`](../src-tauri/src/security/commands.rs)     | 34 Tauri command wrappers.                     |
| [`src-tauri/src/security/enforcement.rs`](../src-tauri/src/security/enforcement.rs) | Persistent policy + egress / tool verdicts + quotas. |
| [`src-tauri/src/security/egress_monitor.rs`](../src-tauri/src/security/egress_monitor.rs) | DNS-tunnelling + screen-exfil + burst detectors. |
| [`src-tauri/src/security/outbound.rs`](../src-tauri/src/security/outbound.rs)     | Outbound message / note content scanner.        |
| [`src-tauri/src/security/shell_safety.rs`](../src-tauri/src/security/shell_safety.rs) | Dangerous-shell pattern detector (hard-block + warn + info). |
| [`src-tauri/src/security/incident.rs`](../src-tauri/src/security/incident.rs)     | Panic-time forensic bundle writer.             |
| [`src-tauri/src/security/xprotect.rs`](../src-tauri/src/security/xprotect.rs)     | Apple XProtect YARA version / rule-count probe. |
| [`src-tauri/src/agent_loop/scope.rs`](../src-tauri/src/agent_loop/scope.rs)         | Sub-agent role scoping via task-local.          |
| [`src-tauri/src/security/watchers/process_tree.rs`](../src-tauri/src/security/watchers/process_tree.rs) | sysinfo-based Sunny-descendant PID watcher. |
| [`src-tauri/src/security/watchers/launch_agents.rs`](../src-tauri/src/security/watchers/launch_agents.rs) | LaunchAgent / Daemon diff watcher.  |
| [`src-tauri/src/security/watchers/login_items.rs`](../src-tauri/src/security/watchers/login_items.rs) | Login-items diff watcher (AppleScript). |
| [`src-tauri/src/security/watchers/codesign.rs`](../src-tauri/src/security/watchers/codesign.rs) | Codesign verify tripwire.                     |
| [`src-tauri/src/security/watchers/perm_poll.rs`](../src-tauri/src/security/watchers/perm_poll.rs) | TCC permission grid + 10 s poller.          |
| [`src/components/SecurityLiveStrip.tsx`](../src/components/SecurityLiveStrip.tsx) | Nav-strip widget: threat score + sparkline + panic. |
| [`src/pages/SecurityPage/viz.tsx`](../src/pages/SecurityPage/viz.tsx)             | Threat gauge, sparklines, timeline, host flow. |
| [`src/pages/SecurityPage/SystemTab.tsx`](../src/pages/SecurityPage/SystemTab.tsx) | Bundle / integrity / canary / connections / FIM / tool rates. |
| [`src/pages/SecurityPage/`](../src/pages/SecurityPage/)                           | Nine-tab module (Overview, Policy, Agent, Network, Perms, Intrusion, Secrets, System, Audit). |

---

## Data locations

| Path                                  | What                                         |
| ------------------------------------- | -------------------------------------------- |
| `~/.sunny/security/events.jsonl`       | Append-only audit log; rotates at 10 MB.     |
| `~/.sunny/capability_denials.log`      | Capability-grant denial log; rotates at 4 MiB. |
| `~/.sunny/capability_denials.log.old`  | Previous generation of the denial log.          |
| `~/.sunny/security/events.jsonl.prev`  | Previous generation.                         |
| `~/.sunny/security/launch_baseline.json` | SHA-1 + mtime snapshot of every launch plist. |
| `~/.sunny/security/fim_baseline.json`  | SHA-256 + size snapshot of tracked `~/.sunny` configs. |
| `~/.sunny/security/canary.txt`         | Honeypot token (0600). Value = tripwire string. |
| `~/.sunny/security/policy.json`        | Persistent enforcement policy (0600).         |
| `~/.sunny/security/behavior_baseline.json` | Per-tool call timestamps (15-min window) for anomaly detection. |
| `~/.sunny/security/incidents/`         | Forensic bundles captured on panic (0600 each). |
| `SUNNY_CANARY_TOKEN` env var           | Same token, exposed to the process env so agent env-dumps include it. |
| macOS Keychain (`sunny-<provider>-api-key`) | Provider API keys. Never in logs.         |
| macOS Keychain (`sunny.<uuid>`)        | Vault items. Metadata only in `~/.sunny/vault_index.json`. |

## Canary token system

The canary system is the primary defense against confirmed exfiltration. It
operates across startup, outbound scanning, and clipboard/HTTP monitoring.

### Startup

`security::canary` mints a distinctive fake API key (`sk-canary-<uuid>`) on
first launch, persists it to `~/.sunny/security/canary.txt` (mode 0600) as
`{template_idx}:{token}`, and exports the token as the `SUNNY_CANARY_TOKEN`
environment variable so it appears in any agent-initiated `env` dump without
pointing to real credentials.

**Sentinel label rotation (Phase 3).** The string injected into every system
prompt uses one of four templates (`SENTINEL_TEMPLATES[0..3]`), selected
at install time from `uuid_byte_0 % 4` and kept stable for the session. All
four templates contain "PRIVILEGED_CONTEXT" and "root API credential" so
detection assertions remain valid regardless of which template is active.
Detection scans for the UUID token value, not the label — rotation defeats
models fine-tuned to elide a single specific label string.

### Sentinel injection

The canary string is injected into the system prompt assembled by
`agent_loop::core` so every LLM turn can see it — a prompt-injection attack
that forces the model to send the string back out is immediately detectable.

### Detection

Three independent detectors watch for the token:

| Where | Detector | Action on hit |
|---|---|---|
| Outbound HTTP URLs | `http::send` pre-flight | `CanaryTripped` event + auto-engage panic |
| Outbound message/note content | `security::outbound::scan_outbound` | Hard-block before ConfirmGate; auto-panic |
| Clipboard | `clipboard_history` tool dispatch ingress scanner | `CanaryTripped` Crit event |

### Panic-mode trip

Any detection auto-calls `panic::engage("canary_tripped")`, which:
1. Sets the shared `panic_mode` flag — all subsequent tool calls and HTTP
   requests are refused.
2. Disables all daemons.
3. Writes a `SecurityEvent::Panic` to the audit log and the in-memory ring.
4. Spawns an incident-response bundle at
   `~/.sunny/security/incidents/incident-<iso>.json`.

Release is deliberate — hit `◎ RELEASE PANIC` on the Overview tab.

---

## GRANTS tab (Security page)

The **GRANTS** tab (hotkey `0` on the Security page) is the read-only UI
for the capability grant policy stored in `~/.sunny/grants.json`. It shows:

- **Grant Policy** — every `initiators` entry with its capability string list,
  colour-coded to distinguish memory/network/compute/app grants.
- **Default sub-agent grants** — the `default_for_sub_agents` fallback applied
  to any `agent:sub:*`, `agent:daemon:*`, or `agent:scheduler` initiator not
  explicitly listed.
- **Denial audit** — the most recent rows from `~/.sunny/capability_denials.log`
  (via `capability_tail_denials`), with initiator, tool, missing capability,
  and timestamp. Use this to diagnose unexpected sub-agent blocks.

### Denial log rotation

`capability_denials.log` rotates at **4 MiB** (`MAX_DENIAL_LOG_BYTES =
4 * 1024 * 1024`). When a denial write would push the file past the threshold,
`capability.rs` renames the current file to `capability_denials.log.old` and
opens a fresh log. One previous generation is retained; older generations are
discarded. `tail_denials` refuses to slurp a file larger than twice the limit
(a corruption guard for files that escaped rotation in a previous session) and
returns an empty slice in that case — the GRANTS tab shows no rows rather than
exhausting RAM.

This rotation is distinct from the `events.jsonl` rotation (which triggers at
10 MB). The two logs have different write rates: denial events fire only on
blocked sub-agent calls, while security events fire on every tool call and
network request.

Edit `~/.sunny/grants.json` directly to add or modify grants; changes are
picked up within the mtime-check interval without restarting SUNNY. See
[`docs/CAPABILITIES.md`](./CAPABILITIES.md) for the full schema.

> **Editing config files from the webview?** Use the `open_sunny_file(filename)`
> Tauri command (`commands/fs.rs`) rather than `open_path`. It accepts only a
> bare filename (no `/`, `\`, or `..`), resolves to `~/.sunny/<filename>`, and
> validates via `assert_read_allowed` before handing off to `open`. This is the
> safe surface for any webview-initiated edits of `~/.sunny/` config files.

---

## See also

- [`PAGES.md`](./PAGES.md) — HUD map; the live module is the **`security`** page (not **Scan**).
- [`SCAN.md`](./SCAN.md) — separate on-demand malware scanner, quarantine vault, and signatures.
- [`README.md`](../README.md) — product overview and privacy bullets.

## Research references

- OWASP Top 10 for LLM Applications 2025 — LLM01 Prompt Injection.
  <https://owasp.org/www-project-top-10-for-large-language-model-applications/>
- Microsoft Agent Governance Toolkit (2026) — deterministic runtime
  policy enforcement, 0% violation rate vs 26% prompt-based.
  <https://aka.ms/agent-governance-toolkit>
- Agent-Aegis — per-agent anomaly profiles with rate / burst /
  unknown-action heuristics; the behavior.rs design is adapted from
  this pattern.
- AgentSeal regression canaries — scheduled probe-based trust-score
  regression monitoring (inspiration for `canary.rs`).
- openclaw-agentic-security — DNS tunnelling + egress allowlisting
  (Phase 3 reference).
- Elastic Security detection rules — macOS LaunchDaemon persistence
  patterns (used to tune `launch_agents.rs` severity rules).
