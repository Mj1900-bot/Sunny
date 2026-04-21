//! FS-burst sensor — watches `~/Projects` for file-save bursts.
//!
//! Uses `tokio::fs` polling instead of the `notify` crate to avoid
//! adding a new dependency. Walks the top-level `~/Projects` directory
//! every 2 seconds, counts `.modified` timestamps that fall within
//! the last 5-second window, and fires a `AutopilotSignal` if >3 distinct
//! files were saved within that window.
//!
//! No panics: every fallible operation is caught and logged; the
//! supervisor restarts the task if it returns unexpectedly.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::Utc;

use crate::event_bus::{self, SunnyEvent};
use crate::supervise;

const POLL_INTERVAL_SECS: u64 = 2;
/// Detection window: saves within this many seconds count toward burst.
const BURST_WINDOW_SECS: u64 = 5;
/// Minimum distinct file saves in the window to trigger.
const BURST_THRESHOLD: usize = 3;
/// Maximum directory depth scanned to keep overhead low.
const MAX_DEPTH: usize = 3;

/// Spawn the supervised sensor task.
pub fn spawn() {
    supervise::spawn_supervised("autopilot_sensor_fs_burst", || async {
        run_fs_burst_loop().await;
    });
}

async fn run_fs_burst_loop() {
    let watch_dir = match watch_root() {
        Some(p) => p,
        None => {
            log::warn!("[autopilot/fs_burst] $HOME not set, sensor disabled");
            return;
        }
    };

    // mtime cache: path → last-seen mtime (unix secs).
    let mut seen_mtimes: HashMap<PathBuf, u64> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;

        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let cutoff = now_unix.saturating_sub(BURST_WINDOW_SECS);

        // Collect files modified in the burst window.
        let recent = match scan_recent(&watch_dir, cutoff, MAX_DEPTH) {
            Ok(r) => r,
            Err(e) => {
                log::debug!("[autopilot/fs_burst] scan error: {e}");
                continue;
            }
        };

        // Deduplicate against what we already know about: only count newly
        // changed files (mtime moved forward) to avoid re-firing on stable
        // files whose mtime happens to be within the window.
        let newly_changed: Vec<&PathBuf> = recent
            .iter()
            .filter(|(path, mtime)| {
                seen_mtimes
                    .get(path)
                    .map(|prev| mtime > prev)
                    .unwrap_or(true)
            })
            .map(|(path, _)| path)
            .collect();

        // Update cache with all entries in window (whether new or not).
        for (path, mtime) in &recent {
            seen_mtimes.insert(path.clone(), *mtime);
        }

        if newly_changed.len() >= BURST_THRESHOLD {
            let paths: Vec<String> = newly_changed
                .iter()
                .take(10)
                .filter_map(|p| p.to_str().map(|s| s.to_string()))
                .collect();

            let payload = serde_json::json!({
                "count": newly_changed.len(),
                "window_secs": BURST_WINDOW_SECS,
                "sample_paths": paths,
            })
            .to_string();

            event_bus::publish(SunnyEvent::AutopilotSignal {
                seq: 0,
                boot_epoch: 0,
                source: "fs_burst".to_string(),
                payload,
                at: Utc::now().timestamp_millis(),
            });
        }
    }
}

fn watch_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Projects"))
}

/// Recursively scan `dir` up to `max_depth` levels, returning files whose
/// mtime (unix secs) is >= `cutoff`.
fn scan_recent(
    dir: &PathBuf,
    cutoff: u64,
    max_depth: usize,
) -> Result<Vec<(PathBuf, u64)>, String> {
    let mut results = Vec::new();
    scan_recursive(dir, cutoff, max_depth, 0, &mut results)?;
    Ok(results)
}

fn scan_recursive(
    dir: &PathBuf,
    cutoff: u64,
    max_depth: usize,
    depth: usize,
    results: &mut Vec<(PathBuf, u64)>,
) -> Result<(), String> {
    if depth > max_depth {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?;

    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if meta.is_dir() {
            // Don't descend into hidden dirs or common noisy dirs.
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let _ = scan_recursive(&path, cutoff, max_depth, depth + 1, results);
        } else if meta.is_file() {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if mtime >= cutoff {
                results.push((path, mtime));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_threshold_is_positive() {
        assert!(BURST_THRESHOLD > 0);
    }

    #[test]
    fn burst_window_is_positive() {
        assert!(BURST_WINDOW_SECS > 0);
    }

    #[test]
    fn scan_recent_on_nonexistent_dir_returns_err() {
        let p = PathBuf::from("/this/path/does/not/exist/for/real");
        let result = scan_recent(&p, 0, 2);
        assert!(result.is_err());
    }

    #[test]
    fn scan_recent_on_tempdir_returns_ok() {
        let tmp = std::env::temp_dir();
        let result = scan_recent(&tmp, 0, 1);
        assert!(result.is_ok());
    }

    #[test]
    fn payload_json_shape_is_valid() {
        let payload = serde_json::json!({
            "count": 5,
            "window_secs": BURST_WINDOW_SECS,
            "sample_paths": ["/foo/bar.rs"],
        })
        .to_string();
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["count"], 5);
    }
}
