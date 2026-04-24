//! SUNNY Tauri crate root.
//!
//! Thin entry that wires everything together:
//! - `mod` declarations for every domain module (metrics/ai/voice/…).
//! - `pub fn run()` — bootstraps the Tauri `Builder` with managed state,
//!   the `startup::setup` hook, and the full `invoke_handler!` command list.
//!
//! Heavy lifting lives in:
//! - `commands.rs`   — thin `#[tauri::command]` wrappers.
//! - `startup.rs`    — setup hook body + background emitter loops.
//! - `menu.rs`       — macOS application menu definition.
//! - `clipboard.rs`  — clipboard types/helpers.
//! - `app_state.rs`  — Tauri-managed `AppState` struct.

mod metrics;
// pub mod: re-exported for live integration tests in tests/live/ so the harness
// can verify cost accounting without duplicating the per-provider rate constants.
pub mod telemetry;
/// Latency harness — Wave-2 testing rig for the 2 s SLA. Emits stage
/// markers to `~/.sunny/latency/runs.jsonl` when a fixture is driven
/// through the agent loop. No-op outside a harness scope, so
/// production traffic is unaffected. `pub` so the providers +
/// `agent_loop::core` can call `stage_marker` without a private-module
/// re-export dance.
pub mod latency_harness;
mod http;
mod ai;
mod voice;
// pub use: re-exported for offline integration tests (voice_wake_word scenario).
pub use voice::always_on_buffer;
pub use voice::wake_word;
mod control;
mod pty;
mod audio;
mod audio_capture;
mod paths;
mod messages;
mod web;
mod vault;
mod settings;
pub mod settings_store;
mod vision;
mod automation;
mod memory;
// pub use: re-exported for integration tests (continuity_recall scenario).
pub use memory::continuity_store;
mod scheduler;
mod scheduler_templates;
mod ax;
mod notify;
mod icons;
mod ocr;
mod notes_app;
mod reminders;
mod calendar;
mod mail;
mod tray;
mod media;
mod worldinfo;
mod messaging;
mod messages_watcher;
mod contacts_book;
mod attributed_body;
mod pysandbox;
mod safety_paths;
// pub mod: re-exported for live integration tests so the harness can load the
// Z.AI key via the same Keychain path the app uses at runtime. Only the
// typed getters (zai_api_key, etc.) are needed; no key material is returned
// to the test runner — the key is used only within the provider call itself.
pub mod secrets;
mod boot_guard;
mod daemons;
mod process_budget;
mod subagents_live;
mod world;
#[cfg(test)]
pub use world::set_idle_secs_for_test;
mod ambient;
mod ambient_classifier;
mod constitution;
// Sprint-13 β — per-initiator capability grant policy. Wired into the
// trait-dispatch path by `agent_loop::tool_trait::check_capabilities`.
// Policy persists at `~/.sunny/grants.json`; denials append to
// `~/.sunny/capability_denials.log`.
mod capability;
mod permissions;
mod scan;
pub mod security;
pub mod agent_loop; // re-exported for integration tests (eval_harness)
pub mod openclaw_bridge;
pub mod applescript;
mod tools_browser;
mod tools_compute;
mod tools_macos;
mod tools_shell;
mod tools_weather;
mod tools_web;

mod browser;
pub mod channels;
pub mod perf_profile;
pub mod event_bus;
pub mod autopilot;
// Sprint-12 η — ed25519 provenance for procedural skills.  Owned
// exclusively by `identity.rs`; commands live in `commands.rs` under
// the "Sprint-12 η" banner at the bottom of the file.
mod identity;

mod app_state;
mod clipboard;
mod commands;
mod diagnostics;
mod menu;
mod nav;
mod page_state;
mod startup;
mod supervise;

use std::sync::Mutex;

use app_state::AppState;
use page_state::PageStates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            collector: Mutex::new(metrics::Collector::new()),
            ptys: pty::PtyRegistry::new(),
            recorder: audio::Recorder::new(),
            clipboard: Mutex::new(Vec::new()),
            current_view: Mutex::new(None),
        })
        .manage(PageStates::new())
        .setup(startup::setup)
        .invoke_handler(tauri::generate_handler![
            commands::get_metrics, commands::get_processes, commands::get_net, commands::get_battery,
            commands::chat, ai::llm_oneshot, commands::speak, commands::speak_stop, commands::speak_interrupt, commands::list_voices,
            commands::open_app, commands::open_path, commands::open_sunny_file, commands::open_url, commands::run_shell, commands::shell_sandboxed, commands::applescript, commands::list_apps, commands::fs_list, commands::relaunch_app,
            commands::fs_read_text, commands::fs_mkdir, commands::fs_new_file, commands::fs_rename,
            commands::fs_copy, commands::fs_trash, commands::fs_dir_size, commands::fs_search, commands::fs_reveal,
            commands::app_hide, tools_macos::app_quit, tools_macos::finder_reveal,
            commands::permission_check_screen_recording, commands::permission_check_accessibility,
            commands::permission_check_automation, commands::permission_check_full_disk_access,
            commands::tcc_reset_sunny,
            commands::pty_open, commands::pty_write, commands::pty_resize, commands::pty_close,
            commands::audio_record_start, commands::audio_record_stop, commands::audio_record_status, commands::transcribe, commands::openclaw_ping,
            clipboard::get_clipboard_history,
            commands::messages_recent,
            commands::web_fetch_readable, commands::web_fetch_title, commands::web_search,
            commands::vault_list, commands::vault_add, commands::vault_reveal, commands::vault_delete,
            commands::vault_rename, commands::vault_update_value,
            commands::settings_load, commands::settings_save,
            settings_store::settings_get, settings_store::settings_update,
            commands::secrets_status, commands::secret_set, commands::secret_delete,
            commands::secret_verify, commands::secret_import_env,
            commands::ollama_list_models,
            commands::screen_capture_full, commands::screen_capture_region, commands::screen_capture_active_window,
            commands::mouse_move, commands::mouse_click, commands::mouse_click_at, commands::mouse_scroll,
            commands::keyboard_type, commands::keyboard_tap, commands::keyboard_combo,
            commands::cursor_position, commands::screen_size,
            commands::memory_episodic_add, commands::memory_episodic_list, commands::memory_episodic_search,
            commands::memory_fact_add, commands::memory_fact_list, commands::memory_fact_search, commands::memory_fact_delete,
            commands::memory_skill_add, commands::memory_skill_list, commands::memory_skill_get,
            commands::memory_skill_bump_use, commands::memory_skill_delete,
            commands::memory_skill_update,
            commands::memory_pack, commands::memory_stats,
            commands::memory_consolidator_pending, commands::memory_consolidator_mark_done, commands::memory_consolidator_status,
            commands::memory_retention_run, commands::memory_retention_last_sweep,
            commands::memory_compact, commands::memory_compact_last_run,
            commands::tool_usage_record, commands::tool_usage_stats,
            commands::tool_usage_recent, commands::tool_usage_daily_buckets,
            commands::conversation_tail, commands::conversation_append, commands::conversation_prune_older_than,
            commands::conversation_list_sessions,
            telemetry::telemetry_llm_recent, telemetry::telemetry_llm_stats,
            // Wave-2 latency harness. In debug builds this drives a fixture
            // through `agent_run` and emits stage markers to
            // `~/.sunny/latency/runs.jsonl`. In release builds the command
            // resolves to a stub that returns an error.
            latency_harness::latency_run_fixture,
            world::world_get,
            constitution::constitution_get, constitution::constitution_save, constitution::constitution_check,
            constitution::constitution_kick_append, constitution::constitution_kicks_count, constitution::constitution_kicks_recent,
            constitution::constitution_record_verify,
            commands::scheduler_list, commands::scheduler_add, commands::scheduler_update, commands::scheduler_delete,
            commands::scheduler_set_enabled, commands::scheduler_run_once,
            commands::scheduler_templates_list, commands::scheduler_install_template,
            commands::window_focused_app, commands::window_active_title, commands::window_list, commands::window_frontmost_bundle_id,
            commands::notify_send, commands::notify_action,
            commands::app_icon_png,
            commands::ocr_region, commands::ocr_full_screen, commands::ocr_image_base64,
            commands::notes_app_list, commands::notes_app_folders, commands::notes_app_create, commands::notes_app_append, commands::notes_app_search,
            commands::reminders_list, commands::reminders_lists, commands::reminders_create, commands::reminders_complete, commands::reminders_delete,
            commands::calendar_list_events, commands::calendar_list_calendars, commands::calendar_create_event, commands::calendar_delete_event,
            commands::mail_list_recent, commands::mail_list_accounts, commands::mail_unread_count, commands::mail_search,
            tray::tray_set_status,
            commands::media_toggle_play_pause, commands::media_play, commands::media_pause, commands::media_next, commands::media_prev,
            commands::media_volume_set, commands::media_volume_get, commands::media_now_playing,
            commands::weather_current, commands::weather_forecast, commands::stock_quote, commands::unit_convert,
            commands::messaging_send_imessage, commands::messaging_send_sms, commands::messaging_list_chats,
            commands::messaging_call_phone, commands::messaging_facetime_audio, commands::messaging_facetime_video,
            commands::messaging_fetch_conversation,
            commands::messages_watcher_set_subscriptions, commands::messages_watcher_subscriptions,
            commands::contacts_book_list,
            commands::py_run, commands::py_version,
            commands::daemons_list, commands::daemons_add, commands::daemons_update, commands::daemons_delete,
            commands::daemons_set_enabled, commands::daemons_ready_to_fire, commands::daemons_mark_fired,
            subagents_live::subagents_live_save, subagents_live::subagents_live_load,
            scan::commands::scan_start, scan::commands::scan_start_many,
            scan::commands::scan_start_roots,
            scan::commands::scan_status, scan::commands::scan_findings,
            scan::commands::scan_record, scan::commands::scan_abort, scan::commands::scan_list,
            scan::commands::scan_quarantine, scan::commands::scan_vault_list,
            scan::commands::scan_vault_restore, scan::commands::scan_vault_delete,
            scan::commands::scan_pick_folder, scan::commands::scan_reveal_in_finder,
            scan::commands::scan_running_executables,
            scan::commands::scan_signature_catalog,
            scan::commands::scan_signature_probe,
            // Security — live runtime monitor, panic kill-switch,
            // audit log, launch-agent / login-item / TCC diffing.
            security::commands::security_summary,
            security::commands::security_events,
            security::commands::security_audit_export,
            security::commands::security_panic,
            security::commands::security_panic_reset,
            security::commands::security_panic_mode,
            security::commands::security_spawn_budget,
            security::commands::security_launch_baseline,
            security::commands::security_launch_diff,
            security::commands::security_launch_reset_baseline,
            security::commands::security_login_items,
            security::commands::security_perm_grid,
            security::commands::security_integrity_grid,
            security::commands::security_bundle_info,
            security::commands::security_connections,
            security::commands::security_tool_rates,
            security::commands::security_fim_baseline,
            security::commands::security_env_fingerprint,
            security::commands::security_canary_status,
            security::commands::security_process_tree,
            security::commands::security_policy_get,
            security::commands::security_policy_patch,
            security::commands::security_policy_allow_host,
            security::commands::security_policy_block_host,
            security::commands::security_policy_remove_host,
            security::commands::security_policy_disable_tool,
            security::commands::security_policy_enable_tool,
            security::commands::security_policy_reset,
            security::commands::security_policy_set_quota,
            security::commands::security_quota_usage,
            security::commands::security_scan_outbound,
            security::commands::security_scan_shell,
            security::commands::security_incidents_list,
            security::commands::security_incident_capture,
            security::commands::security_xprotect_status,
            security::commands::security_emit_tool_call,
            // Browser module — hardened multi-profile browser surface.
            browser::commands::browser_profiles_list,
            browser::commands::browser_profiles_get,
            browser::commands::browser_profiles_upsert,
            browser::commands::browser_profiles_remove,
            browser::commands::browser_kill_switch,
            browser::commands::browser_kill_switch_status,
            browser::commands::browser_url_is_deceptive,
            browser::commands::browser_fetch_readable,
            browser::commands::browser_fetch,
            browser::commands::browser_bookmarks_list,
            browser::commands::browser_bookmarks_add,
            browser::commands::browser_bookmarks_delete,
            browser::commands::browser_history_list,
            browser::commands::browser_history_push,
            browser::commands::browser_history_clear,
            browser::commands::browser_audit_recent,
            browser::commands::browser_audit_clear_older,
            browser::commands::browser_sandbox_open,
            browser::commands::browser_sandbox_open_embedded,
            browser::commands::browser_sandbox_set_bounds,
            browser::commands::browser_sandbox_set_visible,
            browser::commands::browser_sandbox_close,
            browser::commands::browser_sandbox_list,
            browser::commands::browser_sandbox_current_url,
            browser::commands::browser_tor_bootstrap,
            browser::commands::browser_tor_status,
            browser::commands::browser_tor_new_circuit,
            browser::commands::browser_downloads_probe,
            browser::commands::browser_downloads_enqueue,
            browser::commands::browser_downloads_list,
            browser::commands::browser_downloads_cancel,
            browser::commands::browser_downloads_get,
            browser::commands::browser_downloads_reveal,
            browser::commands::browser_media_extract,
            browser::commands::browser_research_run,
            // Nav bridge — agent-driven UI routing + page state peek.
            nav::nav_set_current,
            nav::page_peek,
            // Per-page visible state snapshots — 6 getters (agent-read-only,
            // also exposed as `page_state_<name>` tools in the catalog) and
            // 6 setters (frontend writes on every meaningful state change).
            page_state::page_state_calendar,
            page_state::page_state_calendar_set,
            page_state::page_state_tasks,
            page_state::page_state_tasks_set,
            page_state::page_state_inbox,
            page_state::page_state_inbox_set,
            page_state::page_state_focus,
            page_state::page_state_focus_set,
            page_state::page_state_notes,
            page_state::page_state_notes_set,
            page_state::page_state_voice,
            page_state::page_state_voice_set,
            event_bus::event_bus_tail, event_bus::event_bus_tail_by_kind, event_bus::event_bus_subscribe, event_bus::event_bus_unsubscribe,
            // Sprint-12 ε — Diagnostics page snapshot.
            diagnostics::diagnostics_snapshot,
            // Sprint-12 η — ed25519 provenance for skill manifests.
            commands::identity_public_key,
            commands::sign_skill_manifest,
            commands::verify_skill_manifest,
            commands::identity_trust_signer,
            commands::identity_is_trusted,
            commands::identity_list_trusted,
            // Sprint-13 β — capability grant policy surface.
            commands::capability_list_grants,
            commands::capability_update_grants,
            commands::capability_tail_denials,
            // Sprint-13 η — signed-skill export via native save-dialog.
            commands::skill_export_save,
            commands::skill_export_save_bulk,
            // CostPage — today's spend aggregated from the telemetry ring.
            commands::cost_today_json,
            // Plugins — read-only list of plugins loaded from ~/.sunny/plugins/.
            commands::plugin_list,
            // Channels — Telegram adapter (bot-token channel; v0.1 scaffolding).
            // Actual Tauri commands land once the polling loop + agent wiring do.
            // Brainstorm — multi-agent council deliberation.
            agent_loop::council::council_start,
            // Perf profiler — latency p50/p95 per model for Cost Dashboard.
            perf_profile::perf_profile_snapshot,
        ])
        // Split Builder::run into build+run so we can intercept the Exit
        // event and clear the boot-guard marker. A clean exit means the
        // NEXT boot sees no marker and loads daemons normally; a crash
        // or SIGKILL leaves the marker in place, and startup::setup
        // quarantines daemons on the next run. See `boot_guard.rs`.
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Err(e) = boot_guard::disarm() {
                    log::warn!("[exit] boot_guard::disarm failed: {e}");
                }
            }
        });
}
