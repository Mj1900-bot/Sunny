//! Login Items diff watcher.
//!
//! On macOS the classic login-items list is reachable through System
//! Events via AppleScript:
//!
//!   tell application "System Events"
//!     get the name of every login item
//!   end tell
//!
//! We poll this on the same cadence as LaunchAgents, diff against the
//! previous snapshot, and emit `SecurityEvent::LoginItemDelta` for
//! each change.  The first successful poll just records the baseline.

use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::AppHandle;

use crate::security::{self, SecurityEvent, Severity};

const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// In-memory baseline. We don't persist this — login items are
/// session-level and the baseline naturally rebuilds on next launch.
static BASELINE: OnceLock<Mutex<Option<BTreeSet<String>>>> = OnceLock::new();

fn baseline() -> &'static Mutex<Option<BTreeSet<String>>> {
    BASELINE.get_or_init(|| Mutex::new(None))
}

pub fn start(_app: AppHandle) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_err() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        // First tick fires immediately — snapshot baseline.
        loop {
            ticker.tick().await;
            let names = match current_login_items().await {
                Ok(s) => s,
                Err(e) => {
                    log::debug!("security: login items probe skipped: {e}");
                    continue;
                }
            };
            let mut guard = match baseline().lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            match guard.as_ref() {
                None => {
                    *guard = Some(names);
                }
                Some(prev) => {
                    for added in names.difference(prev) {
                        security::emit(SecurityEvent::LoginItemDelta {
                            at: security::now(),
                            name: added.clone(),
                            change: "added".into(),
                            severity: Severity::Warn,
                        });
                    }
                    for removed in prev.difference(&names) {
                        security::emit(SecurityEvent::LoginItemDelta {
                            at: security::now(),
                            name: removed.clone(),
                            change: "removed".into(),
                            severity: Severity::Info,
                        });
                    }
                    *guard = Some(names);
                }
            }
        }
    });
}

/// Run the AppleScript probe and parse the comma-separated result.
/// Returns an empty set when System Events is unavailable or the user
/// hasn't granted Automation to Sunny — we don't want a denied probe
/// to produce phantom deltas.
pub async fn current_login_items() -> Result<BTreeSet<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use tokio::process::Command;
        use tokio::time::timeout;

        let script = r#"tell application "System Events" to get the name of every login item"#;
        let fat = crate::paths::fat_path().unwrap_or_default();
        let fut = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .env("PATH", fat)
            .output();
        let out = match timeout(Duration::from_secs(6), fut).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(format!("osascript spawn: {e}")),
            Err(_) => return Err("osascript timed out".into()),
        };
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!("osascript exit: {stderr}"));
        }
        let body = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let set: BTreeSet<String> = body
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(set)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(BTreeSet::new())
    }
}

/// Materialise the login-item list for the UI.  Returns a fresh list
/// every call — the backing data is tiny and cheap to probe.
pub async fn list() -> Vec<String> {
    current_login_items()
        .await
        .map(|s| s.into_iter().collect::<Vec<_>>())
        .unwrap_or_default()
}
