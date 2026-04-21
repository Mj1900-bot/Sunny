# HUD pages (modules)

SUNNY’s main window is a **navigated HUD**: the **Overview** grid plus **lazy-loaded module pages** registered in [`src/pages/pages.ts`](../src/pages/pages.ts). Each page is a focused surface for one subsystem. This guide is user-oriented; for **which agent tools map to which page**, see [`PAGE_COVERAGE.md`](./PAGE_COVERAGE.md).

**Note:** `overview` is the dashboard grid (not a separate chunk in `pages.ts`). Everything else below loads on demand when you open it from the nav or Quick Launcher (`⌘K`).

---

## Core

| Key | Page | What it’s for |
|-----|------|----------------|
| `today` | Today | Day-at-a-glance: brief, reminders, mail/chat snippets, weather — your “command center” for the current day. |
| `timeline` | Timeline | Chronological **episodic** stream (memory events) with day navigation. |
| `security` | Security | **Live security module** — panic kill-switch, policy, network/agent audit, TCC/integrity watchers, secrets touch log. Distinct from **Scan** (on-demand malware). See [`SECURITY.md`](./SECURITY.md). |

---

## Life & schedule

| Key | Page | What it’s for |
|-----|------|----------------|
| `tasks` | Tasks | Reminders-backed task list (select, complete, delete). |
| `journal` | Journal | Journal entries backed by episodic memory, grouped by day. |
| `focus` | Focus | Focus / Pomodoro-style sessions and history. |
| `calendar` | Calendar | Calendar views and event creation integrated with EventKit. |

---

## Communications

| Key | Page | What it’s for |
|-----|------|----------------|
| `inbox` | Inbox | Mail + messaging threads, triage-style layout. |
| `people` | People | Relationship “warmth” and contact-centric views across chats. |
| `contacts` | Contacts | Address-book oriented browse and messaging actions. |
| `voice` | Voice | Voice recordings, transcripts, and playback detail. |
| `notify` | Notify | Local notification / activity feed (app-generated). |

---

## Knowledge & files

| Key | Page | What it’s for |
|-----|------|----------------|
| `notes` | Notes | Apple Notes search, folders, create/append. |
| `reading` | Reading | Reading list queue: add URLs, tabs for queue / reading / done. |
| `memory` | Memory | **Three-store memory** UI: episodic, semantic, procedural, insights, history. |
| `photos` | Photos | Browse photo roots (Desktop, Screenshots, Downloads). |
| `files` | Files | Workspace file browser (navigate, preview, file actions). |

---

## Actions & automation

| Key | Page | What it’s for |
|-----|------|----------------|
| `auto` | Auto | **Scheduler + daemons**: recurring jobs, templates, activity, “run now”. See [`AUTO.md`](./AUTO.md). |
| `skills` | Skills | Procedural **skills** (recipes), edit drawer, usage stats. See [`SKILLS.md`](./SKILLS.md). |
| `apps` | Apps | Running/installed apps, launch and focus helpers. |
| `web` | Web | Built-in **browser** (profiles, reader/sandbox tabs, research, media). See [`BROWSER.md`](./BROWSER.md). |
| `code` | Code | Repo picker, file tree, diffs, lightweight code workspace. |
| `console` | Console | REPL / shell-style console (Python + sandboxed shell hooks). |
| `screen` | Screen | Screen capture, OCR overlay, accessibility-related screen tools. |
| `scan` | Scan | **Malware scanner** — scans, findings, quarantine vault, history. See [`SCAN.md`](./SCAN.md). |

---

## AI & system

| Key | Page | What it’s for |
|-----|------|----------------|
| `world` | World | **World model** — beliefs, activity, calendar/mail snapshots, status strip. |
| `society` | Society | Sub-agents / roles, fleet visibility, critic-oriented society UI. |
| `brain` | Brain | Telemetry, model usage, tool reliability metrics. |
| `persona` | Persona | Persona + **constitution** editing (values, prohibitions, heartbeat). See [`CONSTITUTION.md`](./CONSTITUTION.md). |
| `inspector` | Inspector | Window/screen **inspector** — snapshots and OCR for debugging “what’s on screen”. |
| `audit` | Audit | **Privacy & tool-usage audit** — recent calls, dangerous tools, errors, exports (CSV/NDJSON). |
| `devices` | Devices | Hardware-ish surface: media controls, battery/metrics hooks, related daemons. |
| `vault` | Vault | **Secrets vault** (Keychain-backed) — manage secret entries; reveals are gated and rate-limited. |
| `settings` | Settings | Global settings: models, voice, hotkeys, modules, permissions, constitution tab, advanced flags. |

---

## See also

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the React pages talk to Rust.
- [`SECURITY.md`](./SECURITY.md) — what the Security page is protecting you from and how panic/audit work.
- [`SHORTCUTS.md`](./SHORTCUTS.md) — per-page keyboard shortcuts where defined.
