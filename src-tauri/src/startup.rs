//! App startup orchestration: runs once inside the Tauri `.setup(…)` hook.
//!
//! Responsibilities (in order):
//! 1. Augment process PATH so Finder-launched GUIs see Homebrew/nvm/cargo.
//! 2. Initialize memory + constitution stores (non-fatal on failure).
//! 3. Kick the background embedding backfill loop.
//! 4. Start the world-model updater and persistent scheduler loop.
//! 5. Install the menu-bar tray icon.
//! 6. Install the dev-mode log plugin.
//! 7. Build and attach the macOS application menu + its event router.
//! 8. Spawn three periodic emitters: metrics/net (1.4s), processes+battery
//!    (3s), and the clipboard sniffer (1.5s).

use tauri::{App, Emitter, Manager};

use crate::app_state::AppState;
use crate::clipboard::{
    CLIPBOARD_HISTORY_MAX, ClipboardEntry, classify_clipboard, pbpaste_read, truncate_display,
};
use crate::menu::build_menu;
use crate::supervise::spawn_supervised;
use crate::{constitution, event_bus, identity, memory, messages_watcher, metrics, paths, scheduler, security, tray, world};

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Floor 1 of the process budget (see `process_budget.rs`). Lower
    // Sunny's soft RLIMIT_NPROC so a runaway tool handler can only crash
    // Sunny, not the user's whole login session. Must run before any
    // tool handler or autopilot daemon has a chance to spawn.
    if let Err(e) = crate::process_budget::install_rlimit() {
        log::warn!("[startup] process_budget::install_rlimit failed (continuing): {e}");
    }

    // Boot guard: check whether the previous session exited cleanly. If
    // not — Sunny crashed, was killed, or the user force-quit during a
    // spawn fanout — we quarantine every enabled daemon so the crash
    // can't replay on reboot. The user re-enables explicitly from the
    // HUD once they've understood what happened. Clean-exit accounting
    // is done in the Tauri exit hook (RunEvent::Exit) that calls
    // `boot_guard::disarm`.
    match crate::boot_guard::arm() {
        Ok(crate::boot_guard::BootState::Clean) => {
            log::info!("[startup] boot_guard: previous exit was clean");
        }
        Ok(crate::boot_guard::BootState::Quarantine) => {
            match crate::daemons::quarantine_on_disk() {
                Ok(n) => log::warn!(
                    "[startup] boot_guard: previous run crashed — {n} daemons quarantined; re-enable from Auto page when ready"
                ),
                Err(e) => log::error!("[startup] boot_guard: quarantine write failed: {e}"),
            }
        }
        Err(e) => log::warn!("[startup] boot_guard::arm failed (continuing): {e}"),
    }

    // Finder/Dock-launched GUI apps inherit a minimal PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin). Merge in Homebrew, nvm,
    // Volta, cargo and ~/.local so that shebang scripts like
    // `openclaw` (#!/usr/bin/env node) can find their runtime.
    paths::augment_process_path();

    // Persistent event spine — publish-only; subscribers hook in via event_bus::subscribe.
    if let Err(e) = event_bus::init() { log::warn!("event_bus init failed: {e}"); }

    // Warm the session cache for the canonical "main" session in the
    // background. Pre-computes pick_backend (keychain probes, ~50-150
    // ms) and pick_model (which fires a 2000 ms Ollama HTTP probe on
    // the Ollama backend) so the user's first real turn hits a
    // populated cache instead of paying those costs on the critical
    // path. Fire-and-forget: errors are logged and swallowed by the
    // warm helper. Subagents and pinned-provider sessions bypass the
    // cache entirely, so mis-warm is never a correctness concern.
    tokio::spawn(async {
        crate::agent_loop::core::warm_main_session_cache().await;
    });

    // Hook 1: Autopilot proactive daemon — T0/T1 tier (silent log + HUD pulse).
    // T2+ voice surfaces remain gated by deliberator::AUTOPILOT_SPEAK_ENABLED (false).
    // Enabled by default; opt-out via SUNNY_AUTOPILOT_ENABLED=false.
    {
        let enabled = std::env::var("SUNNY_AUTOPILOT_ENABLED")
            .map(|v| !matches!(v.to_ascii_lowercase().as_str(), "false" | "0" | "no"))
            .unwrap_or(true);
        if enabled {
            crate::autopilot::deliberator::spawn(app.handle().clone());
            log::info!("[startup] autopilot deliberator spawned");
        } else {
            log::info!("[startup] autopilot disabled via SUNNY_AUTOPILOT_ENABLED");
        }
    }

    // Initialize the memory subsystem up-front so the legacy JSONL
    // migration (if any) runs during app startup rather than on the
    // first user query. Failure is logged but not fatal — the store
    // is re-initialized lazily on first access inside `with_conn`.
    if let Err(e) = memory::init_default() {
        log::warn!("memory init failed (will retry lazily): {e}");
    }

    // Ensure the local ed25519 keypair exists. First
    // launch mints a fresh key at `~/.sunny/identity/ed25519.key` (0o600)
    // and writes the hex pubkey next to it.  Subsequent launches just
    // load the existing key.  Non-fatal: if the directory is read-only
    // (corporate managed Mac, locked volume, etc) signing will fail at
    // skill-save time with a clear error rather than crashing the app.
    if let Err(e) = identity::ensure_keypair() {
        log::warn!("identity: keypair init failed: {e}");
    }

    // Load the constitution (~/.sunny/constitution.json). On first
    // launch this writes a permissive default the user can edit;
    // subsequent launches read whatever the user has configured.
    if let Err(e) = constitution::init_default() {
        log::warn!("constitution init failed (using defaults): {e}");
    }

    // Start the embedding backfill loop. Walks un-embedded rows in
    // the background, 8 per 30s tick, skipping quietly when Ollama
    // isn't running. No-op on a freshly-embedded DB.
    memory::embed::start_backfill_loop();

    // Start the episodic retention loop. Once a day, deterministically
    // deletes old perception / agent_step / tool_call rows that the
    // consolidator + reflection have already extracted signal from.
    // Pure SQL, no LLM. Keeps the DB bounded as the user racks up
    // months of perception captures and run traces.
    memory::retention::start_retention_loop();

    // Start the WAL maintenance loop. Every 5 minutes runs a
    // `PRAGMA wal_checkpoint(TRUNCATE)` so the `-wal` sidecar file
    // actually shrinks on disk — autocheckpoint alone just advances
    // the in-memory pointer, leaving the file at its high-water mark.
    // Critical under the world-updater + consolidator + embed-backfill
    // write storm where the WAL can otherwise balloon into hundreds
    // of MB and stall the next launch. Spawned unconditionally — even
    // if `memory::init_default` above failed, the cell will be lazily
    // populated on first access and the loop will start working then.
    memory::start_wal_maintenance();

    // Kick the dialogue PARENTS-map pruner. Every 5 minutes it removes
    // stale parent-pointer entries for sub-agents that have already
    // finished and had their inbox drained, preventing an unbounded
    // grow-only Mutex<HashMap> after 24h+ of council / debate use.
    crate::agent_loop::dialogue::start_prune_loop();

    // Install the security bus before anything that might emit
    // events (scheduler, world-model updater, tray, menu).  The bus
    // is a lazy global so modules that fire early just drop their
    // events — but installing here means every event from the
    // steady-state loop lands in the audit log.
    let _security_dir = security::install(app.handle().clone());
    // Mint the canary token so http::send can trip it if an agent
    // ever exfiltrates "everything in the env" to an attacker.
    let _ = security::canary::install();
    // Start the summary aggregator loop + background watchers.
    security::policy::start_summary_loop(app.handle().clone());
    security::watchers::start_all(app.handle().clone());
    // System-integrity poller (SIP / Gatekeeper / FileVault /
    // Firewall / Sunny bundle codesign / config profiles).
    security::integrity::start(app.handle().clone());
    // File Integrity Monitor over `~/.sunny/*` configs.
    security::fim::start(app.handle().clone());
    // Persist per-tool rate baseline every 2 min so the anomaly
    // detector has a warm baseline after a restart.
    security::behavior::start_persistence_loop();

    // Start the world-model updater. 15s ticks sampling focus + metrics,
    // 60s ticks for calendar/mail, emits `sunny://world` + writes
    // `perception` episodic rows on focus change. Restores from
    // ~/.sunny/world.json on startup so the first UI paint is warm.
    world::start(app.handle().clone());

    // Ambient watcher — subscribes to `sunny://world` and surfaces novel
    // conditions (meeting-imminent, battery low+discharging, mail spike)
    // via notify + `sunny://ambient.notify`. Cross-restart dedupe in
    // `~/.sunny/ambient.json`; kill switch at `settings.json::ambient_enabled`.
    crate::ambient::start(app.handle().clone());

    // Start the persistent scheduler loop (10s ticks, reads ~/.sunny/scheduler.json).
    scheduler::start_scheduler_loop(app.handle().clone());

    // Start the iMessage watcher (5s ticks). Idle until the frontend registers
    // a proxy subscription, so there's zero chat.db traffic out of the box.
    messages_watcher::start(app.handle().clone());

    // Pre-warm the whisper.cpp model in the background so the user's first
    // voice press doesn't stall for ~74 MB of download. Failure is silent —
    // the on-demand path in `audio::transcribe` will try again and surface a
    // proper error if it still can't get a model.
    if crate::paths::which("whisper-cli").is_some() {
        tauri::async_runtime::spawn(async {
            if let Err(e) = crate::audio::ensure_whisper_model().await {
                log::warn!("whisper model prefetch failed: {e}");
            }
        });
    }

    // Pre-warm the Kokoro TTS daemon so the first `speak()` doesn't stall
    // on the ~170 MB ONNX model cold-load. Delayed 1.5 s so it doesn't
    // compete with the rest of startup for CPU; silent when koko or model
    // files aren't on disk (the `say` fallback still works).
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let _ = crate::voice::warm_daemon().await;
    });

    // Pre-warm CoreAudio by probing the default input device. On macOS the
    // audio HAL needs ~50-150 ms of cold-start the first time a capture
    // stream is opened — if the user presses Space immediately after
    // launch and starts speaking in the same breath, the first word gets
    // swallowed while the driver warms up. Probing the device config
    // here at startup triggers the same driver init without opening a
    // real stream, so the first user record_start finds the HAL hot.
    tauri::async_runtime::spawn_blocking(|| {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        if let Some(device) = host.default_input_device() {
            match device.default_input_config() {
                Ok(_) => log::info!("[audio] CoreAudio input device pre-warmed"),
                Err(e) => log::debug!("[audio] input config probe failed: {e}"),
            }
        }
    });

    crate::audio_capture::init_preroll(app.handle().clone());

    // Install the macOS menu-bar tray with agent-status icon.
    tray::install(app.handle())?;

    // Enable the log plugin in release builds too so we can diagnose voice
    // / agent-loop stalls without a dev build. Logs go to the standard
    // tauri-plugin-log targets (stdout + ~/Library/Logs/<bundle-id>/<app>.log
    // on macOS). Info everywhere except agent_loop which logs at debug so
    // we can trace where a stuck turn is hanging.
    app.handle().plugin(
        tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .level_for("sunny_lib::agent_loop", log::LevelFilter::Debug)
            .level_for("agent_loop", log::LevelFilter::Debug)
            .build(),
    )?;

    let menu = build_menu(app.handle())?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        match id {
            "preferences" => { let _ = app.emit("sunny://menu", "preferences"); }
            "about"       => { let _ = app.emit("sunny://menu", "about"); }
            id if id.starts_with("go-") => {
                let _ = app.emit("sunny://nav", id.trim_start_matches("go-"));
            }
            "toggle-voice" | "cycle-theme" | "cycle-state" | "listen" => {
                let _ = app.emit("sunny://menu", id);
            }
            _ => {}
        }
    });

    // Metrics/net emitter — 1.4s ticks. Supervised so a panicking
    // sysinfo probe doesn't silently kill the HUD feed until restart.
    let handle = app.handle().clone();
    spawn_supervised("metrics_emitter", move || {
        let handle = handle.clone();
        async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(1400));
            loop {
                ticker.tick().await;
                let state: tauri::State<'_, AppState> = handle.state();
                let metrics = state.collector.lock().unwrap().sample();
                let net = state.collector.lock().unwrap().net();
                let _ = handle.emit("sunny://metrics", &metrics);
                let _ = handle.emit("sunny://net", &net);
            }
        }
    });

    // Processes + battery emitter — 3s ticks. Supervised: the battery
    // IOKit probe and the per-proc sampler are the most panic-prone
    // syscalls in the HUD path.
    let handle2 = app.handle().clone();
    spawn_supervised("processes_battery_emitter", move || {
        let handle2 = handle2.clone();
        async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3));
            loop {
                ticker.tick().await;
                let state: tauri::State<'_, AppState> = handle2.state();
                let procs = state.collector.lock().unwrap().processes(32);
                let _ = handle2.emit("sunny://processes", &procs);
                if let Some(b) = metrics::battery() {
                    let _ = handle2.emit("sunny://battery", &b);
                }
            }
        }
    });

    // Clipboard sniffer — polls pbpaste every 1.5s, prepends new entries to a bounded
    // history (max 20) and emits `sunny://clipboard` with the latest entry on change.
    // Supervised because pbpaste can return pathological payloads that panic
    // downstream classifiers; a dead sniffer silently breaks clipboard history
    // until the user restarts the app.
    let handle3 = app.handle().clone();
    spawn_supervised("clipboard_sniffer", move || {
        let handle3 = handle3.clone();
        async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(1500));
            let mut last: Option<String> = None;
            loop {
                ticker.tick().await;
                let Some(current) = pbpaste_read().await else { continue; };
                if current.trim().is_empty() {
                    continue;
                }
                if last.as_deref() == Some(current.as_str()) {
                    continue;
                }
                last = Some(current.clone());

                let entry = ClipboardEntry {
                    kind: classify_clipboard(&current),
                    time: chrono::Local::now().format("%H:%M").to_string(),
                    text: truncate_display(&current),
                };

                // Lock-guard-not-across-await: take values, drop guard, then emit.
                let snapshot = {
                    let state: tauri::State<'_, AppState> = handle3.state();
                    let mut guard = state.clipboard.lock().unwrap();
                    guard.insert(0, entry.clone());
                    if guard.len() > CLIPBOARD_HISTORY_MAX {
                        guard.truncate(CLIPBOARD_HISTORY_MAX);
                    }
                    guard.clone()
                };

                let _ = handle3.emit("sunny://clipboard", &entry);
                let _ = snapshot; // kept for future consumers; suppresses unused warning
            }
        }
    });

    Ok(())
}
