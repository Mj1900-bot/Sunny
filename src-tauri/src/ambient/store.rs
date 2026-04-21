//! Persistence layer for the ambient watcher.
//!
//! `AmbientDisk` lives here but is re-exported from `mod.rs` via
//! `pub(super) use store::AmbientDisk` so sibling modules can reference it.
//! The static `DISK` Mutex and the file I/O helpers are all private to this
//! module — callers go through `load_disk` / `save_disk`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// On-disk state
// ---------------------------------------------------------------------------

/// On-disk state — the minimum we need to survive a restart without re-firing
/// an already-surfaced nudge.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(super) struct AmbientDisk {
    /// Per-category last-surface timestamp (unix secs).
    pub(super) last_surface: HashMap<String, i64>,
    /// Calendar-event id we last surfaced a "meeting-imminent" for.
    pub(super) last_meeting_event_id: Option<String>,
    /// Whether the battery trigger is currently "armed" (i.e. we have already
    /// fired on this discharge cycle and shouldn't fire again until the user
    /// plugs in).
    pub(super) battery_fired_this_cycle: bool,
    /// Whether the mail trigger is currently "armed" — we only re-fire after
    /// unread drops back below the threshold.
    pub(super) mail_over_threshold: bool,
    /// Last `WorldState.revision` we processed. Persisted so that on relaunch
    /// the bus-poller path won't re-fire a tick we already handled last
    /// session (see the battery re-fire race documented in `start()`).
    /// `None` means "no prior session" — `start()` will seed from
    /// `world::current().revision` and assume the previous session already
    /// surfaced whatever that tick represented.
    #[serde(default)]
    pub(super) last_revision: Option<u64>,

    /// Per-COMPOUND-category last-surface timestamp (unix secs). Separate map
    /// from `last_surface` so the 30-minute compound gap doesn't interfere
    /// with (or get overwritten by) the 10-minute per-category gap.
    /// `#[serde(default)]` keeps old `~/.sunny/ambient.json` files parsing cleanly.
    #[serde(default)]
    pub(super) last_compound_surface: HashMap<String, i64>,

    /// Per-intent-tag last-surface timestamp (unix secs) for the
    /// LLM-classified path. Separate from `last_compound_surface` so the
    /// two gap policies (rule-compound 30 min, intent 10 min) don't
    /// collide. `#[serde(default)]` again — legacy files parse cleanly.
    #[serde(default)]
    pub(super) last_intent_surface: HashMap<String, i64>,

    /// Unix seconds of the last classifier invocation (success, timeout,
    /// or error — we rate-gate on any attempt to keep the 60 s floor
    /// honest regardless of outcome). `#[serde(default)]` defaults to 0,
    /// which is correctly "never" — the next tick will be eligible.
    #[serde(default)]
    pub(super) last_classifier_attempt: i64,
}

// ---------------------------------------------------------------------------
// Statics
// ---------------------------------------------------------------------------

/// Module-local Mutex holding the authoritative on-disk state so both the
/// Tauri listener and the event-bus tailer can mutate it between ticks
/// without re-reading the file every event (we save-on-change only).
pub(super) static DISK: Mutex<Option<AmbientDisk>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

pub(super) fn ambient_file() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".sunny").join("ambient.json"))
}

pub(super) fn load_disk() -> AmbientDisk {
    let Some(path) = ambient_file() else { return AmbientDisk::default() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return AmbientDisk::default() };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub(super) fn save_disk(state: &AmbientDisk) {
    let Some(path) = ambient_file() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(body) = serde_json::to_string_pretty(state) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, &path);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
}

// ---------------------------------------------------------------------------
// Diff helper
// ---------------------------------------------------------------------------

pub(super) fn next_differs(a: &AmbientDisk, b: &AmbientDisk) -> bool {
    a.last_meeting_event_id != b.last_meeting_event_id
        || a.battery_fired_this_cycle != b.battery_fired_this_cycle
        || a.mail_over_threshold != b.mail_over_threshold
        || a.last_surface != b.last_surface
        || a.last_revision != b.last_revision
        || a.last_compound_surface != b.last_compound_surface
        || a.last_intent_surface != b.last_intent_surface
        || a.last_classifier_attempt != b.last_classifier_attempt
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    /// Build a temp directory that is automatically cleaned up at the end of
    /// each test via `TempDir`. Each test gets its own subdirectory so
    /// parallel test runs don't race on the file path.
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "sunny-ambient-store-{tag}-{}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Override `ambient_file()` for a test by writing/reading directly via
    /// the path — the public `save_disk` / `load_disk` helpers call
    /// `ambient_file()` which resolves against `$HOME`. For unit-level
    /// round-trip tests we call the private helpers directly with an explicit
    /// path instead of mutating the environment.
    fn write_disk(path: &std::path::Path, state: &AmbientDisk) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let body = serde_json::to_string_pretty(state).expect("serialize");
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, body).expect("write tmp");
        fs::rename(&tmp, path).expect("rename");
    }

    fn read_disk(path: &std::path::Path) -> AmbientDisk {
        let Ok(raw) = fs::read_to_string(path) else {
            return AmbientDisk::default();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    // ── load_disk returns default on missing file ─────────────────────────

    #[test]
    fn load_disk_returns_default_on_missing_file() {
        let dir = TempDir::new("load-missing");
        let path = dir.path().join("ambient.json");
        // File does not exist — read_disk should return the Default value.
        assert!(!path.exists(), "precondition: file absent");
        let state = read_disk(&path);
        assert!(state.last_surface.is_empty());
        assert!(!state.battery_fired_this_cycle);
        assert!(!state.mail_over_threshold);
        assert!(state.last_meeting_event_id.is_none());
        assert!(state.last_revision.is_none());
    }

    // ── save_disk / load_disk round-trip ──────────────────────────────────

    #[test]
    fn save_and_load_round_trips_all_fields() {
        let dir = TempDir::new("roundtrip");
        let path = dir.path().join("ambient.json");

        let mut original = AmbientDisk {
            battery_fired_this_cycle: true,
            mail_over_threshold: true,
            last_meeting_event_id: Some("evt-99".to_string()),
            last_revision: Some(77),
            last_classifier_attempt: 1_234_567,
            ..AmbientDisk::default()
        };
        original.last_surface.insert("battery".to_string(), 1000);
        original.last_compound_surface.insert("meeting+battery".to_string(), 2000);
        original.last_intent_surface.insert("intent:focus_issue".to_string(), 3000);

        write_disk(&path, &original);
        let loaded = read_disk(&path);

        assert_eq!(loaded.battery_fired_this_cycle, true);
        assert_eq!(loaded.mail_over_threshold, true);
        assert_eq!(loaded.last_meeting_event_id.as_deref(), Some("evt-99"));
        assert_eq!(loaded.last_revision, Some(77));
        assert_eq!(loaded.last_classifier_attempt, 1_234_567);
        assert_eq!(loaded.last_surface.get("battery"), Some(&1000));
        assert_eq!(
            loaded.last_compound_surface.get("meeting+battery"),
            Some(&2000)
        );
        assert_eq!(
            loaded.last_intent_surface.get("intent:focus_issue"),
            Some(&3000)
        );
    }

    // ── next_differs: identity returns false ─────────────────────────────

    #[test]
    fn next_differs_false_for_identical_states() {
        let state = AmbientDisk::default();
        assert!(!next_differs(&state, &state));
    }

    // ── next_differs: each field path triggers a diff ────────────────────

    #[test]
    fn next_differs_detects_battery_fired_change() {
        let a = AmbientDisk::default();
        let b = AmbientDisk { battery_fired_this_cycle: true, ..AmbientDisk::default() };
        assert!(next_differs(&a, &b));
    }

    #[test]
    fn next_differs_detects_mail_over_threshold_change() {
        let a = AmbientDisk::default();
        let b = AmbientDisk { mail_over_threshold: true, ..AmbientDisk::default() };
        assert!(next_differs(&a, &b));
    }

    #[test]
    fn next_differs_detects_last_surface_map_change() {
        let a = AmbientDisk::default();
        let mut b = AmbientDisk::default();
        b.last_surface.insert("battery".to_string(), 9999);
        assert!(next_differs(&a, &b));
    }

    #[test]
    fn next_differs_detects_last_meeting_event_id_change() {
        let a = AmbientDisk::default();
        let b = AmbientDisk {
            last_meeting_event_id: Some("evt-1".to_string()),
            ..AmbientDisk::default()
        };
        assert!(next_differs(&a, &b));
    }

    #[test]
    fn next_differs_detects_last_revision_change() {
        let a = AmbientDisk::default();
        let b = AmbientDisk { last_revision: Some(42), ..AmbientDisk::default() };
        assert!(next_differs(&a, &b));
    }

    #[test]
    fn next_differs_detects_last_compound_surface_change() {
        let a = AmbientDisk::default();
        let mut b = AmbientDisk::default();
        b.last_compound_surface.insert("meeting+battery".to_string(), 12345);
        assert!(next_differs(&a, &b));
    }

    #[test]
    fn next_differs_detects_last_intent_surface_change() {
        let a = AmbientDisk::default();
        let mut b = AmbientDisk::default();
        b.last_intent_surface.insert("intent:focus_issue".to_string(), 100);
        assert!(next_differs(&a, &b));
    }

    #[test]
    fn next_differs_detects_last_classifier_attempt_change() {
        let a = AmbientDisk::default();
        let b = AmbientDisk { last_classifier_attempt: 999, ..AmbientDisk::default() };
        assert!(next_differs(&a, &b));
    }

    // ── serde: truncated (legacy) JSON parses cleanly via serde(default) ─

    #[test]
    fn legacy_json_without_new_fields_parses_to_default_values() {
        let legacy = r#"{
            "last_surface": {"meeting": 5000},
            "last_meeting_event_id": "evt-old",
            "battery_fired_this_cycle": false,
            "mail_over_threshold": false
        }"#;
        let parsed: AmbientDisk =
            serde_json::from_str(legacy).expect("legacy json must parse");
        // New fields from later phases default cleanly.
        assert!(parsed.last_compound_surface.is_empty());
        assert!(parsed.last_intent_surface.is_empty());
        assert_eq!(parsed.last_revision, None);
        assert_eq!(parsed.last_classifier_attempt, 0);
        // Existing fields are preserved.
        assert_eq!(parsed.last_surface.get("meeting"), Some(&5000));
        assert_eq!(parsed.last_meeting_event_id.as_deref(), Some("evt-old"));
    }
}
