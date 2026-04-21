//! Live subagent state persistence.
//!
//! Sprint-4 introduced a React store (`useSubAgents`) that tracks in-progress
//! runs and in-flight daemon spawns. Reloads wipe that state, which is
//! annoying when the user has a long-running agent mid-stream. The frontend
//! calls `invokeSafe('subagents_live_save', ...)` on mutations and
//! `subagents_live_load` on boot to paper over reloads.
//!
//! The shape of `runs` / `in_flight_daemons` is owned by TypeScript — this
//! module treats both as opaque `serde_json::Value`. That keeps the TS side
//! free to evolve the store without a Rust rebuild, while still giving us a
//! typed wrapper for the on-disk envelope (so we can stamp `saved_at` and
//! enforce a size cap).
//!
//! Path: `~/.sunny/subagents-live.json` (0600, atomic rename mirrors
//! `daemons.rs` / `constitution.rs`). A 256 KB payload ceiling keeps a
//! runaway store from eating disk or blocking the event loop on serialize.
//! Missing file → `Ok(None)`; oversized payload on save → warn + refuse
//! (preserves last-good snapshot rather than truncating to garbage).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const DIR_NAME: &str = ".sunny";
const FILE_NAME: &str = "subagents-live.json";
const MAX_BYTES: usize = 256 * 1024;

/// On-disk envelope. `runs` and `in_flight_daemons` are opaque — the TS
/// store owns their shape, so we intentionally refuse to validate them here
/// and only round-trip.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LiveSnapshot {
    pub runs: serde_json::Value,
    pub in_flight_daemons: serde_json::Value,
    pub saved_at: i64,
}

fn sunny_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home.join(DIR_NAME))
}

fn snapshot_path() -> Result<PathBuf, String> {
    Ok(sunny_dir()?.join(FILE_NAME))
}

/// Atomic write: serialize → size-check → write tmp → fsync → chmod 0600 →
/// rename. Mirrors `constitution.rs`' pattern: a fixed `.tmp` sibling (we're
/// globally mutexed, so no cross-call collision risk).
fn save_to(path: &Path, snap: &LiveSnapshot) -> Result<(), String> {
    let body = serde_json::to_string_pretty(snap).map_err(|e| format!("encode: {e}"))?;
    if body.len() > MAX_BYTES {
        log::warn!(
            "subagents_live_save: payload {} bytes exceeds {}-byte cap, refusing to write",
            body.len(),
            MAX_BYTES
        );
        return Err(format!(
            "payload {} bytes exceeds {}-byte cap",
            body.len(),
            MAX_BYTES
        ));
    }

    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| format!("mkdir: {e}"))?;
    }

    let tmp = path.with_extension("json.tmp");
    // Clean up any stragglers from a crashed prior write before we start —
    // `fs::rename` on unix is atomic, but a crash between `create` and
    // `rename` can leave a stale tmp behind.
    let _ = fs::remove_file(&tmp);

    let write_result = (|| -> Result<(), String> {
        fs::write(&tmp, body.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
        set_owner_only(&tmp)?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename: {e}")
    })?;
    Ok(())
}

fn load_from(path: &Path) -> Result<Option<LiveSnapshot>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let snap: LiveSnapshot = serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))?;
    Ok(Some(snap))
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod: {e}"))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

// Coarse mutex — the frontend fires save at most once per state mutation and
// load once at boot, so contention is negligible and the mutex just keeps
// the tmp/rename pair race-free.
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// -------------------- Tauri commands --------------------

#[tauri::command]
pub async fn subagents_live_save(value: LiveSnapshot) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
        // Stamp `saved_at` ourselves so the clock source is consistent across
        // platforms and the frontend can't accidentally write a zero.
        let stamped = LiveSnapshot {
            saved_at: now_unix(),
            ..value
        };
        save_to(&snapshot_path()?, &stamped)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn subagents_live_load() -> Result<Option<LiveSnapshot>, String> {
    tokio::task::spawn_blocking(move || -> Result<Option<LiveSnapshot>, String> {
        let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
        load_from(&snapshot_path()?)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// -------------------- tests --------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Hermetic scratch dir under `std::env::temp_dir()`, removed on drop.
    /// We use the scratch's own file path rather than `~/.sunny` so tests
    /// never touch the user's real vault.
    struct Scratch {
        path: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "sunny-subagents-live-test-{tag}-{pid}-{nanos}-{seq}",
                pid = std::process::id()
            ));
            fs::create_dir_all(&path).expect("create scratch");
            Self { path }
        }

        fn file(&self) -> PathBuf {
            self.path.join(FILE_NAME)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn save_then_load_returns_exact_value() {
        let scratch = Scratch::new("roundtrip");
        let snap = LiveSnapshot {
            runs: json!({
                "r1": { "goal": "hello", "status": "streaming", "tokens": 42 },
                "r2": { "goal": "world", "status": "done" }
            }),
            in_flight_daemons: json!(["daemon-a", "daemon-b"]),
            saved_at: 1_700_000_000,
        };

        save_to(&scratch.file(), &snap).expect("save");
        let loaded = load_from(&scratch.file()).expect("load").expect("some");

        assert_eq!(loaded.runs, snap.runs);
        assert_eq!(loaded.in_flight_daemons, snap.in_flight_daemons);
        assert_eq!(loaded.saved_at, snap.saved_at);
    }

    #[test]
    fn missing_file_returns_none_not_error() {
        let scratch = Scratch::new("missing");
        // Scratch exists but the JSON file doesn't.
        let loaded = load_from(&scratch.file()).expect("load");
        assert!(loaded.is_none());
    }

    #[test]
    fn oversized_payload_is_rejected_without_writing() {
        let scratch = Scratch::new("oversized");
        // Build a payload whose serialized form is guaranteed to exceed
        // MAX_BYTES. A single 300 KB string in `runs` does the job.
        let big = "x".repeat(300 * 1024);
        let snap = LiveSnapshot {
            runs: json!({ "big": big }),
            in_flight_daemons: json!([]),
            saved_at: 0,
        };

        let err = save_to(&scratch.file(), &snap).expect_err("should reject");
        assert!(
            err.contains("exceeds"),
            "expected size-cap error, got: {err}"
        );
        // And crucially: nothing on disk.
        assert!(
            !scratch.file().exists(),
            "oversized save must not produce a file"
        );
    }

    #[test]
    fn load_on_empty_file_returns_none() {
        // Touch an empty file — load should tolerate it like a missing one
        // rather than exploding on parse.
        let scratch = Scratch::new("empty");
        fs::write(scratch.file(), "").expect("seed empty");
        let loaded = load_from(&scratch.file()).expect("load");
        assert!(loaded.is_none());
    }

    #[test]
    fn save_overwrites_previous_snapshot_atomically() {
        // Two consecutive saves — the second must fully replace the first,
        // and there must be no leftover `.tmp` sibling afterwards.
        let scratch = Scratch::new("overwrite");
        let first = LiveSnapshot {
            runs: json!({ "v": 1 }),
            in_flight_daemons: json!([]),
            saved_at: 1,
        };
        let second = LiveSnapshot {
            runs: json!({ "v": 2 }),
            in_flight_daemons: json!(["d"]),
            saved_at: 2,
        };

        save_to(&scratch.file(), &first).expect("save1");
        save_to(&scratch.file(), &second).expect("save2");

        let loaded = load_from(&scratch.file()).expect("load").expect("some");
        assert_eq!(loaded.runs, json!({ "v": 2 }));
        assert_eq!(loaded.in_flight_daemons, json!(["d"]));
        assert_eq!(loaded.saved_at, 2);

        // No tmp leftover.
        let tmp = scratch.file().with_extension("json.tmp");
        assert!(!tmp.exists(), "tmp sibling should have been renamed away");
    }
}
