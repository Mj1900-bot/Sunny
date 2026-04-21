//! Tick loop — samples fast sources every tick, slow sources every 4th,
//! and drives focus-change side-effects + periodic persistence.

use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::classifier::classify_activity;
use super::helpers::{iso_to_unix, local_iso_now, now_millis, now_secs};
use super::model::{AppSwitch, FocusSnapshot, SCHEMA_VERSION, WorldState};
use super::persist::persist_to_disk;
use super::side_effects::{spawn_focus_episode, spawn_focus_ocr};
use super::state::{get_arc, set_state};
use crate::ax;
use crate::calendar::{self, CalendarEvent};
use crate::event_bus::{self, SunnyEvent};
use crate::mail;
use crate::metrics;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const TICK_SECS: u64 = 15;
const SLOW_REFRESH_EVERY_N_TICKS: u64 = 4; // = 60s at 15s tick
const RECENT_SWITCHES: usize = 8;
const PERSIST_EVERY_N_TICKS: u64 = 8; // = 120s at 15s tick

// ---------------------------------------------------------------------------
// Updater entry point
// ---------------------------------------------------------------------------

pub(super) async fn run_updater(app: AppHandle) {
    let mut tick_ix: u64 = 0;
    // Slow-source caches — refreshed every SLOW_REFRESH_EVERY_N_TICKS ticks.
    let mut cached_events: Vec<CalendarEvent> = Vec::new();
    let mut cached_mail_unread: Option<i64> = None;

    loop {
        tick_ix = tick_ix.wrapping_add(1);
        let slow_refresh = tick_ix % SLOW_REFRESH_EVERY_N_TICKS == 0 || tick_ix == 1;

        if slow_refresh {
            cached_events = sample_calendar_next_24h().await;
            cached_mail_unread = sample_mail_unread().await;
        }

        let prev = get_arc();
        let next = sample_world(&prev, &cached_events, cached_mail_unread).await;

        // Side effects: focus-change event + episodic row, and periodic
        // persistence. Compute whether we should persist BEFORE moving
        // `next` into set_state.
        let focus_changed = !same_focus(&prev, &next);
        let should_persist = focus_changed || tick_ix % PERSIST_EVERY_N_TICKS == 0;

        // Clone what we need downstream — the emit + persist consume values
        // by reference but set_state takes ownership.
        let to_store = next.clone();
        let next_for_emit = next.clone();
        set_state(to_store);

        // Fire frontend events. Swallow errors — a missing listener should
        // never back up the updater.
        let _ = app.emit("sunny://world", &next_for_emit);

        // Mirror onto the persistent event bus so subscribers (e.g. the
        // ambient watcher) can tail `WorldTick` without coupling to the
        // Tauri event loop. `publish` is non-blocking and swallows its
        // own errors, so it cannot stretch the tick.
        event_bus::publish(SunnyEvent::WorldTick {
            seq: 0,
            boot_epoch: 0,
            revision: next_for_emit.revision,
            focus_app: next_for_emit
                .focus
                .as_ref()
                .map(|f| f.app_name.clone()),
            activity: next_for_emit.activity.as_str().to_string(),
            at: next_for_emit.timestamp_ms,
        });

        if focus_changed {
            let _ = app.emit("sunny://world.focus", &next_for_emit.focus);
            // Best-effort episodic perception row. Doesn't block the tick.
            spawn_focus_episode(&prev, &next_for_emit);
            // Best-effort screen OCR (opt-in). Captures the active window,
            // runs tesseract, writes a short summary to episodic. Quiet
            // no-op when the setting is off / tesseract missing / rate
            // limit exceeded.
            spawn_focus_ocr(&next_for_emit);
        }

        if should_persist {
            // Spawn so fs I/O doesn't stretch the tick period.
            let snapshot = next_for_emit.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = persist_to_disk(&snapshot) {
                    log::debug!("world persist: {e}");
                }
            });
        }

        tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
    }
}

async fn sample_world(
    prev: &WorldState,
    cached_events: &[CalendarEvent],
    cached_mail_unread: Option<i64>,
) -> WorldState {
    let now_s = now_secs();
    let now_ms = now_millis();

    let (focus, focused_duration_secs, recent_switches) =
        resolve_focus(prev, now_s).await;

    let (cpu_pct, mem_pct, temp_c, host) = sample_metrics();
    let battery = metrics::battery();

    let activity = classify_activity(focus.as_ref(), now_s, prev);
    let os_version = super::helpers::os_version_hint();

    let next_event = next_upcoming(cached_events, now_s);
    let events_today = cached_events.iter().filter(|e| is_today(&e.start, now_s)).count();

    let revision = prev.revision.wrapping_add(1);

    WorldState {
        schema_version: SCHEMA_VERSION,
        timestamp_ms: now_ms,
        local_iso: local_iso_now(),
        host,
        os_version,
        focus,
        focused_duration_secs,
        activity,
        recent_switches,
        next_event,
        events_today,
        mail_unread: cached_mail_unread,
        cpu_pct,
        temp_c,
        mem_pct,
        battery_pct: battery.as_ref().map(|b| b.percent as f64),
        battery_charging: battery.as_ref().map(|b| b.charging),
        idle_secs: sample_idle_secs(),
        revision,
    }
}

// ---------------------------------------------------------------------------
// Samplers
// ---------------------------------------------------------------------------

async fn resolve_focus(
    prev: &WorldState,
    now_s: i64,
) -> (Option<FocusSnapshot>, i64, Vec<AppSwitch>) {
    let focused = ax::focused_app().await.ok();
    let title = ax::active_window_title().await.unwrap_or_default();

    let snap = focused.map(|f| FocusSnapshot {
        app_name: f.name,
        bundle_id: f.bundle_id,
        window_title: title,
        focused_since_secs: now_s,
    });

    let (snap_out, duration, switches) = match (snap, &prev.focus) {
        (Some(mut new), Some(prev_focus))
            if focus_matches(&new, prev_focus) =>
        {
            // Same app as last tick — keep the original focused_since_secs
            // so `focused_duration_secs` reflects total dwell, not the
            // per-tick delta.
            new.focused_since_secs = prev_focus.focused_since_secs;
            let dur = now_s.saturating_sub(new.focused_since_secs);
            (Some(new), dur, prev.recent_switches.clone())
        }
        (Some(new), prev_focus_opt) => {
            // Focus changed (or is the first observation). Record the
            // switch for recent_switches and start the dwell clock.
            let mut switches = prev.recent_switches.clone();
            if let Some(pf) = prev_focus_opt {
                switches.insert(
                    0,
                    AppSwitch {
                        from_app: pf.app_name.clone(),
                        to_app: new.app_name.clone(),
                        at_secs: now_s,
                    },
                );
                switches.truncate(RECENT_SWITCHES);
            }
            (Some(new), 0, switches)
        }
        (None, _) => {
            // Couldn't read focus (permission denied / osascript error).
            // Keep the previous known focus so we don't flap the activity
            // classifier between "coding" and "unknown".
            (
                prev.focus.clone(),
                prev.focused_duration_secs,
                prev.recent_switches.clone(),
            )
        }
    };

    (snap_out, duration, switches)
}

pub(super) fn focus_matches(a: &FocusSnapshot, b: &FocusSnapshot) -> bool {
    // Prefer bundle id when we have one on both sides — title alone is too
    // volatile (every tab-switch would register as an app-switch).
    match (&a.bundle_id, &b.bundle_id) {
        (Some(x), Some(y)) => x == y,
        _ => a.app_name.eq_ignore_ascii_case(&b.app_name),
    }
}

fn same_focus(prev: &WorldState, next: &WorldState) -> bool {
    match (&prev.focus, &next.focus) {
        (None, None) => true,
        (Some(p), Some(n)) => focus_matches(p, n),
        _ => false,
    }
}

/// Query IOHIDSystem for hardware idle time (macOS only).
/// Returns seconds since last HID event; 0 on any error or non-macOS.
fn sample_idle_secs() -> i64 {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        // `ioreg -c IOHIDSystem` outputs a property list that contains
        // `HIDIdleTime` in nanoseconds.  Best-effort parse avoids a
        // CoreFoundation dependency and keeps this unit-testable.
        if let Ok(out) = Command::new("ioreg")
            .args(["-c", "IOHIDSystem", "-d", "4"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.contains("HIDIdleTime") {
                    // Value appears as: `"HIDIdleTime" = 12345678901`
                    if let Some(eq_part) = line.split('=').nth(1) {
                        let trimmed = eq_part.trim();
                        if let Ok(ns) = trimmed.parse::<u64>() {
                            return (ns / 1_000_000_000) as i64;
                        }
                    }
                }
            }
        }
    }
    0
}

fn sample_metrics() -> (f32, f32, f32, String) {
    // Use a short-lived local collector rather than reaching into the
    // shared AppState — avoids cross-module lock contention with the main
    // metrics emitter (which already ticks every 1.4s).
    use std::sync::Mutex as StdMutex;
    use std::sync::OnceLock;
    static LOCAL: OnceLock<StdMutex<metrics::Collector>> = OnceLock::new();
    let cell = LOCAL.get_or_init(|| StdMutex::new(metrics::Collector::new()));
    let Ok(mut guard) = cell.lock() else {
        return (0.0, 0.0, 0.0, "".to_string());
    };
    let sample = guard.sample();
    (sample.cpu, sample.mem_pct, sample.temp_c, sample.host)
}

async fn sample_calendar_next_24h() -> Vec<CalendarEvent> {
    let now = chrono::Local::now();
    let end = now + chrono::Duration::hours(24);
    let start_iso = now.format("%Y-%m-%dT%H:%M:%S").to_string();
    let end_iso = end.format("%Y-%m-%dT%H:%M:%S").to_string();
    calendar::list_events_range(start_iso, end_iso, None, Some(40))
        .await
        .unwrap_or_default()
}

async fn sample_mail_unread() -> Option<i64> {
    // Mail access trips a permission prompt on first call. Swallow errors
    // and return None — the UI shows "—" rather than red text.
    mail::unread_count().await.ok()
}

fn next_upcoming(events: &[CalendarEvent], now_s: i64) -> Option<CalendarEvent> {
    let mut pairs: Vec<(i64, &CalendarEvent)> = events
        .iter()
        .filter_map(|e| iso_to_unix(&e.start).map(|t| (t, e)))
        .filter(|(t, _)| *t >= now_s)
        .collect();
    pairs.sort_by_key(|(t, _)| *t);
    pairs.into_iter().next().map(|(_, e)| e.clone())
}

fn is_today(iso_start: &str, now_s: i64) -> bool {
    use chrono::TimeZone;
    let Some(t) = iso_to_unix(iso_start) else { return false };
    let now_local = chrono::Local.timestamp_opt(now_s, 0).single();
    let ev_local = chrono::Local.timestamp_opt(t, 0).single();
    match (now_local, ev_local) {
        (Some(n), Some(e)) => n.date_naive() == e.date_naive(),
        _ => false,
    }
}
