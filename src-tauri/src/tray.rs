//! macOS menu-bar tray for SUNNY.
//!
//! Renders a branded "orb" icon in the system menu bar that reflects the
//! current SUNNY agent state (idle / running / done / error / aborted). The
//! icon is the same visual language as the app icon — a filled core plus
//! two concentric orbit rings — painted in the status color.
//!
//! Clicking it opens a structured menu with a live status header and
//! submenus for navigation, voice control, and the currently running agent
//! run. The menu is rebuilt on every `tray_set_status` call so that:
//!
//!   * the header reflects the latest goal,
//!   * the voice toggle label flips between "Pause" and "Resume",
//!   * "Abort Current Run" is only enabled while a run is in flight,
//!   * "Clear Run" is only enabled when there is a finished run to clear.
//!
//! The tray also exposes five quick actions so Sunny can fire things
//! without opening the HUD:
//!
//!   * TALK (push-to-talk) — emits `sunny://voice.start` which the
//!     `useVoiceChat` hook listens for and converts into `pressTalk()`.
//!   * CAPTURE SCREEN — calls `vision::capture_full_screen` and writes
//!     the PNG to `~/Desktop/SUNNY-YYYYMMDD-HHMMSS.png`.
//!   * TOGGLE DND — flips persona-aware Do-Not-Disturb: snapshots which
//!     daemons are currently enabled then disables them all, triggers
//!     macOS Focus via `osascript`, and reverses the operation on
//!     second-toggle so the user's daemon layout is restored exactly.
//!   * OPEN SUNNY — brings the main window forward (alias of Show SUNNY).
//!   * QUIT SUNNY — standard quit.
//!
//! A single `TrayIcon` instance is held inside a `OnceLock<Mutex<...>>` so
//! rapid status transitions only ever mutate the one icon; we never
//! construct a new TrayIcon on every status change.

use std::sync::{Mutex, OnceLock};

use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::daemons;
use crate::vision;

// ---------------------------------------------------------------------------
// Single global tray icon handle.
// ---------------------------------------------------------------------------

static TRAY: OnceLock<Mutex<TrayIcon<Wry>>> = OnceLock::new();

// ---------------------------------------------------------------------------
// Do-Not-Disturb persona state.
// ---------------------------------------------------------------------------

/// Snapshot of which daemons were enabled at the moment DND was engaged, so
/// that leaving DND restores exactly the user's prior layout rather than
/// flipping every daemon on. We also track the boolean flag itself here so
/// the menu can label the item "Enable DND" vs "Disable DND".
#[derive(Default, Clone)]
struct DndState {
    active: bool,
    suspended_ids: Vec<String>,
}

static DND: OnceLock<Mutex<DndState>> = OnceLock::new();

fn dnd_cell() -> &'static Mutex<DndState> {
    DND.get_or_init(|| Mutex::new(DndState::default()))
}

fn dnd_is_active() -> bool {
    dnd_cell()
        .lock()
        .map(|g| g.active)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Icon generation.
// ---------------------------------------------------------------------------

const ICON_SIZE: u32 = 18;

/// Build an owned 18x18 RGBA buffer shaped like the SUNNY orb:
///
///   * a filled 4px-radius core,
///   * a soft halo falloff between core and first ring,
///   * a thin inner orbit ring,
///   * a thinner, dimmer outer orbit ring.
///
/// All strokes use the same (r, g, b) with different alphas so the status
/// color reads clearly against both light and dark menu bars.
fn build_orb_rgba(r: u8, g: u8, b: u8) -> Vec<u8> {
    let size = ICON_SIZE as i32;
    let cx = (size as f32 - 1.0) / 2.0;
    let cy = (size as f32 - 1.0) / 2.0;

    let core_r: f32 = 4.0;
    let inner_ring_r: f32 = 6.6;
    let outer_ring_r: f32 = 8.2;
    let ring_thick: f32 = 0.85;

    let mut out = vec![0u8; (size * size * 4) as usize];

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let dist = (dx * dx + dy * dy).sqrt();

            let core_edge = core_r - dist;
            let core_a: f32 = if core_edge >= 1.0 {
                255.0
            } else if core_edge <= 0.0 {
                0.0
            } else {
                core_edge * 255.0
            };

            let halo_a: f32 = if dist > core_r && dist < inner_ring_r {
                let t = (inner_ring_r - dist) / (inner_ring_r - core_r);
                t * 55.0
            } else {
                0.0
            };

            let mid_d = (dist - inner_ring_r).abs();
            let mid_a: f32 = if mid_d < ring_thick {
                (1.0 - mid_d / ring_thick) * 160.0
            } else {
                0.0
            };

            let out_d = (dist - outer_ring_r).abs();
            let out_a: f32 = if out_d < ring_thick {
                (1.0 - out_d / ring_thick) * 95.0
            } else {
                0.0
            };

            let a = core_a
                .max(halo_a)
                .max(mid_a)
                .max(out_a)
                .clamp(0.0, 255.0) as u8;

            let idx = ((y * size + x) * 4) as usize;
            out[idx] = r;
            out[idx + 1] = g;
            out[idx + 2] = b;
            out[idx + 3] = a;
        }
    }
    out
}

fn icon_for(kind: &str) -> Image<'static> {
    let (r, g, b) = match kind {
        "running" => (0xFF, 0xB0, 0x20), // amber
        "error" => (0xFF, 0x4D, 0x4F),   // red
        "aborted" => (0xC7, 0x6A, 0x3A), // dim red/orange
        "done" => (0x35, 0xD0, 0x7F),    // green
        _ => (0x56, 0xE3, 0xFF),          // cyan (idle / default)
    };
    Image::new_owned(build_orb_rgba(r, g, b), ICON_SIZE, ICON_SIZE)
}

// ---------------------------------------------------------------------------
// Status text helpers.
// ---------------------------------------------------------------------------

fn truncate_goal(goal: &str) -> String {
    const MAX: usize = 42;
    let trimmed = goal.trim();
    let count = trimmed.chars().count();
    if count <= MAX {
        trimmed.to_string()
    } else {
        let mut s: String = trimmed.chars().take(MAX).collect();
        s.push('…');
        s
    }
}

fn status_header(kind: &str, label: Option<&str>) -> String {
    let goal = label
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(truncate_goal);

    match (kind, goal.as_deref()) {
        ("running", Some(g)) => format!("● Running · {}", g),
        ("running", None) => "● Running…".to_string(),
        ("done", Some(g)) => format!("✓ Done · {}", g),
        ("done", None) => "✓ Done".to_string(),
        ("error", Some(g)) => format!("! Error · {}", g),
        ("error", None) => "! Error".to_string(),
        ("aborted", _) => "⨯ Aborted".to_string(),
        _ => "◉ SUNNY · Ready".to_string(),
    }
}

fn tooltip_for(kind: &str, label: Option<&str>) -> String {
    let prefix = match kind {
        "running" => "Running",
        "error" => "Error",
        "aborted" => "Aborted",
        "done" => "Done",
        _ => "Idle",
    };
    match label {
        Some(l) if !l.trim().is_empty() => format!("SUNNY — {}: {}", prefix, l),
        _ => format!("SUNNY — {}", prefix),
    }
}

// ---------------------------------------------------------------------------
// Menu construction.
// ---------------------------------------------------------------------------

/// Ordered nav destinations exposed in the tray's "Go to" submenu.
/// `id` is the `sunny://nav` payload; `label` is what the user sees.
const NAV_ITEMS: &[(&str, &str)] = &[
    ("overview", "Overview"),
    ("auto", "Auto"),
    ("apps", "Apps"),
    ("files", "Files"),
    ("calendar", "Calendar"),
    ("tasks", "Tasks"),
    ("contacts", "Contacts"),
    ("notes", "Notes"),
    ("memory", "Memory"),
    ("capabilities", "Skills"),
    ("history", "Agent History"),
];

fn build_menu(
    app: &AppHandle,
    kind: &str,
    label: Option<&str>,
    voice_enabled: bool,
) -> tauri::Result<Menu<Wry>> {
    let running = kind == "running";
    let has_run = running || kind == "done" || kind == "error" || kind == "aborted";

    let header = MenuItemBuilder::with_id("tray-header", status_header(kind, label))
        .enabled(false)
        .build(app)?;

    // --- Quick actions (top-level, no submenu) --------------------------
    // Hotkey hint is appended to TALK's label as a macOS-style accelerator
    // string. The actual global binding is deferred (see register_global_
    // shortcuts note near the bottom of this file).
    let talk = MenuItemBuilder::with_id("tray-talk", "Talk  (⌥Space)").build(app)?;
    let capture = MenuItemBuilder::with_id("tray-capture", "Capture Screen").build(app)?;
    let dnd_label = if dnd_is_active() {
        "Disable DND"
    } else {
        "Enable DND"
    };
    let dnd = MenuItemBuilder::with_id("tray-dnd", dnd_label).build(app)?;
    let open = MenuItemBuilder::with_id("tray-open", "Open SUNNY").build(app)?;

    let show = MenuItemBuilder::with_id("tray-show", "Show SUNNY").build(app)?;
    let quick_ask = MenuItemBuilder::with_id("tray-quickask", "Quick Launcher…").build(app)?;

    // --- Go to submenu --------------------------------------------------
    let mut go_builder = SubmenuBuilder::new(app, "Go to");
    for (id, label) in NAV_ITEMS.iter() {
        let item = MenuItemBuilder::with_id(format!("tray-nav-{}", id), *label).build(app)?;
        go_builder = go_builder.item(&item);
    }
    let settings_item =
        MenuItemBuilder::with_id("tray-nav-settings", "Settings").build(app)?;
    let go_submenu = go_builder.separator().item(&settings_item).build()?;

    // --- Voice submenu --------------------------------------------------
    let voice_toggle_label = if voice_enabled {
        "Pause Voice"
    } else {
        "Resume Voice"
    };
    let voice_toggle =
        MenuItemBuilder::with_id("tray-toggle-voice", voice_toggle_label).build(app)?;
    let voice_stop =
        MenuItemBuilder::with_id("tray-stop-speak", "Stop Speaking").build(app)?;
    let voice_submenu = SubmenuBuilder::new(app, "Voice")
        .item(&voice_toggle)
        .item(&voice_stop)
        .build()?;

    // --- Agent submenu --------------------------------------------------
    let abort = MenuItemBuilder::with_id("tray-abort", "Abort Current Run")
        .enabled(running)
        .build(app)?;
    let clear = MenuItemBuilder::with_id("tray-clear", "Clear Run")
        .enabled(has_run && !running)
        .build(app)?;
    let agent_submenu = SubmenuBuilder::new(app, "Agent")
        .item(&abort)
        .item(&clear)
        .build()?;

    // --- Bottom items ---------------------------------------------------
    let prefs = MenuItemBuilder::with_id("tray-prefs", "Preferences…").build(app)?;
    let about = MenuItemBuilder::with_id("tray-about", "About SUNNY").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit SUNNY").build(app)?;

    MenuBuilder::new(app)
        .item(&header)
        .separator()
        .item(&talk)
        .item(&capture)
        .item(&dnd)
        .item(&open)
        .separator()
        .item(&show)
        .item(&quick_ask)
        .separator()
        .item(&go_submenu)
        .item(&voice_submenu)
        .item(&agent_submenu)
        .separator()
        .item(&prefs)
        .item(&about)
        .separator()
        .item(&quit)
        .build()
}

// ---------------------------------------------------------------------------
// install() — called once from lib.rs setup().
// ---------------------------------------------------------------------------

/// Creates the tray icon, attaches the initial menu, and wires up event
/// handlers. The menu will be rebuilt on every subsequent
/// `tray_set_status` call to stay in sync with agent + voice state.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, "idle", None, true)?;

    let tray = TrayIconBuilder::with_id("sunny-tray")
        .icon(icon_for("idle"))
        .tooltip(tooltip_for("idle", None))
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| {
            handle_menu_event(app, event.id().0.as_str());
        })
        .build(app)?;

    if TRAY.set(Mutex::new(tray)).is_err() {
        log::warn!("tray::install called more than once — ignoring duplicate");
    }

    register_global_shortcuts(app);

    Ok(())
}

fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "tray-talk" => trigger_talk(app),
        "tray-capture" => trigger_capture(app),
        "tray-dnd" => trigger_dnd_toggle(app),
        "tray-open" | "tray-show" => focus_main(app),
        "tray-quickask" => {
            focus_main(app);
            let _ = app.emit("sunny://tray/quickask", ());
        }
        "tray-toggle-voice" => {
            let _ = app.emit("sunny://tray/toggle-voice", ());
        }
        "tray-stop-speak" => {
            let _ = app.emit("sunny://tray/stop-speak", ());
        }
        "tray-abort" => {
            let _ = app.emit("sunny://tray/abort", ());
        }
        "tray-clear" => {
            let _ = app.emit("sunny://tray/clear", ());
        }
        "tray-prefs" => {
            focus_main(app);
            let _ = app.emit("sunny://tray/prefs", ());
        }
        "tray-about" => {
            focus_main(app);
            let _ = app.emit("sunny://tray/about", ());
        }
        id if id.starts_with("tray-nav-") => {
            let view = &id["tray-nav-".len()..];
            focus_main(app);
            let _ = app.emit("sunny://nav", view.to_string());
        }
        "tray-quit" => {
            app.exit(0);
        }
        "tray-header" => { /* disabled informational item — no-op */ }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Quick-action handlers.
// ---------------------------------------------------------------------------

/// TALK: fire the push-to-talk event. The frontend `useVoiceChat` hook
/// listens for `sunny://voice.start` and calls its own `pressTalk()` — we
/// deliberately don't start the mic from Rust here because the hook owns
/// the full record → transcribe → LLM → TTS state machine, and racing it
/// with a second recorder would deadlock cpal on macOS.
fn trigger_talk(app: &AppHandle) {
    if let Err(e) = app.emit("sunny://voice.start", ()) {
        log::warn!("tray talk: emit voice.start failed: {e}");
    }
}

/// CAPTURE SCREEN: grab the main display and write a PNG to ~/Desktop with
/// a timestamped filename. Runs on the async runtime so we don't block the
/// menu event handler.
fn trigger_capture(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match vision::capture_full_screen(None).await {
            Ok(img) => match save_capture_to_desktop(&img).await {
                Ok(path) => {
                    let _ = handle.emit("sunny://tray/capture-saved", path.to_string_lossy());
                    log::info!("tray capture: saved to {}", path.display());
                }
                Err(e) => {
                    let _ = handle.emit("sunny://tray/capture-error", e.to_string());
                    log::warn!("tray capture: save failed: {e}");
                }
            },
            Err(e) => {
                let _ = handle.emit("sunny://tray/capture-error", e.clone());
                log::warn!("tray capture: screencapture failed: {e}");
            }
        }
    });
}

async fn save_capture_to_desktop(img: &vision::ScreenImage) -> Result<std::path::PathBuf, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(img.base64.as_bytes())
        .map_err(|e| format!("decode base64: {e}"))?;
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    let desktop = home.join("Desktop");
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let filename = format!("SUNNY-{stamp}.png");
    let target = desktop.join(filename);
    let target_clone = target.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(desktop_dir_of(&target_clone))
            .map_err(|e| format!("mkdir desktop: {e}"))?;
        std::fs::write(&target_clone, &bytes).map_err(|e| format!("write png: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    Ok(target)
}

fn desktop_dir_of(p: &std::path::Path) -> std::path::PathBuf {
    p.parent()
        .map(|s| s.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// TOGGLE DND: persona-aware. When enabling, snapshot which daemons are
/// currently enabled and disable all of them via `daemons::disable_all`,
/// then flip the macOS Focus (Do Not Disturb) shortcut. When disabling,
/// re-enable exactly the daemons we snapshotted (no more, no fewer) and
/// exit Focus.
fn trigger_dnd_toggle(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Read current state and flip.
        let (was_active, ids_to_restore) = {
            let cell = dnd_cell();
            let guard = match cell.lock() {
                Ok(g) => g,
                Err(_) => {
                    log::warn!("tray dnd: state mutex poisoned — skipping");
                    return;
                }
            };
            (guard.active, guard.suspended_ids.clone())
        };

        if was_active {
            // Leaving DND: restore each previously-enabled daemon.
            for id in ids_to_restore {
                if let Err(e) = daemons::daemons_set_enabled(id.clone(), true).await {
                    log::warn!("tray dnd: restore daemon {id} failed: {e}");
                }
            }
            let _ = run_osascript_focus(false).await;
            if let Ok(mut guard) = dnd_cell().lock() {
                guard.active = false;
                guard.suspended_ids.clear();
            }
            let _ = handle.emit("sunny://tray/dnd", false);
        } else {
            // Entering DND: snapshot enabled ids, then disable all.
            let snapshot_ids = match daemons::daemons_list().await {
                Ok(list) => list
                    .into_iter()
                    .filter(|d| d.enabled)
                    .map(|d| d.id)
                    .collect::<Vec<_>>(),
                Err(e) => {
                    log::warn!("tray dnd: daemons_list failed: {e}");
                    Vec::new()
                }
            };
            // `disable_all` is sync; hop onto spawn_blocking to stay polite.
            let _ = tokio::task::spawn_blocking(|| {
                if let Err(e) = daemons::disable_all() {
                    log::warn!("tray dnd: disable_all failed: {e}");
                }
            })
            .await;
            let _ = run_osascript_focus(true).await;
            if let Ok(mut guard) = dnd_cell().lock() {
                guard.active = true;
                guard.suspended_ids = snapshot_ids;
            }
            let _ = handle.emit("sunny://tray/dnd", true);
        }

        // Rebuild the menu so the label flips immediately.
        if let Err(e) = refresh_menu(&handle) {
            log::warn!("tray dnd: menu refresh failed: {e}");
        }
    });
}

/// Invoke the macOS Shortcuts app to toggle the "Do Not Disturb" Focus
/// mode. We rely on a user-created Shortcut named exactly "SUNNY DND On" /
/// "SUNNY DND Off" because Apple removed the private `NotificationCenter`
/// bundle's AppleScript dictionary in Ventura and there is no supported
/// AppleScript verb left for Focus — Shortcuts is the officially blessed
/// automation surface. If the shortcut doesn't exist on this machine we
/// log and move on; daemon suspension still happens either way.
async fn run_osascript_focus(enable: bool) -> Result<(), String> {
    let shortcut_name = if enable { "SUNNY DND On" } else { "SUNNY DND Off" };
    let script = format!(
        "tell application \"Shortcuts Events\" to run shortcut \"{}\"",
        shortcut_name
    );
    let out = tokio::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .await
        .map_err(|e| format!("spawn osascript: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        log::warn!(
            "tray dnd: osascript '{}' exited non-zero: {}",
            shortcut_name,
            stderr.trim()
        );
    }
    Ok(())
}

/// Rebuild the tray menu in place — used by DND toggle so the label
/// flips without waiting for the next `tray_set_status` call.
fn refresh_menu(app: &AppHandle) -> tauri::Result<()> {
    let Some(cell) = TRAY.get() else {
        return Ok(());
    };
    let menu = build_menu(app, "idle", None, true)?;
    if let Ok(guard) = cell.lock() {
        let _ = guard.set_menu(Some(menu));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Global shortcut registration.
// ---------------------------------------------------------------------------

/// Global ⌥Space → TALK binding. Tauri v2 ships this via
/// `tauri-plugin-global-shortcut`, but that plugin is NOT currently in
/// SUNNY's Cargo.toml (see dep list). Adding it pulls a transitive
/// capability grant and a new permission entry, which is out of scope for
/// the tray-polish pass.
///
/// TODO(R14-G follow-up): add `tauri-plugin-global-shortcut = "2"` to
/// `src-tauri/Cargo.toml`, register the plugin in `lib.rs`, grant
/// `global-shortcut:default` in `src-tauri/capabilities/default.json`,
/// and call `app.global_shortcut().register("Alt+Space", ...)` inside
/// `install()` with a callback that invokes `trigger_talk(&app)`.
pub fn register_global_shortcuts(_app: &AppHandle) {
    // Intentionally a no-op until the plugin is added. See TODO above.
}

// ---------------------------------------------------------------------------
// tray_set_status — Tauri command.
// ---------------------------------------------------------------------------

/// Swap the tray icon, tooltip, and menu in response to agent status and
/// voice-setting changes.
///
/// `kind` is one of "idle" | "running" | "done" | "error" | "aborted".
/// `label` is an optional human-readable goal folded into the tooltip and
/// the menu's status header. `voice_enabled` controls whether the Voice
/// submenu's toggle reads "Pause Voice" (true) or "Resume Voice" (false);
/// when omitted we assume voice is enabled.
#[tauri::command]
pub async fn tray_set_status(
    app: AppHandle,
    kind: String,
    label: Option<String>,
    voice_enabled: Option<bool>,
) -> Result<(), String> {
    let cell = TRAY
        .get()
        .ok_or_else(|| "tray not installed yet".to_string())?;

    let icon = icon_for(&kind);
    let tip = tooltip_for(&kind, label.as_deref());
    let menu = build_menu(&app, &kind, label.as_deref(), voice_enabled.unwrap_or(true))
        .map_err(|e| format!("tray menu rebuild failed: {}", e))?;

    let guard = cell
        .lock()
        .map_err(|e| format!("tray mutex poisoned: {}", e))?;

    guard
        .set_icon(Some(icon))
        .map_err(|e| format!("tray set_icon failed: {}", e))?;
    guard
        .set_tooltip(Some(tip))
        .map_err(|e| format!("tray set_tooltip failed: {}", e))?;
    guard
        .set_menu(Some(menu))
        .map_err(|e| format!("tray set_menu failed: {}", e))?;

    Ok(())
}
