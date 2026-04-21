//! File Integrity Monitor for `~/.sunny/*` state files.
//!
//! Tracks SHA-256 of a short allowlist of configuration / state
//! files.  On startup we snapshot every tracked path; a 30 s poll
//! loop recomputes each hash and fires `FileIntegrityChange` on diff.
//!
//! We persist the hash set to `~/.sunny/security/fim_baseline.json`
//! so a restart doesn't forget what it saw last.  Writes Sunny makes
//! herself ARE expected to change these files — the UI can
//! distinguish "changed by Sunny" (emitted as Info) vs "changed while
//! Sunny wasn't looking" (emitted as Warn) by looking at the seq
//! counter below.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use ts_rs::TS;

use super::{SecurityEvent, Severity};

const POLL_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, TS)]
#[ts(export)]
pub struct FimEntry {
    pub path: String,
    pub exists: bool,
    #[ts(type = "number")]
    pub size: u64,
    pub sha256: String,
    #[ts(type = "number")]
    pub modified: i64,
    #[ts(type = "number")]
    pub checked_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, TS)]
#[ts(export)]
pub struct FimBaseline {
    #[ts(type = "number")]
    pub captured_at: i64,
    // No `#[ts(type = ...)]` here: ts-rs natively renders `BTreeMap<String, T>`
    // as `Record<string, T>` AND emits the `import type { T } from "./T"`
    // line. Overriding the type with a literal string (as earlier revisions
    // did) suppresses the import and leaves `FimBaseline.ts` referencing an
    // undefined `FimEntry`, breaking `pnpm build` after every `cargo test`.
    pub entries: BTreeMap<String, FimEntry>,
}

/// Absolute paths (after home-expansion) that FIM tracks.
fn tracked_paths() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let sunny = home.join(".sunny");
    vec![
        sunny.join("settings.json"),
        sunny.join("constitution.json"),
        sunny.join("daemons.json"),
        sunny.join("scheduler.json"),
        sunny.join("world.json"),
        sunny.join("security").join("canary.txt"),
        sunny.join("security").join("launch_baseline.json"),
    ]
}

pub fn start(_app: AppHandle) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Initial snapshot — write baseline if missing, diff against
        // it if present.  Either way, we always persist the fresh
        // state at the end.
        let fresh = scan_now();
        let prev = read_baseline().unwrap_or_default();
        emit_diff(&prev, &fresh);
        let _ = write_baseline(&fresh);

        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.tick().await; // consume immediate tick
        loop {
            ticker.tick().await;
            let fresh = scan_now();
            let prev = read_baseline().unwrap_or_default();
            emit_diff(&prev, &fresh);
            if fresh != prev {
                let _ = write_baseline(&fresh);
            }
        }
    });
}

fn emit_diff(prev: &FimBaseline, cur: &FimBaseline) {
    for (path, entry) in &cur.entries {
        match prev.entries.get(path) {
            None => {
                // First time we've seen this file — emit at Info
                // severity so the audit log carries a baseline.
                if entry.exists {
                    super::emit(SecurityEvent::FileIntegrityChange {
                        at: super::now(),
                        path: path.clone(),
                        prev_sha256: None,
                        curr_sha256: entry.sha256.clone(),
                        severity: Severity::Info,
                    });
                }
            }
            Some(p) => {
                if p.sha256 != entry.sha256 || p.exists != entry.exists {
                    // Severity: tracked config change = Warn.  The
                    // user can classify it as "expected" via the UI
                    // (Phase 2); Phase 1 just records the delta.
                    let severity = if path.contains("settings.json") || path.contains("constitution.json") {
                        Severity::Warn
                    } else { Severity::Info };
                    super::emit(SecurityEvent::FileIntegrityChange {
                        at: super::now(),
                        path: path.clone(),
                        prev_sha256: Some(p.sha256.clone()),
                        curr_sha256: entry.sha256.clone(),
                        severity,
                    });
                }
            }
        }
    }
    // Files that disappeared from the fs since last baseline.
    for (path, prev_entry) in &prev.entries {
        if !cur.entries.contains_key(path) && prev_entry.exists {
            super::emit(SecurityEvent::FileIntegrityChange {
                at: super::now(),
                path: path.clone(),
                prev_sha256: Some(prev_entry.sha256.clone()),
                curr_sha256: "missing".into(),
                severity: Severity::Warn,
            });
        }
    }
}

pub fn scan_now() -> FimBaseline {
    let mut out = FimBaseline {
        captured_at: super::now(),
        entries: BTreeMap::new(),
    };
    for path in tracked_paths() {
        let key = path.to_string_lossy().to_string();
        let entry = match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let sha = std::fs::read(&path)
                    .map(|b| {
                        let mut h = Sha256::new();
                        h.update(&b);
                        format!("{:x}", h.finalize())
                    })
                    .unwrap_or_default();
                FimEntry {
                    path: key.clone(),
                    exists: true,
                    size: meta.len(),
                    sha256: sha,
                    modified,
                    checked_at: out.captured_at,
                }
            }
            _ => FimEntry {
                path: key.clone(),
                exists: false,
                size: 0,
                sha256: String::new(),
                modified: 0,
                checked_at: out.captured_at,
            },
        };
        out.entries.insert(key, entry);
    }
    out
}

fn baseline_path() -> PathBuf {
    super::resolve_data_dir().join("fim_baseline.json")
}

fn read_baseline() -> Result<FimBaseline, String> {
    let body = std::fs::read_to_string(baseline_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn write_baseline(b: &FimBaseline) -> Result<(), String> {
    let path = baseline_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(b).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

pub fn current_baseline() -> FimBaseline {
    scan_now()
}
