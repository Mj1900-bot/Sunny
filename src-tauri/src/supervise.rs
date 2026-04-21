//! Panic-supervised task spawner.
//!
//! Every long-lived HUD loop (metrics emitter, processes/battery emitter,
//! clipboard sniffer, etc.) is a `tokio::spawn` that runs forever. A raw
//! `spawn` has no supervision: a single bad sample — a panicking metrics
//! probe, a poisoned mutex, a malformed clipboard payload — kills the
//! task permanently and the HUD goes dark until the user restarts the
//! app. This is the fix.
//!
//! `spawn_supervised` wraps a spawn factory in an outer supervisor task
//! that restarts the inner future if it panics, with a 2s back-off so
//! we don't thrash on a deterministic crash. Clean exits and
//! cancellations are not restarted (those are intentional).
//!
//! Sprint-12 ε: every panic-restart increments a per-task counter
//! readable via [`restarts_snapshot`] — the Diagnostics page uses this
//! to surface supervisor churn without having to grep logs.
//!
//! Usage:
//! ```ignore
//! supervise::spawn_supervised("metrics_emitter", move || {
//!     let handle = handle.clone();
//!     async move {
//!         // your loop here — panics trigger an automatic restart
//!     }
//! });
//! ```

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use once_cell::sync::Lazy;

/// Per-task panic-restart counters. One entry per distinct task name
/// ever passed to [`spawn_supervised`]. Values only increase.
static RESTARTS: Lazy<Mutex<HashMap<&'static str, AtomicU64>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Read-only snapshot of supervisor restart counts, one entry per
/// supervised task that has ever panicked or started cleanly. Used by
/// the Diagnostics page.
pub fn restarts_snapshot() -> Vec<(String, u64)> {
    let Ok(map) = RESTARTS.lock() else {
        return Vec::new();
    };
    let mut out: Vec<(String, u64)> = map
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.load(Ordering::Relaxed)))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn bump_restart(name: &'static str) {
    if let Ok(mut map) = RESTARTS.lock() {
        map.entry(name)
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }
}

/// Register a supervised task name at spawn time with an initial count
/// of 0, so the Diagnostics page can list every task the app supervises
/// — not just the ones that have panicked.
fn register_task(name: &'static str) {
    if let Ok(mut map) = RESTARTS.lock() {
        map.entry(name).or_insert_with(|| AtomicU64::new(0));
    }
}

/// Spawn a long-lived task under a panic-restart supervisor.
///
/// The `spawn_factory` is invoked once per attempt. If the returned
/// future panics, the supervisor logs the panic, sleeps 2s, and calls
/// `spawn_factory` again to produce a fresh future. If the future
/// returns `()` cleanly or is cancelled, the supervisor exits.
///
/// The factory must be `Fn` (not `FnOnce`) because it may be invoked
/// more than once across restarts, and `Send + Sync + 'static` because
/// it lives inside a spawned task.
pub fn spawn_supervised<F, Fut>(name: &'static str, spawn_factory: F)
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    // Register the task name up front so the Diagnostics page can
    // enumerate every supervised task, not just the ones that have
    // panicked. The entry starts at 0 restarts.
    register_task(name);

    // `tauri::async_runtime::spawn` enters the Tauri-managed tokio runtime
    // handle before calling `tokio::spawn`. A raw `tokio::spawn` here
    // panics when called from Tauri's `setup()` hook — setup runs on
    // the main thread BEFORE the runtime context is entered, and tokio
    // aborts with "there is no reactor running, must be called from the
    // context of a Tokio 1.x runtime". The inner `tokio::task::spawn`
    // below is fine because by then we're executing INSIDE the future
    // body, which runs on the runtime. Crash report 2026-04-19-183536.
    tauri::async_runtime::spawn(async move {
        loop {
            let fut = spawn_factory();
            let result = tokio::task::spawn(fut).await;
            match result {
                Ok(()) => {
                    log::info!("[supervise] task `{name}` exited cleanly");
                    return;
                }
                Err(e) if e.is_panic() => {
                    bump_restart(name);
                    log::error!(
                        "[supervise] task `{name}` panicked: {e:?} — restarting in 2s"
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                Err(e) => {
                    log::warn!("[supervise] task `{name}` cancelled: {e:?}");
                    return;
                }
            }
        }
    });
}
