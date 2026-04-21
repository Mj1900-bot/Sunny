//! Persistent schedule store — `~/.sunny/schedules.json`.
//!
//! This is a standalone, hermetically-testable store that sits ON TOP of
//! `daemons.rs`.  The difference in responsibility:
//!
//! * `daemons.rs` — raw daemon records with `kind`, `at`, `every_sec`.
//!   The frontend polls `daemons_ready_to_fire` and calls
//!   `daemons_mark_fired`. Execution is frontend-driven.
//!
//! * `store.rs` (this file) — scheduler records that carry richer metadata:
//!   `CronSchedule` (NL-parsed), `trust_required` flag, `fail_count` for
//!   the dead-letter queue, and a `history` ring-buffer of completed runs.
//!   Execution is also frontend-delegated: when the frontend fires a
//!   scheduled item it calls `mark_fired` with the run summary.
//!
//! Both layers persist atomically (tmp-rename, 0600).  This layer does NOT
//! duplicate the daemon-level `daemons.json`; it writes `schedules.json`
//! alongside it.  A `ScheduleEntry` always has a corresponding daemon whose
//! `id` matches `entry.daemon_id` — `schedule_once` / `schedule_recurring`
//! create both.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::parse_time::CronSchedule;

const DIR_NAME: &str = ".sunny";
const FILE_NAME: &str = "schedules.json";
/// Maximum consecutive failures before a schedule is flagged dead-letter.
pub const DLQ_THRESHOLD: u32 = 3;
/// How many completed runs to keep in the history ring-buffer.
pub const HISTORY_RING: usize = 50;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/// One completed run record, kept in the history ring.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunRecord {
    /// Unix seconds when the run fired.
    pub fired_at: i64,
    /// "ok" | "error" | "skipped_trust"
    pub status: String,
    /// Short summary written back by the agent or an error string.
    pub summary: String,
}

/// A pending or disabled schedule entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleEntry {
    /// Unique ID for this schedule (16-char hex, same scheme as `daemons.rs`).
    pub id: String,
    /// Human-readable label.
    pub title: String,
    /// The prompt that becomes the user message for the scheduled agent run.
    pub prompt: String,
    /// Whether this is a one-shot or recurring schedule.
    pub kind: ScheduleKind,
    /// Serialised `CronSchedule::to_wire()` — for recurring only.
    pub cron_wire: Option<String>,
    /// Absolute fire time in unix seconds — for once-only.
    pub fire_at: Option<i64>,
    /// Next computed fire time (unix seconds).  `None` once a once-schedule
    /// has fired or when the entry is disabled/DLQ'd.
    pub next_fire: Option<i64>,
    /// Whether this schedule is active.
    pub enabled: bool,
    /// Consecutive failure count.  Resets on any success.
    pub fail_count: u32,
    /// True once `fail_count` reaches `DLQ_THRESHOLD`.
    pub dead_letter: bool,
    /// Corresponding daemon id in `daemons.json`.
    pub daemon_id: String,
    /// Whether ANY tool invocation inside this scheduled run that reaches
    /// trust-class L3+ should pause for push-notification confirmation.
    /// Mirrors `SunnySettings.trust_level == ConfirmAll`.
    pub requires_confirm: bool,
    /// Completed run ring-buffer (capped at `HISTORY_RING`).
    pub history: Vec<RunRecord>,
    /// Unix seconds when this entry was created.
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleKind {
    Once,
    Recurring,
}

// ---------------------------------------------------------------------------
// Persistence helpers (mirrors daemons.rs atomic-write pattern)
// ---------------------------------------------------------------------------

fn schedules_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home.join(DIR_NAME))
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn load_from(dir: &Path) -> Result<Vec<ScheduleEntry>, String> {
    let path = dir.join(FILE_NAME);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read schedules: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw).map_err(|e| format!("parse schedules: {e}"))
}

static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn save_to(dir: &Path, entries: &[ScheduleEntry]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create schedules dir: {e}"))?;
    let final_path = dir.join(FILE_NAME);
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = dir.join(format!("{FILE_NAME}.tmp.{pid}.{nanos}.{counter}"));

    let serialized =
        serde_json::to_string_pretty(entries).map_err(|e| format!("serialize schedules: {e}"))?;

    let write_result = (|| -> Result<(), String> {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(serialized.as_bytes())
            .map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync: {e}"))?;
        set_owner_only(&tmp_path)?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("rename schedules: {e}")
    })?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms).map_err(|e| format!("chmod schedules: {e}"))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

static FILE_LOCK: Mutex<()> = Mutex::new(());

pub fn load_schedules() -> Result<Vec<ScheduleEntry>, String> {
    let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    load_from(&schedules_dir()?)
}

pub fn save_schedules(entries: &[ScheduleEntry]) -> Result<(), String> {
    let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    save_to(&schedules_dir()?, entries)
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

pub fn new_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mixed = nanos
        ^ ((std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
        ^ seq.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    format!("{mixed:016x}")
}

// ---------------------------------------------------------------------------
// Core mutations (pure store, no async, no Tauri deps)
// ---------------------------------------------------------------------------

/// Advance a `ScheduleEntry` after a successful or failed run.
///
/// - On success (`status == "ok"`): reset fail_count, append history, advance
///   next_fire for recurring; disable once-schedules.
/// - On failure: increment fail_count; if it reaches `DLQ_THRESHOLD`, flip
///   `dead_letter = true` and clear `next_fire` / `enabled`.
///
/// Returns the updated entry (immutable — caller replaces in the vec).
pub fn advance_after_fire(
    entry: &ScheduleEntry,
    fired_at: i64,
    status: &str,
    summary: &str,
) -> ScheduleEntry {
    let success = status == "ok";

    let fail_count = if success {
        0
    } else {
        entry.fail_count.saturating_add(1)
    };

    let dead_letter = !success && fail_count >= DLQ_THRESHOLD;

    // Append to history ring, dropping oldest if at capacity.
    let mut new_history = entry.history.clone();
    new_history.push(RunRecord {
        fired_at,
        status: status.to_string(),
        summary: summary.to_string(),
    });
    if new_history.len() > HISTORY_RING {
        new_history.drain(0..new_history.len() - HISTORY_RING);
    }

    // Compute next fire.
    let (enabled, next_fire) = if dead_letter {
        (false, None)
    } else if entry.kind == ScheduleKind::Once {
        (false, None) // once-shots auto-disable after any fire attempt
    } else {
        // Recurring: re-compute next from now.
        let nf = entry
            .cron_wire
            .as_deref()
            .and_then(|w| CronSchedule::from_wire(w).ok())
            .and_then(|s| s.next_after(fired_at));
        (entry.enabled && !dead_letter, nf)
    };

    ScheduleEntry {
        fail_count,
        dead_letter,
        history: new_history,
        enabled,
        next_fire,
        ..entry.clone()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Scratch {
        pub path: PathBuf,
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
                "sunny-sched-test-{tag}-{}-{nanos}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create scratch");
            Self { path }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn sample_once(id: &str) -> ScheduleEntry {
        ScheduleEntry {
            id: id.to_string(),
            title: "test once".into(),
            prompt: "remind me to call mom".into(),
            kind: ScheduleKind::Once,
            cron_wire: None,
            fire_at: Some(now_unix() + 3600),
            next_fire: Some(now_unix() + 3600),
            enabled: true,
            fail_count: 0,
            dead_letter: false,
            daemon_id: "daemon_abc".into(),
            requires_confirm: false,
            history: vec![],
            created_at: now_unix(),
        }
    }

    fn sample_recurring(id: &str) -> ScheduleEntry {
        use super::super::parse_time::CronSchedule;
        let cron = CronSchedule::IntervalSecs(3600);
        ScheduleEntry {
            id: id.to_string(),
            title: "test recurring".into(),
            prompt: "check email".into(),
            kind: ScheduleKind::Recurring,
            cron_wire: Some(cron.to_wire()),
            fire_at: None,
            next_fire: Some(now_unix() + 3600),
            enabled: true,
            fail_count: 0,
            dead_letter: false,
            daemon_id: "daemon_xyz".into(),
            requires_confirm: false,
            history: vec![],
            created_at: now_unix(),
        }
    }

    // 1. Atomic save + load round-trip
    #[test]
    fn atomic_persistence_roundtrip() {
        let scratch = Scratch::new("roundtrip");
        let entries = vec![sample_once("id1"), sample_recurring("id2")];
        save_to(&scratch.path, &entries).expect("save");
        let loaded = load_from(&scratch.path).expect("load");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "id1");
        assert_eq!(loaded[1].id, "id2");
        assert_eq!(loaded[0].prompt, "remind me to call mom");
    }

    // 2. Once schedule disables after firing
    #[test]
    fn once_schedule_disables_after_fire() {
        let entry = sample_once("once1");
        let now = now_unix();
        let updated = advance_after_fire(&entry, now, "ok", "done");
        assert!(!updated.enabled);
        assert!(updated.next_fire.is_none());
    }

    // 3. Recurring advances next_fire
    #[test]
    fn recurring_advances_next_fire() {
        let entry = sample_recurring("rec1");
        let now = now_unix();
        let updated = advance_after_fire(&entry, now, "ok", "done");
        assert!(updated.enabled);
        assert!(updated.next_fire.is_some());
        assert!(updated.next_fire.unwrap() > now);
    }

    // 4. Dead-letter after 3 consecutive failures
    #[test]
    fn dead_letter_after_three_failures() {
        let mut entry = sample_recurring("dlq1");
        let now = now_unix();

        for i in 1..=3 {
            entry = advance_after_fire(&entry, now + i * 60, "error", "agent failed");
        }

        assert!(entry.dead_letter, "should be DLQ'd after 3 failures");
        assert!(!entry.enabled);
        assert!(entry.next_fire.is_none());
        assert_eq!(entry.fail_count, 3);
    }

    // 5. fail_count resets on success after partial failures
    #[test]
    fn fail_count_resets_on_success() {
        let mut entry = sample_recurring("reset1");
        let now = now_unix();

        entry = advance_after_fire(&entry, now, "error", "oops");
        entry = advance_after_fire(&entry, now + 60, "error", "oops2");
        assert_eq!(entry.fail_count, 2);

        entry = advance_after_fire(&entry, now + 120, "ok", "recovered");
        assert_eq!(entry.fail_count, 0, "fail_count should reset on success");
        assert!(!entry.dead_letter);
    }

    // 6. History ring capped at HISTORY_RING
    #[test]
    fn history_ring_capped() {
        let mut entry = sample_recurring("hist1");
        let now = now_unix();

        for i in 0..60u64 {
            entry = advance_after_fire(&entry, now + i as i64 * 10, "ok", "done");
        }

        assert_eq!(entry.history.len(), HISTORY_RING);
    }
}
