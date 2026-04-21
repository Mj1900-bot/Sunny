//! Governor — cost ledger, token buckets, calm mode, speaking slot.
//!
//! Persisted to `~/.sunny/autopilot.json` via atomic write (tmp → rename, 0600).
//! All mutation is immutable-first: load → transform → save.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIR_NAME: &str = ".sunny";
const FILE_NAME: &str = "autopilot.json";

/// Default daily GLM cost cap in USD.
pub const DEFAULT_DAILY_GLM_CAP_USD: f64 = 1.0;
/// Default GLM calls allowed per hour (token bucket capacity).
pub const DEFAULT_GLM_CALLS_PER_HOUR: u32 = 20;
/// Default Ollama calls allowed per hour.
pub const DEFAULT_OLLAMA_CALLS_PER_HOUR: u32 = 60;
/// Token bucket refill period in seconds (1 hour).
const BUCKET_REFILL_PERIOD_SECS: u64 = 3600;

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

/// On-disk snapshot. All fields are `#[serde(default)]` so old files load
/// cleanly when new fields are added.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GovernorDisk {
    /// Total GLM cost accrued today (USD). Resets at UTC midnight.
    #[serde(default)]
    pub daily_glm_cost_usd: f64,

    /// UTC date string for the current cost window ("YYYY-MM-DD").
    /// When this differs from today, `daily_glm_cost_usd` is reset.
    #[serde(default)]
    pub cost_window_date: String,

    /// Daily cap (USD). Configurable by the user.
    #[serde(default = "default_daily_cap")]
    pub daily_glm_cap_usd: f64,

    /// GLM calls remaining in the current bucket window.
    #[serde(default = "default_glm_calls")]
    pub glm_bucket_remaining: u32,

    /// Ollama calls remaining in the current bucket window.
    #[serde(default = "default_ollama_calls")]
    pub ollama_bucket_remaining: u32,

    /// Unix second when the current bucket window started.
    #[serde(default)]
    pub bucket_window_start_secs: u64,

    /// When true, the daemon suppresses all T2+ (voice) surfaces.
    #[serde(default)]
    pub calm_mode: bool,

    /// Kill switch — when false, only T0 (silent log) events pass through.
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_daily_cap() -> f64 {
    DEFAULT_DAILY_GLM_CAP_USD
}
fn default_glm_calls() -> u32 {
    DEFAULT_GLM_CALLS_PER_HOUR
}
fn default_ollama_calls() -> u32 {
    DEFAULT_OLLAMA_CALLS_PER_HOUR
}
fn default_true() -> bool {
    true
}

impl Default for GovernorDisk {
    fn default() -> Self {
        GovernorDisk {
            daily_glm_cost_usd: 0.0,
            cost_window_date: String::new(),
            daily_glm_cap_usd: DEFAULT_DAILY_GLM_CAP_USD,
            glm_bucket_remaining: DEFAULT_GLM_CALLS_PER_HOUR,
            ollama_bucket_remaining: DEFAULT_OLLAMA_CALLS_PER_HOUR,
            bucket_window_start_secs: now_unix(),
            calm_mode: false,
            active: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Governor struct (process-wide singleton via OnceLock)
// ---------------------------------------------------------------------------

/// Process-wide governor. Holds an in-memory mirror of the disk state behind
/// a `Mutex` so concurrent sensor tasks can query it cheaply.
pub struct Governor {
    state: Mutex<GovernorDisk>,
    dir: PathBuf,
    /// Mutex that serialises "speaking slot" — only one voice surface at a time.
    speaking_slot: Mutex<()>,
}

static GOVERNOR: OnceLock<Governor> = OnceLock::new();

impl Governor {
    /// Initialise the process-wide governor, loading persisted state from
    /// `~/.sunny/autopilot.json`. Subsequent calls return `Err` (already init).
    pub fn init() -> Result<(), String> {
        let home = dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())?;
        let dir = home.join(DIR_NAME);
        Governor::init_in(dir)
    }

    /// Parameterised init for tests (points at a scratch dir).
    pub fn init_in(dir: PathBuf) -> Result<(), String> {
        let disk = load_from(&dir).unwrap_or_default();
        let gov = Governor {
            state: Mutex::new(disk),
            dir,
            speaking_slot: Mutex::new(()),
        };
        GOVERNOR
            .set(gov)
            .map_err(|_| "Governor already initialised".to_string())
    }

    /// Create a standalone (non-singleton) Governor for integration tests.
    /// Unlike `init_in`, this does NOT touch the process-wide `GOVERNOR`
    /// OnceLock, so multiple tests can each own an independent instance.
    /// Callers are responsible for leaking or keeping the instance alive.
    pub fn new_for_test(dir: PathBuf) -> Governor {
        let disk = load_from(&dir).unwrap_or_default();
        Governor {
            state: Mutex::new(disk),
            dir,
            speaking_slot: Mutex::new(()),
        }
    }

    /// Obtain a reference to the process-wide governor.
    /// Returns `None` before `init()` is called.
    pub fn get() -> Option<&'static Governor> {
        GOVERNOR.get()
    }

    // -----------------------------------------------------------------------
    // Cost ledger
    // -----------------------------------------------------------------------

    /// Record a GLM call cost (USD). Returns `Err` if the daily cap would be
    /// exceeded — the caller should abort the call before making it.
    pub fn charge_glm(&self, cost_usd: f64) -> Result<(), String> {
        let mut state = self.lock();
        let state = roll_day_if_needed(&mut state);
        if state.daily_glm_cost_usd + cost_usd > state.daily_glm_cap_usd {
            return Err(format!(
                "GLM daily cap ${:.2} would be exceeded (current ${:.2}, charge ${cost_usd:.4})",
                state.daily_glm_cap_usd, state.daily_glm_cost_usd
            ));
        }
        state.daily_glm_cost_usd += cost_usd;
        self.persist(state)
    }

    /// Current daily GLM spend (USD).
    pub fn daily_spend_usd(&self) -> f64 {
        self.lock().daily_glm_cost_usd
    }

    /// Set the daily GLM cap (persisted).
    pub fn set_daily_cap(&self, cap_usd: f64) -> Result<(), String> {
        let mut state = self.lock();
        state.daily_glm_cap_usd = cap_usd;
        self.persist(&state)
    }

    // -----------------------------------------------------------------------
    // Token buckets
    // -----------------------------------------------------------------------

    /// Attempt to consume one GLM call token. Returns `Err` if the bucket is
    /// empty. Refills automatically when the hour window rolls over.
    pub fn consume_glm_token(&self) -> Result<(), String> {
        let mut state = self.lock();
        refill_bucket_if_needed(&mut state);
        if state.glm_bucket_remaining == 0 {
            return Err("GLM calls-per-hour bucket exhausted".to_string());
        }
        state.glm_bucket_remaining -= 1;
        self.persist(&state)
    }

    /// Attempt to consume one Ollama call token.
    pub fn consume_ollama_token(&self) -> Result<(), String> {
        let mut state = self.lock();
        refill_bucket_if_needed(&mut state);
        if state.ollama_bucket_remaining == 0 {
            return Err("Ollama calls-per-hour bucket exhausted".to_string());
        }
        state.ollama_bucket_remaining -= 1;
        self.persist(&state)
    }

    // -----------------------------------------------------------------------
    // Calm mode
    // -----------------------------------------------------------------------

    /// Returns true when calm mode is active (suppresses T2+ voice surfaces).
    pub fn is_calm(&self) -> bool {
        self.lock().calm_mode
    }

    /// Enable or disable calm mode (persisted).
    pub fn set_calm(&self, calm: bool) -> Result<(), String> {
        let mut state = self.lock();
        state.calm_mode = calm;
        self.persist(&state)
    }

    // -----------------------------------------------------------------------
    // Kill switch
    // -----------------------------------------------------------------------

    /// Returns true when the daemon is active. When false, only T0 events pass.
    pub fn is_active(&self) -> bool {
        self.lock().active
    }

    /// Halt the daemon (persisted). Only T0 silent-log events pass when halted.
    pub fn set_active(&self, active: bool) -> Result<(), String> {
        let mut state = self.lock();
        state.active = active;
        self.persist(&state)
    }

    // -----------------------------------------------------------------------
    // Speaking slot
    // -----------------------------------------------------------------------

    /// Try to acquire the speaking slot (non-blocking). Returns `Ok(guard)`
    /// when the slot is free; `Err` if another voice surface is already in
    /// progress. The slot is released when the guard is dropped.
    pub fn try_speaking(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.speaking_slot
            .try_lock()
            .map_err(|_| "speaking slot busy — another voice surface is active".to_string())
    }

    // -----------------------------------------------------------------------
    // Snapshot (for tests / diagnostics)
    // -----------------------------------------------------------------------

    /// Clone the current in-memory state.
    pub fn snapshot(&self) -> GovernorDisk {
        self.lock().clone()
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn lock(&self) -> std::sync::MutexGuard<'_, GovernorDisk> {
        match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    fn persist(&self, state: &GovernorDisk) -> Result<(), String> {
        save_to(&self.dir, state)
    }
}

// ---------------------------------------------------------------------------
// Day-roll helper (pure transform, returns &mut for chaining)
// ---------------------------------------------------------------------------

fn today_date() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// If the stored cost window is a different calendar day than today, reset the
/// daily spend. Mutates in place; returns `&mut GovernorDisk` for chaining.
fn roll_day_if_needed(state: &mut GovernorDisk) -> &mut GovernorDisk {
    let today = today_date();
    if state.cost_window_date != today {
        state.daily_glm_cost_usd = 0.0;
        state.cost_window_date = today;
    }
    state
}

/// Refill both buckets if the 1-hour window has elapsed.
fn refill_bucket_if_needed(state: &mut GovernorDisk) {
    let now = now_unix();
    if now.saturating_sub(state.bucket_window_start_secs) >= BUCKET_REFILL_PERIOD_SECS {
        state.glm_bucket_remaining = DEFAULT_GLM_CALLS_PER_HOUR;
        state.ollama_bucket_remaining = DEFAULT_OLLAMA_CALLS_PER_HOUR;
        state.bucket_window_start_secs = now;
    }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

fn governor_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

fn load_from(dir: &Path) -> Result<GovernorDisk, String> {
    let path = governor_path(dir);
    if !path.exists() {
        return Ok(GovernorDisk::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read autopilot.json: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(GovernorDisk::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("parse autopilot.json: {e}"))
}

static TMP_CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Atomic write: unique tmp path → fsync → rename → chmod 0600.
pub fn save_to(dir: &Path, state: &GovernorDisk) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create .sunny dir: {e}"))?;

    let final_path = governor_path(dir);
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ctr = TMP_CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = dir.join(format!("{FILE_NAME}.tmp.{pid}.{nanos}.{ctr}"));

    let serialized =
        serde_json::to_string_pretty(state).map_err(|e| format!("serialize autopilot.json: {e}"))?;

    let write_result: Result<(), String> = (|| {
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
        format!("rename autopilot.json: {e}")
    })
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms).map_err(|e| format!("chmod autopilot.json: {e}"))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir()
                .join(format!("sunny-autopilot-gov-test-{}-{n}", std::process::id()));
            fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fresh_gov(scratch: &Scratch) -> &'static Governor {
        // Each test needs its own Governor because it's a OnceLock singleton.
        // We bypass init_in and build the struct directly for isolation.
        // SAFETY: leaking is fine in tests; they're short-lived processes.
        let disk = GovernorDisk::default();
        let gov = Box::new(Governor {
            state: Mutex::new(disk),
            dir: scratch.0.clone(),
            speaking_slot: Mutex::new(()),
        });
        Box::leak(gov)
    }

    #[test]
    fn persistence_round_trip() {
        let scratch = Scratch::new();
        let gov = fresh_gov(&scratch);

        gov.set_calm(true).unwrap();
        gov.set_active(false).unwrap();

        // Reload from disk.
        let loaded = load_from(&scratch.0).expect("load");
        assert!(loaded.calm_mode);
        assert!(!loaded.active);
    }

    #[test]
    fn token_bucket_refills_after_window() {
        let scratch = Scratch::new();
        let gov = fresh_gov(&scratch);

        // Drain the GLM bucket completely.
        for _ in 0..DEFAULT_GLM_CALLS_PER_HOUR {
            gov.consume_glm_token().expect("should not be exhausted yet");
        }
        assert!(gov.consume_glm_token().is_err(), "bucket should be empty");

        // Force window expiry by back-dating bucket_window_start_secs.
        {
            let mut state = gov.lock();
            state.bucket_window_start_secs = now_unix() - BUCKET_REFILL_PERIOD_SECS - 1;
        }

        // Next consume should refill first.
        gov.consume_glm_token().expect("bucket should have refilled");
        assert_eq!(
            gov.snapshot().glm_bucket_remaining,
            DEFAULT_GLM_CALLS_PER_HOUR - 1
        );
    }

    #[test]
    fn daily_cap_blocks_overspend() {
        let scratch = Scratch::new();
        let gov = fresh_gov(&scratch);
        gov.set_daily_cap(0.10).unwrap();

        gov.charge_glm(0.09).unwrap();
        assert!(
            gov.charge_glm(0.02).is_err(),
            "charge exceeding cap must be rejected"
        );
        // Partial charge that stays within cap is allowed.
        gov.charge_glm(0.01).unwrap();
    }

    #[test]
    fn day_roll_resets_spend() {
        let mut state = GovernorDisk {
            daily_glm_cost_usd: 0.50,
            cost_window_date: "2000-01-01".to_string(),
            daily_glm_cap_usd: 1.0,
            ..GovernorDisk::default()
        };
        roll_day_if_needed(&mut state);
        assert_eq!(state.daily_glm_cost_usd, 0.0, "spend should reset on day roll");
        assert_ne!(state.cost_window_date, "2000-01-01");
    }

    #[test]
    fn calm_mode_persists_across_reload() {
        let scratch = Scratch::new();
        let gov = fresh_gov(&scratch);
        assert!(!gov.is_calm());
        gov.set_calm(true).unwrap();
        assert!(gov.is_calm());

        let reloaded = load_from(&scratch.0).unwrap();
        assert!(reloaded.calm_mode);
    }

    #[test]
    fn speaking_slot_is_exclusive() {
        let scratch = Scratch::new();
        let gov = fresh_gov(&scratch);

        let _guard = gov.try_speaking().expect("first acquire should succeed");
        assert!(
            gov.try_speaking().is_err(),
            "second acquire must fail while first is held"
        );
    }

    #[test]
    fn kill_switch_default_is_active() {
        let disk = GovernorDisk::default();
        assert!(disk.active, "daemon must default to active");
    }

    #[test]
    fn atomic_write_produces_valid_json() {
        let scratch = Scratch::new();
        let state = GovernorDisk::default();
        save_to(&scratch.0, &state).unwrap();
        let raw = fs::read_to_string(governor_path(&scratch.0)).unwrap();
        let _: GovernorDisk = serde_json::from_str(&raw).unwrap();
    }
}
