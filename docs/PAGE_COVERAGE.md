# Page Coverage Audit (R18-E)

Audit of what the SUNNY agent (tools in `src-tauri/src/agent_loop/catalog.rs::AGENT_TOOLS`)
can read and drive on each HUD module. There are **33** lazy-loaded pages in
[`src/pages/pages.ts`](../src/pages/pages.ts) plus the **Overview** dashboard
(`overview` in [`ViewKey`](../src/store/view.ts)), **34** navigable views total.
For a user-facing description of each screen, see [`PAGES.md`](./PAGES.md).
R18-A will land a generic
`page_action` + `page_state` contract; this doc flags which pages will be fully
covered by that generic bridge vs. which need page-specific glue.

**Legend.** *READ_TOOLS* = agent tools that read the same data the page renders.
*WRITE_TOOLS* = agent tools that drive the same actions exposed by page buttons.
*VIA_page_action* = can the generic R18-A hook reasonably express this page's
action surface (selection/filter/create/edit/delete)? *GAPS* = what's missing
even after R18-A/H land.

| PAGE | SECTION | READ_TOOLS | WRITE_TOOLS | VIA_page_action | GAPS |
|---|---|---|---|---|---|
| today | CORE | `calendar_today`, `calendar_upcoming`, `mail_unread_count`, `mail_list_unread`, `reminders_list`, `messaging_list_chats`, `memory_recall`, `weather_current` | none (read-only dashboard) | Yes (scroll/refocus/dismiss cards) | Agent can reconstruct every widget via tools. Minor: no tool returns the assembled digest the user is literally looking at. |
| timeline | CORE | none direct — page uses `memory_episodic_list` (not an agent tool) | none | Yes (date-range filter, select episode) | **GAP** — agent has `memory_recall` (semantic) but no chronological episodic list. Can't answer "what happened yesterday at 4 pm". |
| security | CORE | none — `security_summary`, `security_perm_grid`, `security_policy_get`, `security_integrity_grid`, `security_fim_baseline`, `security_canary_status`, `security_xprotect_status` are not in AGENT_TOOLS | none — `security_panic`, `security_policy_*`, `security_incident_capture` not exposed | Yes (filter tabs) | **CRITICAL** — 30+ commands, zero in AGENT_TOOLS. Agent can't see panic state or flip enforcement policy. Whole page is opaque. |
| tasks | LIFE | `reminders_list` | `reminders_add` | Yes (filter/select reminder) | `reminders_complete`, `reminders_delete`, `reminders_update` not exposed. Agent can add tasks but can't mark one done. |
| journal | LIFE | none (uses `memory_episodic_list`/`memory_episodic_add`) | none | Yes (date filter, select entry) | Same episodic hole as timeline. Agent can't append a journal entry on user's behalf. |
| focus | LIFE | none (uses `world_get`) | none | Yes (start/stop timer) | **GAP** — no `focus_session_start`/`stop` tool anywhere. Agent can't start a pomodoro. Needs page-specific action. |
| calendar | LIFE | `calendar_today`, `calendar_upcoming` | `calendar_create_event` | Yes (date nav, select event) | `calendar_list_calendars`, `calendar_list_events` (date-range), `calendar_delete_event` not in AGENT_TOOLS. Agent can create but can't delete or jump to a date. |
| inbox | COMMS | `mail_list_unread`, `mail_search`, `messaging_list_chats`, `messaging_fetch_conversation` | `mail_send`, `imessage_send`, `messaging_send_sms` | Yes (select thread, filter unread) | Good coverage for mail/iMessage. `mail_list_recent` (paged) not exposed — agent forced to use unread-only variant. |
| people | COMMS | `contacts_lookup`, `messaging_list_chats` | none | Yes (select person, warmth filter) | `contacts_book_list`, `messages_recent` (with warmth heatmap data) not in AGENT_TOOLS. Agent can look up one contact but can't list cooling ones. |
| contacts | COMMS | `contacts_lookup` | `imessage_send`, `messaging_send_sms` | Yes (select contact, filter) | Page drives `messaging_send_imessage` directly (different from `imessage_send`?) + applescript. Mostly OK. |
| voice | COMMS | none — `audio_record_start/stop/status`, `transcribe` not in AGENT_TOOLS | none | Partial — record/stop are session actions | **GAP** — agent can't start a recording or read the transcript the user just dictated. Needs page-specific. |
| notify | COMMS | none (page-local store) | none — `notify_send` not in AGENT_TOOLS | Yes (dismiss, filter) | **GAP** — agent can't send a system notification or see the feed. |
| notes | KNOWLEDGE | `notes_search` | `notes_create`, `notes_append` | Yes (select note, folder filter) | `notes_app_folders`, `notes_app_list` (by folder) not exposed. Agent can search but can't enumerate folders to pick one. |
| reading | KNOWLEDGE | `web_fetch` (close enough to `web_fetch_readable`) | none | Yes (add URL, tab switch, mark done) | **GAP** — no tool for the queue itself (add/mark-read/mark-done). Reading list is invisible to agent. |
| memory | KNOWLEDGE | `memory_recall`, `agent_reflect` | `memory_remember`, `memory_compact` | Yes (tab switch, select fact, filter) | `memory_stats`, `memory_episodic_list`, `memory_fact_add`, `memory_fact_delete`, `memory_skill_*`, `memory_delete`, `tool_usage_*` not in AGENT_TOOLS. Rich page, thin tool surface. |
| photos | KNOWLEDGE | none — `fs_search`, `fs_read_base64` not exposed | none — `fs_reveal`, `open_path` not exposed | Yes (pick root, select photo) | **CRITICAL** — agent can't list or open photos at all. Core surface invisible. |
| files | KNOWLEDGE | none — `fs_search`, `fs_dir_size`, `fs_read_text` not exposed | none — `fs_copy`, `fs_trash`, `fs_rename`, `fs_reveal`, `open_path` not exposed | Yes (nav, select entries, sort) | **CRITICAL** — whole filesystem UI is dark to the agent. Can ask to open a file and agent can't. |
| auto | DO | `scheduler_add` (write-only in catalog) | `scheduler_add` | Yes (tabs, select job) | `scheduler_list`, `scheduler_delete`, `scheduler_set_enabled`, `scheduler_run_once`, `scheduler_templates_list`, `scheduler_install_template` not in AGENT_TOOLS. Agent can schedule but can't list or trigger existing jobs. |
| skills | DO | none — `memory_skill_list` not exposed | none — `memory_skill_update`, `memory_skill_delete` not exposed | Yes (select skill, edit) | **GAP** — procedural-memory surface is invisible. Agent can't recommend or retire its own skills. |
| apps | DO | `focused_window` | `app_launch`, `app_quit` | Yes (select app, filter) | `list_apps`, `window_list`, `app_icon_png`, `app_hide` not in AGENT_TOOLS. Agent can launch a known app but can't enumerate. |
| web | DO | `browser_read_page_text`, `web_fetch`, `web_extract_links` | `browser_open`, `browser_back`, `browser_forward`, `browser_close_tab`, `browser_tab_select`, `web_browse` | Yes (select tab, profile, toggle panel) | `browser_sandbox_*` (tab lifecycle), `browser_downloads_*`, `browser_profiles_*`, `browser_bookmarks_*`, `browser_kill_switch`, `browser_tor_status`, `browser_history_push`, `browser_research_run`, `browser_media_extract`, `browser_audit_*` not in AGENT_TOOLS. **Massive surface, narrow tool slice.** |
| code | DO | `shell_sandboxed` (close enough to `run_shell`) | `code_edit` | Yes (select repo, file, diff) | No repo discovery, git log, file-tree, or commit tools. Code page content invisible to agent. |
| console | DO | none — `py_version` not exposed | `py_run`, `shell_sandboxed` | Yes (type + run) | Minor — agent has execution but can't read back the REPL's last N outputs (no `console_history`). |
| screen | DO | `focused_window`, `screen_ocr`, `screen_capture_full` | none — `mouse_click_at`, `applescript`, `relaunch_app` not exposed to agent | Partial (select display, click target) | **GAP** — `window_focused_app`, `window_active_title`, `window_list`, `screen_size`, `ocr_image_base64` not in AGENT_TOOLS; click/applescript not exposed. Agent can OCR a full screen but can't click a pixel. |
| scan | DO | none — `scan_status`, `scan_record`, `scan_signature_catalog` not exposed | none — `scan_start`, `scan_start_many`, `scan_start_roots`, `scan_abort`, `scan_quarantine`, `scan_vault_*`, `scan_pick_folder` not exposed | Yes (tab, select finding) | **CRITICAL** — malware-scan module completely invisible. User asks "run a scan on ~/Downloads" → agent has no tool. |
| world | AI·SYS | `system_metrics`, `battery_status`, `focused_window`, `media_now_playing`, `calendar_today`, `mail_unread_count` — enough to approximate `world_get` | none (read-only) | Yes (select belief, scroll timeline) | **GAP** — `world_get` itself (assembled `WorldState`) is not an agent tool. Agent has to stitch 6 tools to reconstruct one view. |
| society | AI·SYS | none — sub-agent fleet lives in a frontend store fed by events | none | Yes (select agent, filter role) | **GAP** — no `subagents_list` tool. Agent can't see its own fleet. Feeds from `spawn_subagent` events only. |
| brain | AI·SYS | none — `tool_usage_stats`, `tool_usage_daily_buckets`, `telemetry_llm_stats`, `telemetry_llm_recent`, `ollama_list_models`, `memory_stats` not in AGENT_TOOLS | none | Yes (filter, select model) | **GAP** — telemetry page is fully opaque. Agent can't answer "how reliable is web_search?". |
| persona | AI·SYS | none — `constitution_get` not exposed | `persona_update_heartbeat` (narrow subset of `constitution_save`) | Yes (select section, toggle) | **GAP** — constitution body invisible. Agent can only rewrite heartbeat autogen block, can't view or edit the rest. |
| inspector | AI·SYS | `focused_window`, `screen_ocr` | none | Yes (select window, snapshot) | `window_focused_app`, `window_active_title`, `window_list`, `cursor_position`, `ocr_full_screen` (with display arg) not in AGENT_TOOLS. Overlaps Screen page gaps. |
| audit | AI·SYS | none — `tool_usage_recent`, `tool_usage_stats` not in AGENT_TOOLS | none | Yes (filter errors/tool, select row) | **GAP** — agent can't see its own call log. Hard to self-diagnose. |
| devices | AI·SYS | `system_metrics`, `battery_status`, `media_now_playing` | `media_play_pause` | Yes (toggle daemon, pick media action) | `daemons_list`, `daemons_set_enabled`, `get_net`, `media_next`, `media_prev`, `scheduler_run_once` not in AGENT_TOOLS. Agent can't next-track or see network. |
| vault | AI·SYS | none — `vault_reveal` requires confirm + not exposed | none — `vault_add`, `vault_delete`, `vault_rename`, `vault_update_value` not exposed | Yes (select item) | **CRITICAL & CORRECT** — by design. Secrets should require interactive confirm. Flag anyway so R18-A doesn't accidentally expose. |
| settings | AI·SYS | none — `settings_load`, `memory_stats`, `memory_consolidator_status`, `secrets_status`, `secret_verify`, `openclaw_ping`, `permission_check_*` not exposed | none — `settings_save`, `secret_set`, `secret_delete`, `tcc_reset_sunny`, `speak`, `speak_stop`, `relaunch_app`, `constitution_save` not exposed | Yes (tab nav, toggle, input field) | Largest page (5 tabs), zero agent coverage. User says "turn on compact mode" → agent can't. Needs either page_action or settings_patch tool. |

## Coverage Summary

- **Pages audited:** 34 views — 33 entries in `pages.ts` plus Overview (`overview`).
- **Fully covered (read + write via AGENT_TOOLS):** 3 — inbox, calendar (creates only), tasks (adds only).
- **Partially covered (some reads, some writes):** ~10 — today, memory, notes, people, contacts, apps, web, code, devices, world (via stitched tools).
- **Effectively opaque** (no page-relevant tools in AGENT_TOOLS): ~21 — timeline, security, journal, focus, voice, notify, reading, skills, scan, photos, files, auto (read side), society, brain, persona (read side), inspector (window side), audit, vault, settings, screen (control side), memory (stats/episodic side).
- **~9%** of pages (3 of 34) have end-to-end agent coverage today. **~62%** have no meaningful tool path.

## Top 10 Priority Gaps (ranked by user impact)

1. **SettingsPage** — 5-tab settings hub controls SUNNY's own voice, model, permissions, constitution, advanced flags. No tool surface. "Hey SUNNY, switch to Kokoro George at 210 wpm" must work. Needs a generic `settings_patch` write tool plus `settings_get` read — not page_action alone.
2. **FilesPage** — users constantly ask "open that file", "where's ~/Downloads/X", "trash this". Zero `fs_*` tools in AGENT_TOOLS. Without file search/open, SUNNY can't drive her own filesystem UI.
3. **PhotosPage** — "show me that screenshot from Tuesday" requires `fs_search` + `fs_read_base64`. Neither exposed. Photo surface is dark.
4. **ScanPage** — malware scanning is a marquee module. User says "scan Downloads" — no `scan_start*` tool. Whole security-scan workflow is inert.
5. **SecurityPage** — 30+ commands (panic mode, host allow/block, tool-quota caps, FIM baseline) and not a single one in AGENT_TOOLS. "SUNNY, block that host" impossible.
6. **TasksPage** — `reminders_add` ships but `reminders_complete`, `reminders_update`, `reminders_delete` don't. User says "mark laundry done" and SUNNY can't. High-frequency flow.
7. **AutoPage** — scheduler has `scheduler_add` only. No list/enable/run-once/delete/template tools. User can't ask "run the nightly digest now" or "pause that job".
8. **BrainPage / AuditPage** — agent telemetry page and tool-call log both opaque. SUNNY can't reflect on her own reliability ("how often does web_search fail?"). Fixes the `agent_reflect` feedback loop.
9. **TimelinePage / JournalPage** — episodic memory UI exists but `memory_episodic_list` and `memory_episodic_add` are not agent tools. "What did I write Thursday night?" returns nothing.
10. **VoicePage / NotifyPage / ReadingPage / SkillsPage** (tied) — four small surfaces that each have their own single-purpose store (recordings, notification feed, reading queue, procedural skills) with zero agent tools. Each needs 2-4 tool bindings or page-specific actions.

## R18-A/H Coverage Assessment

Most page **selection/filter/create/edit/delete** semantics are expressible via
the generic `page_action` + `page_state` contract once it lands — nothing in
this audit conflicts with that design. The gaps above are *not* covered by
R18-A/H because they're either:

- **Missing backend tool bindings** (commands exist but not in AGENT_TOOLS) —
  rows 1, 4, 5, 6, 7, 8, 9, 10. Fix by widening `AGENT_TOOLS`.
- **Missing backend commands entirely** (focus sessions, reading queue,
  subagent list, settings read/write) — rows 1, 10. Fix by adding new
  `#[tauri::command]`s plus catalog entries.
- **Page-specific composite actions** (scan workflow, web sandbox lifecycle,
  vault reveal) that need custom intents beyond generic CRUD — rows 2, 4, 5.
  Fix by page-specific `page_action` handlers inside each page's action
  reducer.

R18-A alone gets the agent's *view* wired; a parallel tool-widening pass is
required for the agent to actually *act*.
