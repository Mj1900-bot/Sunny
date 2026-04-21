//! LaunchAgents / LaunchDaemons diff watcher.
//!
//! On first run we snapshot every plist under
//!
//!   - `~/Library/LaunchAgents`
//!   - `/Library/LaunchAgents`
//!   - `/Library/LaunchDaemons`
//!
//! to `<data_dir>/launch_baseline.json`. Subsequent polls diff the
//! on-disk state against that baseline and emit
//! `SecurityEvent::LaunchAgentDelta` on any new / removed / modified
//! entry. Severity ramps up when a new plist lives in the user dir
//! (common drop target for stealers) — see `classify_delta`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::AppHandle;
use ts_rs::TS;

use crate::security::{self, SecurityEvent, Severity};

const POLL_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, TS)]
#[ts(export)]
pub struct PlistEntry {
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub modified: i64,
    /// SHA-1 of the plist body. SHA-1 is fine here — we're detecting
    /// tampering against our own baseline, not adversarial collisions.
    pub sha1: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, TS)]
#[ts(export)]
pub struct LaunchBaseline {
    #[ts(type = "number")]
    pub captured_at: i64,
    /// Map keyed by absolute path for O(1) delta comparison.
    // Let ts-rs render `BTreeMap<String, PlistEntry>` natively —
    // `#[ts(type = "Record<string, PlistEntry>")]` suppresses the
    // auto-emitted `import type { PlistEntry }` line and produces a
    // binding that fails `tsc -b`.
    pub entries: BTreeMap<String, PlistEntry>,
}

/// What we return from `security_launch_diff`.
#[derive(Serialize, Deserialize, Debug, Clone, Default, TS)]
#[ts(export)]
pub struct LaunchDiff {
    #[ts(type = "number")]
    pub baseline_captured_at: i64,
    pub added: Vec<PlistEntry>,
    pub removed: Vec<PlistEntry>,
    pub changed: Vec<PlistChange>,
    #[ts(type = "number")]
    pub unchanged_count: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export)]
pub struct PlistChange {
    pub path: String,
    pub previous: PlistEntry,
    pub current: PlistEntry,
}

pub fn start(_app: AppHandle) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_err() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        // Bootstrap baseline if missing. Never fails loudly — the
        // watcher is best-effort security hygiene, not a blocker.
        let baseline_path = baseline_path();
        if !baseline_path.exists() {
            match scan_current().await {
                Ok(baseline) => {
                    if let Err(e) = write_baseline(&baseline) {
                        log::warn!("security: launch baseline write failed: {e}");
                    } else {
                        security::emit(SecurityEvent::Notice {
                            at: security::now(),
                            source: "launch_agents".into(),
                            message: format!("initial baseline captured ({} entries)", baseline.entries.len()),
                            severity: Severity::Info,
                        });
                    }
                }
                Err(e) => log::warn!("security: initial launch scan failed: {e}"),
            }
        }

        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        // Skip the immediate first tick — we just bootstrapped.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(e) = poll_once().await {
                log::warn!("security: launch poll failed: {e}");
            }
        }
    });
}

async fn poll_once() -> Result<(), String> {
    let baseline = read_baseline().unwrap_or_default();
    let current = scan_current().await?;
    let diff = diff_maps(&baseline, &current);

    for e in &diff.added {
        let severity = classify_delta(&e.path, "added");
        security::emit(SecurityEvent::LaunchAgentDelta {
            at: security::now(),
            path: e.path.clone(),
            change: "added".into(),
            sha1: Some(e.sha1.clone()),
            severity,
        });
    }
    for e in &diff.removed {
        let severity = classify_delta(&e.path, "removed");
        security::emit(SecurityEvent::LaunchAgentDelta {
            at: security::now(),
            path: e.path.clone(),
            change: "removed".into(),
            sha1: Some(e.sha1.clone()),
            severity,
        });
    }
    for c in &diff.changed {
        let severity = classify_delta(&c.path, "modified");
        security::emit(SecurityEvent::LaunchAgentDelta {
            at: security::now(),
            path: c.path.clone(),
            change: "modified".into(),
            sha1: Some(c.current.sha1.clone()),
            severity,
        });
    }
    Ok(())
}

fn classify_delta(path: &str, change: &str) -> Severity {
    // A brand-new LaunchAgent inside a user dir is the classic stealer
    // persistence pattern — bump to Warn.  Modifications to existing
    // system plists are Info (Apple / system tooling writes these
    // routinely), removals of user-dir items are Info too.
    let in_user_dir = path.contains("/Users/") && !path.contains("/Library/LaunchAgents/com.apple.");
    let in_daemons = path.contains("/LaunchDaemons/");
    match (change, in_user_dir, in_daemons) {
        ("added", true, _) => Severity::Warn,
        ("added", _, true) => Severity::Warn,
        ("modified", _, true) => Severity::Warn,
        _ => Severity::Info,
    }
}

fn search_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Library/LaunchAgents"),
        PathBuf::from("/Library/LaunchDaemons"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Library/LaunchAgents"));
    }
    roots
}

async fn scan_current() -> Result<LaunchBaseline, String> {
    tokio::task::spawn_blocking(move || -> Result<LaunchBaseline, String> {
        let mut out = LaunchBaseline {
            captured_at: security::now(),
            entries: BTreeMap::new(),
        };
        for root in search_roots() {
            scan_dir(&root, &mut out.entries);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

fn scan_dir(dir: &Path, out: &mut BTreeMap<String, PlistEntry>) {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("plist") {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let body = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let mut hasher = Sha1::new();
        hasher.update(&body);
        let sha1 = format!("{:x}", hasher.finalize());

        let rec = PlistEntry {
            path: path.to_string_lossy().to_string(),
            size: meta.len(),
            modified,
            sha1,
        };
        out.insert(rec.path.clone(), rec);
    }
}

fn diff_maps(a: &LaunchBaseline, b: &LaunchBaseline) -> LaunchDiff {
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    let mut unchanged = 0usize;

    for (path, entry) in &b.entries {
        match a.entries.get(path) {
            None => added.push(entry.clone()),
            Some(prev) if prev.sha1 != entry.sha1 => {
                changed.push(PlistChange {
                    path: path.clone(),
                    previous: prev.clone(),
                    current: entry.clone(),
                });
            }
            Some(_) => unchanged += 1,
        }
    }
    for (path, prev) in &a.entries {
        if !b.entries.contains_key(path) {
            removed.push(prev.clone());
        }
    }

    LaunchDiff {
        baseline_captured_at: a.captured_at,
        added,
        removed,
        changed,
        unchanged_count: unchanged,
    }
}

fn baseline_path() -> PathBuf {
    security::resolve_data_dir().join("launch_baseline.json")
}

fn read_baseline() -> Result<LaunchBaseline, String> {
    let path = baseline_path();
    let body = std::fs::read_to_string(&path).map_err(|e| format!("read baseline: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("parse baseline: {e}"))
}

fn write_baseline(b: &LaunchBaseline) -> Result<(), String> {
    let path = baseline_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(b).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write: {e}"))
}

// -------------------- Commands-facing helpers --------------------

/// Current baseline (first snapshot) on disk. Callers can use this to
/// render "when was the baseline last re-captured" and to drive the
/// diff display on the Intrusion tab.
pub fn load_baseline() -> LaunchBaseline {
    read_baseline().unwrap_or_default()
}

/// Compute the current diff against the stored baseline, without
/// updating the baseline. Does a live filesystem scan.
pub async fn current_diff() -> Result<LaunchDiff, String> {
    let baseline = read_baseline().unwrap_or_default();
    let current = scan_current().await?;
    Ok(diff_maps(&baseline, &current))
}

/// Rewrite the baseline to the current filesystem state, returning the
/// new entry count. Used by the "mark reviewed" button on the
/// Intrusion tab so old adds stop surfacing once the user has triaged
/// them.
pub async fn reset_baseline() -> Result<usize, String> {
    let current = scan_current().await?;
    let count = current.entries.len();
    write_baseline(&current)?;
    Ok(count)
}
