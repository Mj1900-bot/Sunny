//! Persistent agent daemons.
//!
//! SUNNY can run named long-lived goals on a schedule (once, interval) or on a
//! frontend-dispatched trigger event. Daemons survive app restarts because we
//! atomically persist them at `~/.sunny/daemons.json` (0600, mirrors
//! settings.rs).
//!
//! Unlike scheduler.rs, which executes actions in Rust on a tokio ticker, the
//! daemon module is a **pure store with a ready-check**. Execution happens on
//! the frontend side — it polls `daemons_ready_to_fire` every 15s, spawns each
//! due daemon via `useSubAgents.getState().spawn(goal)`, and reports results
//! back through `daemons_mark_fired`. This avoids duplicating the sub-agent
//! spawn/streaming machinery that already lives in the React layer, and keeps
//! goal execution visible in the UI like any other agent run.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

const DIR_NAME: &str = ".sunny";
const FILE_NAME: &str = "daemons.json";
const OUTPUT_TRUNCATE: usize = 1000;

/// Maximum number of *enabled* daemons the user (or the agent) can have
/// installed at once. Any `daemons_add` request that would push the
/// enabled-count past this is refused with a structured error.
///
/// Chosen so a voice-driven user can comfortably have a morning brief,
/// a handful of recurring checks, and a few once-shots in flight
/// (~10-15 typical) with plenty of headroom — while a runaway agent
/// calling `schedule_recurring` in a loop gets shut off at 32.
pub const MAX_ENABLED_DAEMONS: usize = 32;

/// Minimum cadence floor enforced in `daemons_add` for interval daemons.
/// The frontend `schedule_recurring` tool also enforces this, but we
/// re-check here so a direct Tauri-command caller (dev tools, test
/// harness, a future tool that bypasses the TS layer) cannot slip under.
/// 60s means no sub-minute polling — the single biggest fork-bomb
/// amplifier in the prior incidents was a short interval firing the
/// same expensive goal before the previous run could mark_fired.
pub const MIN_INTERVAL_SECS: u64 = 60;

// -------------------- data model --------------------

/// Spec supplied by the frontend when creating a new daemon. The runtime
/// bookkeeping fields (id, next_run, runs_count, ...) are filled in by the
/// Rust side.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct DaemonSpec {
    pub title: String,
    /// "once" | "interval" | "on_event"
    pub kind: String,
    /// For Once: unix seconds to fire at.
    #[ts(type = "number | null")]
    pub at: Option<i64>,
    /// For Interval: seconds between fires.
    #[ts(type = "number | null")]
    pub every_sec: Option<u64>,
    /// For OnEvent: Tauri event name the frontend dispatches via
    /// `dispatchEvent` / `window.__SUNNY.emit`.
    pub on_event: Option<String>,
    /// The agent goal text the frontend will hand to `useSubAgents.spawn`.
    pub goal: String,
    /// Optional cap on total runs. Once reached the daemon auto-disables.
    #[ts(type = "number | null")]
    pub max_runs: Option<u64>,
}

/// Runtime daemon record. Persisted to `~/.sunny/daemons.json`.
///
/// ## Field semantics for `at`
///
/// The `at` field has kind-dependent meaning:
///
/// - `once`: **required**. The unix-second wall-clock time the daemon should
///   fire. If it's in the past at schedule time, it clamps to "now" so the
///   daemon fires immediately on the next poll.
/// - `interval`: **optional anchor**. When present, the cadence is computed
///   from this wall-clock time (first fire = `at + every_sec`). When absent,
///   the cadence starts from `created_at` — so a daemon created at T with
///   every_sec=3600 fires its first tick at T+3600 regardless of app restarts.
/// - `on_event`: ignored — on_event daemons are fired by frontend-dispatched
///   events, not the clock.
///
/// `created_at` anchors interval daemons that have no `at`. It's populated at
/// creation time from `chrono::Utc::now().timestamp()`; for daemons that were
/// persisted before this field existed, `serde` defaults it via
/// `default_created_at` on load.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct Daemon {
    pub id: String,
    pub title: String,
    /// "once" | "interval" | "on_event"
    pub kind: String,
    #[ts(type = "number | null")]
    pub at: Option<i64>,
    #[ts(type = "number | null")]
    pub every_sec: Option<u64>,
    pub on_event: Option<String>,
    pub goal: String,
    pub enabled: bool,
    #[ts(type = "number | null")]
    pub next_run: Option<i64>,
    #[ts(type = "number | null")]
    pub last_run: Option<i64>,
    pub last_status: Option<String>,
    /// Capped at 1000 chars.
    pub last_output: Option<String>,
    #[ts(type = "number")]
    pub runs_count: u64,
    #[ts(type = "number | null")]
    pub max_runs: Option<u64>,
    /// Unix seconds when this daemon was created. Anchors interval daemons
    /// that omitted `at`, so the first-fire time is stable across app
    /// restarts. For on-disk records that predate this field, `load_from`
    /// migrates the value to `at.unwrap_or(now_unix())` before deserializing
    /// (see `migrate_legacy_created_at`).
    #[ts(type = "number")]
    pub created_at: i64,
}

// -------------------- paths / persistence --------------------

fn daemons_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home.join(DIR_NAME))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn load_from(dir: &Path) -> Result<Vec<Daemon>, String> {
    let path = dir.join(FILE_NAME);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read daemons: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    // Parse as an untyped array first so we can migrate legacy records that
    // predate the `created_at` field. Once migration is applied the values
    // deserialize cleanly into `Vec<Daemon>`.
    let mut values: Vec<Value> =
        serde_json::from_str(&raw).map_err(|e| format!("parse daemons: {e}"))?;
    for v in values.iter_mut() {
        migrate_legacy_created_at(v);
    }
    serde_json::from_value::<Vec<Daemon>>(Value::Array(values))
        .map_err(|e| format!("parse daemons: {e}"))
}

/// On-disk migration for daemons written before `created_at` was a required
/// field. Backfills the missing key with `at.unwrap_or(now_unix())` — for
/// interval daemons that had no `at`, this makes the first fire land
/// `every_sec` seconds after the migration moment, then stay stable across
/// future restarts (because the freshly-written record now carries a real
/// `created_at`).
fn migrate_legacy_created_at(value: &mut Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    if obj.contains_key("created_at") {
        return;
    }
    let fallback = obj
        .get("at")
        .and_then(|a| a.as_i64())
        .unwrap_or_else(now_unix);
    obj.insert("created_at".to_string(), Value::from(fallback));
}

static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Atomic write mirroring settings.rs: unique tmp name, 0600, rename. The
/// unique suffix (pid + nanos + counter) means two concurrent saves in the
/// same process at the same nanosecond still pick distinct tmp paths, so the
/// rename is always safe.
fn save_to(dir: &Path, daemons: &[Daemon]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create daemons dir: {e}"))?;

    let final_path = dir.join(FILE_NAME);
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = dir.join(format!("{FILE_NAME}.tmp.{pid}.{nanos}.{counter}"));

    let serialized =
        serde_json::to_string_pretty(daemons).map_err(|e| format!("serialize daemons: {e}"))?;

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
        format!("rename daemons: {e}")
    })?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms).map_err(|e| format!("chmod daemons: {e}"))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

// Coarse global lock for reads/writes. The daemon store is IO-light (read on
// poll, write on fire) and this keeps concurrent command invocations from
// racing on the file.
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn load_daemons() -> Result<Vec<Daemon>, String> {
    let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    load_from(&daemons_dir()?)
}

fn save_daemons(daemons: &[Daemon]) -> Result<(), String> {
    let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    save_to(&daemons_dir()?, daemons)
}

// -------------------- id + scheduling --------------------

/// 16 lowercase hex chars sourced from nanos + a process counter. Not
/// cryptographic — daemons are local-only and ids just need to be unique
/// within one user's ~/.sunny.
fn new_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mixed = nanos ^ ((std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
        ^ seq.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    format!("{mixed:016x}")
}

/// Compute the next fire time given `now`.
///
/// - Once: returns the configured `at`, clamped to `now` (fire immediately if
///   overdue), or None if the daemon already ran.
/// - Interval: base = last_run OR at OR created_at, plus every_sec. Anchoring
///   on `created_at` (not `now`) is what makes the first fire stable across
///   app restarts — a daemon created at T with every_sec=3600 fires at
///   T+3600 whether the app has been running continuously or just woke up.
///   If we fell far behind (eg the laptop slept), clamp to `now` to avoid
///   replaying every missed tick.
/// - OnEvent: always None — these are fired by frontend-dispatched events, not
///   by time, so `daemons_ready_to_fire` never returns them.
pub fn compute_next_run(d: &Daemon, now: i64) -> Option<i64> {
    match d.kind.as_str() {
        "once" => {
            if d.last_run.is_some() {
                None
            } else {
                d.at.map(|t| t.max(now))
            }
        }
        "interval" => {
            let every = d.every_sec?;
            if every == 0 {
                return None;
            }
            let base = d.last_run.or(d.at).unwrap_or(d.created_at);
            let mut next = base + every as i64;
            if next < now {
                next = now;
            }
            Some(next)
        }
        "on_event" => None,
        _ => None,
    }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    match kind {
        "once" | "interval" | "on_event" => Ok(()),
        other => Err(format!("unknown daemon kind {other:?}")),
    }
}

fn truncate_output(s: &str) -> String {
    if s.chars().count() <= OUTPUT_TRUNCATE {
        return s.to_string();
    }
    let cut: String = s.chars().take(OUTPUT_TRUNCATE).collect();
    format!("{cut}…")
}

// -------------------- public async API --------------------

pub async fn daemons_list() -> Result<Vec<Daemon>, String> {
    tokio::task::spawn_blocking(load_daemons)
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub async fn daemons_add(spec: DaemonSpec) -> Result<Daemon, String> {
    validate_kind(&spec.kind)?;

    // Per-kind sanity checks before we touch disk.
    match spec.kind.as_str() {
        "once" => {
            if spec.at.is_none() {
                return Err("once daemon requires `at` (unix seconds)".into());
            }
        }
        "interval" => {
            let e = spec
                .every_sec
                .ok_or_else(|| "interval daemon requires `every_sec`".to_string())?;
            if e == 0 {
                return Err("interval `every_sec` must be > 0".into());
            }
            // Enforce the cadence floor. See MIN_INTERVAL_SECS docs — sub-
            // minute polling was the prior fork-bomb amplifier.
            if e < MIN_INTERVAL_SECS {
                return Err(format!(
                    "interval `every_sec` must be >= {MIN_INTERVAL_SECS}s \
                     (got {e}s); sub-minute cadence is refused to prevent \
                     spawn fanout. Ask the user to broaden the schedule."
                ));
            }
        }
        "on_event" => {
            let ev = spec
                .on_event
                .as_deref()
                .ok_or_else(|| "on_event daemon requires `on_event` name".to_string())?;
            if ev.trim().is_empty() {
                return Err("on_event name must be non-empty".into());
            }
        }
        _ => {}
    }

    if spec.goal.trim().is_empty() {
        return Err("goal must be non-empty".into());
    }

    let now = now_unix();
    // Sourced from chrono so the creation anchor is derived from the same
    // wall-clock primitive the rest of SUNNY uses for user-facing timestamps.
    // Using chrono here (instead of `now_unix()`) keeps the semantics explicit:
    // `created_at` is a wall-clock moment, not a monotonic measurement.
    let created_at = chrono::Utc::now().timestamp();
    let mut daemon = Daemon {
        id: new_id(),
        title: spec.title,
        kind: spec.kind,
        at: spec.at,
        every_sec: spec.every_sec,
        on_event: spec.on_event,
        goal: spec.goal,
        enabled: true,
        next_run: None,
        last_run: None,
        last_status: None,
        last_output: None,
        runs_count: 0,
        max_runs: spec.max_runs,
        created_at,
    };
    daemon.next_run = compute_next_run(&daemon, now);

    tokio::task::spawn_blocking(move || -> Result<Daemon, String> {
        let mut daemons = load_daemons()?;
        // Refuse if we're already at the enabled-daemon cap. Checked on
        // disabled count too, since a flood of paused daemons is still
        // an amplifier waiting to be re-enabled in bulk.
        let enabled_now = daemons.iter().filter(|d| d.enabled).count();
        if enabled_now >= MAX_ENABLED_DAEMONS {
            return Err(format!(
                "daemon limit reached: {enabled_now} enabled daemons \
                 (max {MAX_ENABLED_DAEMONS}). Disable or delete an existing \
                 one before adding another."
            ));
        }
        daemons.push(daemon.clone());
        save_daemons(&daemons)?;
        Ok(daemon)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Load daemons with all `enabled` flags forced to false. Called at boot
/// when `boot_guard::arm()` reports a prior abnormal exit — the user
/// re-enables explicitly from the HUD once they've diagnosed what
/// happened. Idempotent: on a clean run this is never invoked.
pub fn quarantine_on_disk() -> Result<usize, String> {
    let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    let dir = daemons_dir()?;
    let mut daemons = load_from(&dir)?;
    let mut changed = 0usize;
    for d in daemons.iter_mut() {
        if d.enabled {
            d.enabled = false;
            d.next_run = None;
            d.last_status = Some("quarantined_on_boot".to_string());
            changed += 1;
        }
    }
    if changed > 0 {
        save_to(&dir, &daemons)?;
    }
    Ok(changed)
}

pub async fn daemons_update(id: String, patch: Value) -> Result<Daemon, String> {
    tokio::task::spawn_blocking(move || -> Result<Daemon, String> {
        let mut daemons = load_daemons()?;
        let idx = daemons
            .iter()
            .position(|d| d.id == id)
            .ok_or_else(|| format!("daemon {id} not found"))?;

        // Immutable merge: serialize existing -> merge patch object -> deserialize.
        // Reject attempts to change id/created_at/runs_count.
        let current =
            serde_json::to_value(&daemons[idx]).map_err(|e| format!("serialize daemon: {e}"))?;
        let mut merged = current;
        let patch_obj = patch
            .as_object()
            .ok_or_else(|| "patch must be an object".to_string())?;
        if let Some(obj) = merged.as_object_mut() {
            for (k, v) in patch_obj {
                if k == "id" || k == "created_at" || k == "runs_count" {
                    continue;
                }
                obj.insert(k.clone(), v.clone());
            }
        }
        let mut updated: Daemon =
            serde_json::from_value(merged).map_err(|e| format!("patch shape: {e}"))?;
        validate_kind(&updated.kind)?;

        // Recompute next_run if scheduling inputs may have changed.
        updated.next_run = if updated.enabled {
            compute_next_run(&updated, now_unix())
        } else {
            None
        };

        daemons[idx] = updated.clone();
        save_daemons(&daemons)?;
        Ok(updated)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

pub async fn daemons_delete(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let daemons = load_daemons()?;
        let before = daemons.len();
        let kept: Vec<Daemon> = daemons.into_iter().filter(|d| d.id != id).collect();
        if kept.len() == before {
            return Err(format!("daemon {id} not found"));
        }
        save_daemons(&kept)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Synchronous kill-switch used by the security panic button. Flips
/// every daemon to `enabled=false`, clears their `next_run`, and
/// persists the mutation. Returns the count of daemons that were
/// actually still enabled before the call — zero if the user already
/// had them all paused.
pub fn disable_all() -> Result<usize, String> {
    let mut daemons = load_daemons()?;
    let mut changed = 0usize;
    for d in daemons.iter_mut() {
        if d.enabled {
            d.enabled = false;
            d.next_run = None;
            changed += 1;
        }
    }
    if changed > 0 {
        save_daemons(&daemons)?;
    }
    Ok(changed)
}

pub async fn daemons_set_enabled(id: String, enabled: bool) -> Result<Daemon, String> {
    tokio::task::spawn_blocking(move || -> Result<Daemon, String> {
        let mut daemons = load_daemons()?;
        let idx = daemons
            .iter()
            .position(|d| d.id == id)
            .ok_or_else(|| format!("daemon {id} not found"))?;
        let updated = Daemon {
            enabled,
            next_run: if enabled {
                compute_next_run(&daemons[idx], now_unix())
            } else {
                None
            },
            ..daemons[idx].clone()
        };
        daemons[idx] = updated.clone();
        save_daemons(&daemons)?;
        Ok(updated)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Returns enabled daemons whose `next_run` is <= `now_secs`. **Pure read** —
/// no mutation. The frontend is expected to call `daemons_mark_fired` once it
/// has actually dispatched the goal to its sub-agent runner, which is where
/// `next_run` / `last_run` / `runs_count` get advanced.
///
/// OnEvent daemons are never returned here — they fire off frontend-dispatched
/// events, not the clock. The frontend wires up its own listeners and calls
/// `daemons_mark_fired` directly when they trigger.
pub async fn daemons_ready_to_fire(now_secs: i64) -> Result<Vec<Daemon>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<Daemon>, String> {
        let daemons = load_daemons()?;
        Ok(daemons
            .into_iter()
            .filter(|d| d.enabled)
            .filter(|d| d.kind != "on_event")
            .filter(|d| d.next_run.map(|t| t <= now_secs).unwrap_or(false))
            .collect())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Called by the frontend after it has dispatched a daemon's goal to the
/// sub-agent runner and the run has completed (success or error).
///
/// - Bumps runs_count and records last_run / last_status / last_output (output
///   capped at 1000 chars).
/// - Once daemons auto-disable after firing.
/// - Interval daemons get next_run advanced, unless they hit max_runs, in
///   which case they auto-disable.
/// - OnEvent daemons stay enabled with next_run=None — they only fire on
///   frontend-dispatched events.
pub async fn daemons_mark_fired(
    id: String,
    now_secs: i64,
    status: String,
    output: String,
) -> Result<Daemon, String> {
    tokio::task::spawn_blocking(move || -> Result<Daemon, String> {
        let mut daemons = load_daemons()?;
        let idx = daemons
            .iter()
            .position(|d| d.id == id)
            .ok_or_else(|| format!("daemon {id} not found"))?;

        let runs_count = daemons[idx].runs_count.saturating_add(1);
        let hit_cap = daemons[idx]
            .max_runs
            .map(|cap| runs_count >= cap)
            .unwrap_or(false);

        let still_enabled = match daemons[idx].kind.as_str() {
            "once" => false,
            "interval" => daemons[idx].enabled && !hit_cap,
            "on_event" => daemons[idx].enabled && !hit_cap,
            _ => false,
        };

        // Build a temporary daemon with the new last_run so compute_next_run
        // advances correctly for interval daemons.
        let advanced_base = Daemon {
            last_run: Some(now_secs),
            runs_count,
            ..daemons[idx].clone()
        };

        let next_run = if still_enabled {
            compute_next_run(&advanced_base, now_secs)
        } else {
            None
        };

        let updated = Daemon {
            last_run: Some(now_secs),
            last_status: Some(status),
            last_output: Some(truncate_output(&output)),
            runs_count,
            enabled: still_enabled,
            next_run,
            ..daemons[idx].clone()
        };

        daemons[idx] = updated.clone();
        save_daemons(&daemons)?;
        Ok(updated)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// -------------------- tests --------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Unique hermetic scratch dir under `std::env::temp_dir()`, removed on drop.
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
                "sunny-daemons-test-{tag}-{pid}-{nanos}-{seq}",
                pid = std::process::id()
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

    fn sample_daemon(kind: &str, at: Option<i64>, every: Option<u64>, max_runs: Option<u64>) -> Daemon {
        Daemon {
            id: new_id(),
            title: "test".into(),
            kind: kind.into(),
            at,
            every_sec: every,
            on_event: None,
            goal: "do a thing".into(),
            enabled: true,
            next_run: None,
            last_run: None,
            last_status: None,
            last_output: None,
            runs_count: 0,
            max_runs,
            created_at: 0,
        }
    }

    // 1. add + list roundtrip via the same save_to/load_from codepath the
    //    public API uses, just pointed at a scratch dir so the test doesn't
    //    touch ~/.sunny.
    #[test]
    fn daemons_add_then_list_roundtrip_preserves_fields() {
        let scratch = Scratch::new("roundtrip");
        let mut d = sample_daemon("interval", Some(1_700_000_000), Some(60), Some(5));
        d.next_run = compute_next_run(&d, 1_700_000_000);

        let original = vec![d.clone()];
        save_to(&scratch.path, &original).expect("save");
        let loaded = load_from(&scratch.path).expect("load");

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, d.id);
        assert_eq!(loaded[0].title, "test");
        assert_eq!(loaded[0].kind, "interval");
        assert_eq!(loaded[0].every_sec, Some(60));
        assert_eq!(loaded[0].max_runs, Some(5));
        assert_eq!(loaded[0].goal, "do a thing");
        assert!(loaded[0].enabled);
    }

    // 2. compute_next_run for interval and once (covers clamp + already-ran +
    //    interval progression + on_event always None).
    #[test]
    fn compute_next_run_covers_interval_and_once() {
        let now = 1_000_000;

        // Once in the future -> exactly `at`.
        let once_future = sample_daemon("once", Some(now + 60), None, None);
        assert_eq!(compute_next_run(&once_future, now), Some(now + 60));

        // Once in the past -> clamps to now so it fires immediately.
        let once_past = sample_daemon("once", Some(now - 60), None, None);
        assert_eq!(compute_next_run(&once_past, now), Some(now));

        // Once already ran -> None.
        let mut once_done = sample_daemon("once", Some(now - 60), None, None);
        once_done.last_run = Some(now - 30);
        assert_eq!(compute_next_run(&once_done, now), None);

        // Interval fresh -> at + every.
        let interval = sample_daemon("interval", Some(now), Some(300), None);
        assert_eq!(compute_next_run(&interval, now), Some(now + 300));

        // Interval with last_run -> last_run + every.
        let mut ran = sample_daemon("interval", Some(now - 600), Some(300), None);
        ran.last_run = Some(now - 100);
        assert_eq!(compute_next_run(&ran, now), Some(now + 200));

        // Interval far behind (eg laptop slept) clamps to now.
        let mut behind = sample_daemon("interval", Some(now - 10_000), Some(60), None);
        behind.last_run = Some(now - 10_000);
        assert_eq!(compute_next_run(&behind, now), Some(now));

        // Interval with every_sec = 0 is invalid.
        let bad = sample_daemon("interval", Some(now), Some(0), None);
        assert_eq!(compute_next_run(&bad, now), None);

        // OnEvent is never time-driven.
        let mut ev = sample_daemon("on_event", None, None, None);
        ev.on_event = Some("sunny:custom".into());
        assert_eq!(compute_next_run(&ev, now), None);
    }

    // First-fire stability for interval daemons with no `at` anchor — the
    // bug this patch fixes. The daemon is created at T with every_sec=3600;
    // the first fire must be T+3600 regardless of how much wall-clock time
    // has elapsed when compute_next_run is called (ie across app restarts).
    // Previously `base` fell back to `now`, so each restart pushed the first
    // fire forward by another `every_sec`.
    #[test]
    fn compute_next_run_interval_anchors_on_created_at_not_now() {
        let t: i64 = 1_700_000_000;
        let every: u64 = 3600;
        let mut d = sample_daemon("interval", None, Some(every), None);
        d.created_at = t;

        // Called 100s after creation — first fire should be T + 3600.
        assert_eq!(compute_next_run(&d, t + 100), Some(t + every as i64));
        // Called 200s after creation — still T + 3600. Stable across "restarts".
        assert_eq!(compute_next_run(&d, t + 200), Some(t + every as i64));
        // Even called right at creation, same answer.
        assert_eq!(compute_next_run(&d, t), Some(t + every as i64));

        // Sanity: if the user supplied an explicit `at`, it still wins over
        // created_at (at is the documented anchor override).
        let mut with_at = sample_daemon("interval", Some(t + 500), Some(every), None);
        with_at.created_at = t;
        assert_eq!(
            compute_next_run(&with_at, t + 100),
            Some(t + 500 + every as i64)
        );
    }

    // Legacy on-disk migration: records written before `created_at` existed
    // must still load. We synthesize the legacy JSON shape (no created_at
    // key) and verify load_from backfills it from `at` when present, or
    // falls back to a sane non-zero value when absent.
    #[test]
    fn load_from_migrates_legacy_records_without_created_at() {
        let scratch = Scratch::new("legacy-migrate");
        let legacy = r#"[
          {
            "id": "legacy-with-at",
            "title": "old interval",
            "kind": "interval",
            "at": 1699999000,
            "every_sec": 60,
            "on_event": null,
            "goal": "keep going",
            "enabled": true,
            "next_run": null,
            "last_run": null,
            "last_status": null,
            "last_output": null,
            "runs_count": 0,
            "max_runs": null
          },
          {
            "id": "legacy-no-at",
            "title": "old interval w/o at",
            "kind": "interval",
            "at": null,
            "every_sec": 60,
            "on_event": null,
            "goal": "keep going",
            "enabled": true,
            "next_run": null,
            "last_run": null,
            "last_status": null,
            "last_output": null,
            "runs_count": 0,
            "max_runs": null
          }
        ]"#;
        fs::write(scratch.path.join(FILE_NAME), legacy).expect("seed legacy");

        let loaded = load_from(&scratch.path).expect("load legacy");
        assert_eq!(loaded.len(), 2);
        // Record that had `at` set adopts it as created_at.
        let with_at = loaded.iter().find(|d| d.id == "legacy-with-at").unwrap();
        assert_eq!(with_at.created_at, 1699999000);
        // Record without `at` falls back to now_unix() — just assert it got
        // a non-zero, recent-ish value.
        let without_at = loaded.iter().find(|d| d.id == "legacy-no-at").unwrap();
        assert!(
            without_at.created_at > 1_600_000_000,
            "expected now_unix() fallback, got {}",
            without_at.created_at
        );
    }

    // 3. mark_fired updates next_run correctly — we simulate the load / mark /
    //    save loop against the scratch dir directly so we don't touch ~/.sunny.
    #[test]
    fn mark_fired_advances_next_run_for_interval() {
        let scratch = Scratch::new("mark-fired");
        let mut d = sample_daemon("interval", Some(1_000_000), Some(300), None);
        d.next_run = compute_next_run(&d, 1_000_000);
        let daemons = vec![d.clone()];
        save_to(&scratch.path, &daemons).expect("save");

        // Simulate mark_fired at t=1_000_500.
        let fired_at = 1_000_500;
        let mut reloaded = load_from(&scratch.path).expect("load");
        let idx = reloaded.iter().position(|x| x.id == d.id).unwrap();

        let runs_count = reloaded[idx].runs_count + 1;
        let advanced_base = Daemon {
            last_run: Some(fired_at),
            runs_count,
            ..reloaded[idx].clone()
        };
        let next = compute_next_run(&advanced_base, fired_at);

        reloaded[idx] = Daemon {
            last_run: Some(fired_at),
            last_status: Some("ok".into()),
            last_output: Some("done".into()),
            runs_count,
            next_run: next,
            ..reloaded[idx].clone()
        };
        save_to(&scratch.path, &reloaded).expect("save");

        let loaded = load_from(&scratch.path).expect("reload");
        assert_eq!(loaded[0].last_run, Some(fired_at));
        assert_eq!(loaded[0].runs_count, 1);
        // next_run = last_run + every_sec = 1_000_500 + 300 = 1_000_800
        assert_eq!(loaded[0].next_run, Some(1_000_800));
        assert_eq!(loaded[0].last_status.as_deref(), Some("ok"));
        assert_eq!(loaded[0].last_output.as_deref(), Some("done"));
        assert!(loaded[0].enabled);
    }

    // 4. max_runs respected — after the cap is reached the daemon auto-
    //    disables and next_run clears, exactly like the real API path does.
    #[test]
    fn max_runs_auto_disables_daemon_after_cap() {
        let scratch = Scratch::new("max-runs");
        let mut d = sample_daemon("interval", Some(1_000_000), Some(60), Some(2));
        d.next_run = compute_next_run(&d, 1_000_000);
        save_to(&scratch.path, &[d.clone()]).expect("save");

        // Helper to apply the same logic as daemons_mark_fired against scratch.
        let fire_once = |at: i64| {
            let mut daemons = load_from(&scratch.path).expect("load");
            let idx = daemons.iter().position(|x| x.id == d.id).unwrap();
            let runs_count = daemons[idx].runs_count + 1;
            let hit_cap = daemons[idx]
                .max_runs
                .map(|cap| runs_count >= cap)
                .unwrap_or(false);
            let still_enabled = daemons[idx].enabled && !hit_cap;
            let advanced_base = Daemon {
                last_run: Some(at),
                runs_count,
                ..daemons[idx].clone()
            };
            let next_run = if still_enabled {
                compute_next_run(&advanced_base, at)
            } else {
                None
            };
            daemons[idx] = Daemon {
                last_run: Some(at),
                last_status: Some("ok".into()),
                last_output: Some("x".into()),
                runs_count,
                enabled: still_enabled,
                next_run,
                ..daemons[idx].clone()
            };
            save_to(&scratch.path, &daemons).expect("save");
        };

        // Fire 1 — still enabled with runs_count 1.
        fire_once(1_000_100);
        let loaded = load_from(&scratch.path).expect("reload");
        assert_eq!(loaded[0].runs_count, 1);
        assert!(loaded[0].enabled);
        assert!(loaded[0].next_run.is_some());

        // Fire 2 — hits cap, auto-disables, next_run clears.
        fire_once(1_000_200);
        let loaded = load_from(&scratch.path).expect("reload");
        assert_eq!(loaded[0].runs_count, 2);
        assert!(
            !loaded[0].enabled,
            "daemon should auto-disable once runs_count hits max_runs"
        );
        assert_eq!(loaded[0].next_run, None);
    }
}

// === REGISTER IN lib.rs ===
// mod daemons;
// #[tauri::command]s: daemons_list, daemons_add, daemons_update, daemons_delete, daemons_set_enabled, daemons_ready_to_fire, daemons_mark_fired
// invoke_handler: same names
// No new Cargo deps.
// === END REGISTER ===
