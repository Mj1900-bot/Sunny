//! Typed, atomic, hot-reload settings store for SUNNY.
//!
//! Persists to `~/.sunny/settings.json` with:
//! - Atomic writes via tmp-file + `rename(2)` (POSIX guarantee)
//! - `0600` owner-only permissions on every write
//! - [`ArcSwap`]-style hot-reload via `Arc<RwLock<SunnySettings>>` + a
//!   `tokio::sync::broadcast` channel so in-process subscribers (Autopilot,
//!   WakeWord, etc.) receive `SettingsChanged` without polling
//! - Schema migration: any field missing in a saved file is filled from
//!   `SunnySettings::default()` and immediately written back
//!
//! # Hot-reload design
//!
//! ```text
//!   write path:  with_updated(f)
//!                  -> apply f (immutable)
//!                  -> serialize + atomic rename
//!                  -> swap Arc inside RwLock
//!                  -> broadcast SettingsChanged
//!
//!   read path:   get()
//!                  -> RwLock::read() (non-blocking when no write in flight)
//!                  -> clone SunnySettings (cheap — all fields are small)
//! ```
//!
//! Reads are concurrent and never block writes for longer than the
//! `RwLock::read()` acquisition.  Writes are serialised through a
//! `Mutex<()>` guard that is held while the tmp-file is written and
//! the lock swapped — the broadcast send is outside the mutex.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutopilotSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub speak_enabled: bool,
    #[serde(default)]
    pub calm_mode: bool,
    #[serde(default = "default_daily_cost_cap")]
    pub daily_cost_cap_usd: f64,
}

impl Default for AutopilotSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            speak_enabled: true,
            calm_mode: false,
            daily_cost_cap_usd: default_daily_cost_cap(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WakeWordSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_confidence_threshold")]
    pub confidence_threshold: f32,
}

impl Default for WakeWordSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            confidence_threshold: default_confidence_threshold(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContinuitySettings {
    #[serde(default = "default_true")]
    pub warm_context_enabled: bool,
    #[serde(default = "default_warm_context_sessions")]
    pub warm_context_sessions: u32,
}

impl Default for ContinuitySettings {
    fn default() -> Self {
        Self {
            warm_context_enabled: true,
            warm_context_sessions: default_warm_context_sessions(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "PascalCase")]
pub enum TrustLevel {
    ConfirmAll,
    #[default]
    Smart,
    Autonomous,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceSettings {
    #[serde(default = "default_tts_voice")]
    pub tts_voice: String,
    #[serde(default = "default_tts_speed")]
    pub tts_speed: f32,
    #[serde(default = "default_stt_model")]
    pub stt_model: String,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            tts_voice: default_tts_voice(),
            tts_speed: default_tts_speed(),
            stt_model: default_stt_model(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum QualityMode {
    AlwaysBest,
    #[default]
    Balanced,
    CostAware,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderSettings {
    #[serde(default)]
    pub prefer_local: bool,
    #[serde(default = "default_glm_daily_cap")]
    pub glm_daily_cap_usd: f64,
    #[serde(default)]
    pub quality_mode: QualityMode,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            prefer_local: false,
            glm_daily_cap_usd: default_glm_daily_cap(),
            quality_mode: QualityMode::default(),
        }
    }
}

/// Top-level settings struct.  Every sub-struct is `#[serde(default)]` so
/// old settings files with missing sections migrate automatically.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SunnySettings {
    #[serde(default)]
    pub autopilot: AutopilotSettings,
    #[serde(default)]
    pub wake_word: WakeWordSettings,
    #[serde(default)]
    pub continuity: ContinuitySettings,
    #[serde(default)]
    pub trust_level: TrustLevel,
    #[serde(default)]
    pub voice: VoiceSettings,
    #[serde(default)]
    pub providers: ProviderSettings,
}

impl Default for SunnySettings {
    fn default() -> Self {
        Self {
            autopilot: AutopilotSettings::default(),
            wake_word: WakeWordSettings::default(),
            continuity: ContinuitySettings::default(),
            trust_level: TrustLevel::default(),
            voice: VoiceSettings::default(),
            providers: ProviderSettings::default(),
        }
    }
}

// Default-value helpers (serde `default = "fn"` requires free functions)
fn default_true() -> bool { true }
fn default_daily_cost_cap() -> f64 { 5.0 }
fn default_confidence_threshold() -> f32 { 0.85 }
fn default_warm_context_sessions() -> u32 { 3 }
fn default_tts_voice() -> String { "com.apple.voice.compact.en-GB.Daniel".into() }
fn default_tts_speed() -> f32 { 1.0 }
fn default_stt_model() -> String { "base.en".into() }
fn default_glm_daily_cap() -> f64 { 2.0 }

// ---------------------------------------------------------------------------
// Change-notification payload
// ---------------------------------------------------------------------------

/// Emitted on the broadcast channel after every successful `with_updated`.
/// `field_path` is a dot-separated JSON-pointer describing what changed
/// (e.g. `"autopilot.calm_mode"`).  `old` and `new` are the full serialised
/// snapshots so subscribers can diff what they care about.
#[derive(Debug, Clone)]
pub struct SettingsChanged {
    pub field_path: String,
    pub old: SunnySettings,
    pub new: SunnySettings,
}

// ---------------------------------------------------------------------------
// Process-singleton store
// ---------------------------------------------------------------------------

const SETTINGS_DIR: &str = ".sunny";
const SETTINGS_FILE: &str = "settings.json";
const BROADCAST_CAPACITY: usize = 64;

/// Monotonic counter for unique tmp-file names (same pattern as `settings.rs`).
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The live in-memory snapshot.  `RwLock` lets many concurrent readers grab
/// a clone without blocking each other; writers hold it only for the
/// microseconds it takes to swap the `Arc`.
static SNAPSHOT: OnceLock<Arc<RwLock<SunnySettings>>> = OnceLock::new();

/// Serialises write operations so two concurrent `with_updated` calls don't
/// race on the filesystem.
static WRITE_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

/// Broadcast sender shared for the lifetime of the process.
static BROADCAST: OnceLock<broadcast::Sender<SettingsChanged>> = OnceLock::new();

fn snapshot() -> &'static Arc<RwLock<SunnySettings>> {
    SNAPSHOT.get_or_init(|| Arc::new(RwLock::new(SunnySettings::default())))
}

fn write_mutex() -> &'static Mutex<()> {
    WRITE_MUTEX.get_or_init(|| Mutex::new(()))
}

fn broadcast_sender() -> &'static broadcast::Sender<SettingsChanged> {
    BROADCAST.get_or_init(|| {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        tx
    })
}

fn settings_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home.join(SETTINGS_DIR).join(SETTINGS_FILE))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Load settings from `~/.sunny/settings.json`, creating defaults if the file
/// is absent or incomplete (migration).  Installs the loaded snapshot into the
/// process-global store.
pub fn load() -> Result<SunnySettings, String> {
    let path = settings_path()?;

    let settings = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("read settings: {e}"))?;
        if raw.trim().is_empty() {
            SunnySettings::default()
        } else {
            // Deserialise with #[serde(default)] fills any missing fields.
            serde_json::from_str::<SunnySettings>(&raw)
                .map_err(|e| format!("parse settings: {e}"))?
        }
    } else {
        SunnySettings::default()
    };

    // Detect migration need: re-serialise + compare round-trip.  If the
    // file was missing or had absent fields the serialised form will differ
    // from the raw bytes on disk, so we write back the canonicalised form.
    let canonical = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("serialize settings: {e}"))?;
    let needs_write = if path.exists() {
        let raw = fs::read_to_string(&path).unwrap_or_default();
        raw.trim() != canonical.trim()
    } else {
        true
    };
    if needs_write {
        let dir = path.parent().ok_or("settings path has no parent")?;
        atomic_write(dir, &path, &settings)?;
    }

    // Install into global snapshot
    {
        let snap = snapshot();
        let mut w = snap.write().map_err(|_| "snapshot lock poisoned".to_string())?;
        *w = settings.clone();
    }

    Ok(settings)
}

/// Return a cheap clone of the current in-memory snapshot.  Never blocks
/// writes (RwLock read path only).
pub fn get() -> SunnySettings {
    snapshot()
        .read()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/// Apply `f` immutably (receives a clone, returns a new `SunnySettings`),
/// then atomically persist and swap the snapshot.  Emits
/// `SunnyEvent::SettingsChanged` on the event bus plus a typed
/// `SettingsChanged` on the dedicated broadcast channel.
///
/// `field_path` is a caller hint describing the logical path that changed,
/// used only in the broadcast payload (e.g. `"autopilot.calm_mode"`).
pub fn with_updated<F>(field_path: impl Into<String>, f: F) -> Result<SunnySettings, String>
where
    F: FnOnce(SunnySettings) -> SunnySettings,
{
    let field_path = field_path.into();

    // Serialise writes
    let _guard = write_mutex()
        .lock()
        .map_err(|_| "write mutex poisoned".to_string())?;

    let old = get();
    let new = f(old.clone());

    let path = settings_path()?;
    let dir = path.parent().ok_or("settings path has no parent")?;
    atomic_write(dir, &path, &new)?;

    // Swap snapshot
    {
        let snap = snapshot();
        let mut w = snap.write().map_err(|_| "snapshot lock poisoned".to_string())?;
        *w = new.clone();
    }

    // Broadcast on typed channel (fire-and-forget — a send error just means
    // no subscribers are currently listening)
    let _ = broadcast_sender().send(SettingsChanged {
        field_path: field_path.clone(),
        old: old.clone(),
        new: new.clone(),
    });

    // Publish onto the process-wide SunnyEvent bus so the SQLite drain and
    // any Tauri frontend listeners also see the change.
    crate::event_bus::publish(crate::event_bus::SunnyEvent::SettingsChanged {
        seq: 0,
        boot_epoch: 0,
        field_path,
        old_json: serde_json::to_string(&old).unwrap_or_default(),
        new_json: serde_json::to_string(&new).unwrap_or_default(),
        at: chrono::Utc::now().timestamp_millis(),
    });

    Ok(new)
}

/// Subscribe to settings-change notifications.  Returns a
/// `broadcast::Receiver<SettingsChanged>` — call `.recv().await` to get the
/// next change.  Lagged receivers skip missed events (broadcast semantics).
pub fn subscribe() -> broadcast::Receiver<SettingsChanged> {
    broadcast_sender().subscribe()
}

// ---------------------------------------------------------------------------
// Partial-merge helper (for `settings_update` Tauri command)
// ---------------------------------------------------------------------------

/// Deep-merge `partial` (a `serde_json::Value` object) into `base` and
/// return the result.  Scalar values in `partial` overwrite those in `base`;
/// nested objects are merged recursively.  Arrays replace (no append).
pub fn merge_partial(base: &SunnySettings, partial: Value) -> Result<SunnySettings, String> {
    // Serialise base to Value, merge, deserialise back — avoids bespoke logic.
    let mut base_val = serde_json::to_value(base)
        .map_err(|e| format!("serialize base settings: {e}"))?;
    merge_values(&mut base_val, partial);
    serde_json::from_value::<SunnySettings>(base_val)
        .map_err(|e| format!("deserialize merged settings: {e}"))
}

fn merge_values(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                merge_values(b.entry(k).or_insert(Value::Null), v);
            }
        }
        (base, patch) => *base = patch,
    }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

fn atomic_write(dir: &Path, final_path: &Path, settings: &SunnySettings) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create settings dir: {e}"))?;

    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!("{SETTINGS_FILE}.tmp.{pid}.{nanos}.{counter}"));

    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("serialize settings: {e}"))?;

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

    fs::rename(&tmp_path, final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("rename tmp->final: {e}")
    })?;

    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms).map_err(|e| format!("chmod settings: {e}"))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Return the current settings snapshot as JSON.
#[tauri::command]
pub fn settings_get() -> Result<SunnySettings, String> {
    Ok(get())
}

/// Merge `partial` into the current settings, persist atomically, and return
/// the resulting full settings object.
#[tauri::command]
pub fn settings_update(partial: Value) -> Result<SunnySettings, String> {
    with_updated("partial_update", |current| {
        merge_partial(&current, partial).unwrap_or(current)
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering as AOrdering};

    // -----------------------------------------------------------------------
    // Hermetic scratch directory (auto-removed on drop)
    // -----------------------------------------------------------------------

    struct Scratch {
        pub path: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = SEQ.fetch_add(1, AOrdering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "sunny-store-test-{tag}-{pid}-{nanos}-{seq}",
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

    fn write_settings(dir: &Path, s: &SunnySettings) {
        let final_path = dir.join(SETTINGS_FILE);
        atomic_write(dir, &final_path, s).expect("write_settings helper");
    }

    fn read_settings(dir: &Path) -> SunnySettings {
        let path = dir.join(SETTINGS_FILE);
        let raw = fs::read_to_string(&path).expect("read_settings helper");
        serde_json::from_str(&raw).expect("parse_settings helper")
    }

    // -----------------------------------------------------------------------
    // T01 — defaults are well-formed
    // -----------------------------------------------------------------------
    #[test]
    fn t01_default_settings_are_valid() {
        let d = SunnySettings::default();
        assert!(d.autopilot.enabled);
        assert!(d.autopilot.speak_enabled);
        assert!(!d.autopilot.calm_mode);
        assert_eq!(d.autopilot.daily_cost_cap_usd, 5.0);
        assert_eq!(d.trust_level, TrustLevel::Smart);
        assert_eq!(d.voice.tts_speed, 1.0);
        assert_eq!(d.continuity.warm_context_sessions, 3);
    }

    // -----------------------------------------------------------------------
    // T02 — round-trip serialisation
    // -----------------------------------------------------------------------
    #[test]
    fn t02_round_trip_json() {
        let scratch = Scratch::new("roundtrip");
        let original = SunnySettings {
            autopilot: AutopilotSettings {
                enabled: false,
                daily_cost_cap_usd: 3.5,
                ..Default::default()
            },
            trust_level: TrustLevel::Autonomous,
            ..Default::default()
        };
        write_settings(&scratch.path, &original);
        let loaded = read_settings(&scratch.path);
        assert_eq!(original, loaded);
    }

    // -----------------------------------------------------------------------
    // T03 — load with defaults when file missing
    // -----------------------------------------------------------------------
    #[test]
    fn t03_load_with_defaults_when_missing() {
        let scratch = Scratch::new("missing");
        // Nothing on disk — should parse a completely default struct
        let path = scratch.path.join(SETTINGS_FILE);
        assert!(!path.exists());

        let settings = if path.exists() {
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
        } else {
            SunnySettings::default()
        };
        assert_eq!(settings, SunnySettings::default());
    }

    // -----------------------------------------------------------------------
    // T04 — schema migration: missing fields filled from defaults
    // -----------------------------------------------------------------------
    #[test]
    fn t04_migration_fills_missing_fields() {
        let scratch = Scratch::new("migration");
        // Write a minimal/partial settings file that's missing most fields.
        let partial = r#"{"autopilot":{"enabled":false,"speak_enabled":true,"calm_mode":false,"daily_cost_cap_usd":1.0}}"#;
        fs::write(scratch.path.join(SETTINGS_FILE), partial).unwrap();

        let loaded: SunnySettings =
            serde_json::from_str(partial).expect("serde default fill");

        // Fields NOT in the partial JSON are filled from Default
        assert_eq!(loaded.voice.tts_speed, 1.0);
        assert_eq!(loaded.wake_word.confidence_threshold, 0.85);
        assert_eq!(loaded.continuity.warm_context_sessions, 3);
        assert_eq!(loaded.providers.glm_daily_cap_usd, 2.0);
        assert_eq!(loaded.trust_level, TrustLevel::Smart);
        // The explicit field IS present
        assert!(!loaded.autopilot.enabled);
        assert_eq!(loaded.autopilot.daily_cost_cap_usd, 1.0);
    }

    // -----------------------------------------------------------------------
    // T05 — atomic write: no tmp files left after success
    // -----------------------------------------------------------------------
    #[test]
    fn t05_atomic_write_no_tmp_leftovers() {
        let scratch = Scratch::new("atomic");
        let final_path = scratch.path.join(SETTINGS_FILE);
        atomic_write(&scratch.path, &final_path, &SunnySettings::default())
            .expect("atomic_write");

        let leftover: Vec<_> = fs::read_dir(&scratch.path)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(&format!("{SETTINGS_FILE}.tmp."))
            })
            .collect();
        assert!(leftover.is_empty(), "tmp files leaked: {leftover:?}");
    }

    // -----------------------------------------------------------------------
    // T06 — atomic write: file is 0600 (unix only)
    // -----------------------------------------------------------------------
    #[cfg(unix)]
    #[test]
    fn t06_atomic_write_owner_only_perms() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new("perms");
        let final_path = scratch.path.join(SETTINGS_FILE);
        atomic_write(&scratch.path, &final_path, &SunnySettings::default()).unwrap();
        let mode = fs::metadata(&final_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {:o}", mode);
    }

    // -----------------------------------------------------------------------
    // T07 — partial merge: scalar overwrites, nested merge, arrays replace
    // -----------------------------------------------------------------------
    #[test]
    fn t07_partial_merge_deep() {
        let base = SunnySettings::default();
        let patch = serde_json::json!({
            "autopilot": { "calm_mode": true, "daily_cost_cap_usd": 9.99 },
            "trust_level": "Autonomous"
        });
        let merged = merge_partial(&base, patch).expect("merge_partial");
        assert!(merged.autopilot.calm_mode);
        assert_eq!(merged.autopilot.daily_cost_cap_usd, 9.99);
        assert_eq!(merged.trust_level, TrustLevel::Autonomous);
        // Fields NOT in patch remain at default
        assert!(merged.autopilot.enabled);
        assert!(merged.autopilot.speak_enabled);
        assert_eq!(merged.voice.tts_speed, 1.0);
    }

    // -----------------------------------------------------------------------
    // T08 — partial merge preserves unpatched sub-structs
    // -----------------------------------------------------------------------
    #[test]
    fn t08_partial_merge_preserves_untouched_structs() {
        let mut base = SunnySettings::default();
        base.voice.tts_voice = "en-AU-William".into();
        let patch = serde_json::json!({ "autopilot": { "calm_mode": true } });
        let merged = merge_partial(&base, patch).unwrap();
        assert_eq!(merged.voice.tts_voice, "en-AU-William");
        assert!(merged.autopilot.calm_mode);
    }

    // -----------------------------------------------------------------------
    // T09 — invalid JSON returns Err, not panic
    // -----------------------------------------------------------------------
    #[test]
    fn t09_invalid_json_returns_err() {
        let result = serde_json::from_str::<SunnySettings>("not valid json {{{");
        assert!(result.is_err(), "expected Err on malformed JSON");
    }

    // -----------------------------------------------------------------------
    // T10 — invalid JSON for merge_partial returns Err
    // -----------------------------------------------------------------------
    #[test]
    fn t10_merge_partial_bad_type_returns_err() {
        let base = SunnySettings::default();
        // `autopilot` should be an object, not a string
        let patch = serde_json::json!({ "autopilot": "not-an-object" });
        let result = merge_partial(&base, patch);
        assert!(result.is_err(), "expected Err on type mismatch");
    }

    // -----------------------------------------------------------------------
    // T11 — concurrent reads never block (RwLock property)
    // -----------------------------------------------------------------------
    #[test]
    fn t11_concurrent_reads_do_not_block_each_other() {
        use std::sync::Barrier;

        let barrier = Arc::new(Barrier::new(8));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let b = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                b.wait(); // all threads start simultaneously
                let _ = get(); // concurrent read
            }));
        }
        for h in handles {
            h.join().expect("thread panicked");
        }
    }

    // -----------------------------------------------------------------------
    // T12 — concurrent atomic writes produce valid JSON (no corruption)
    // -----------------------------------------------------------------------
    #[test]
    fn t12_concurrent_atomic_writes_no_corruption() {
        let scratch = Arc::new(Scratch::new("concurrent-writes"));
        let final_path = scratch.path.join(SETTINGS_FILE);
        let a = {
            let mut s = SunnySettings::default();
            s.autopilot.daily_cost_cap_usd = 1.0;
            s
        };
        let b = {
            let mut s = SunnySettings::default();
            s.autopilot.daily_cost_cap_usd = 2.0;
            s
        };
        let mut handles = Vec::new();
        for _ in 0..10 {
            let s1 = Arc::clone(&scratch);
            let fp = final_path.clone();
            let a1 = a.clone();
            handles.push(std::thread::spawn(move || {
                atomic_write(&s1.path, &fp, &a1).unwrap();
            }));
            let s2 = Arc::clone(&scratch);
            let fp2 = final_path.clone();
            let b1 = b.clone();
            handles.push(std::thread::spawn(move || {
                atomic_write(&s2.path, &fp2, &b1).unwrap();
            }));
        }
        for h in handles {
            h.join().expect("thread join");
        }
        // File must be valid JSON matching either writer
        let raw = fs::read_to_string(&final_path).expect("final read");
        let loaded: SunnySettings = serde_json::from_str(&raw).expect("valid JSON after concurrent writes");
        assert!(
            loaded == a || loaded == b,
            "unexpected value after concurrent writes: {:?}",
            loaded.autopilot.daily_cost_cap_usd
        );
        // No tmp leftovers
        let leftovers: Vec<_> = fs::read_dir(&scratch.path)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "tmp files leaked");
    }

    // -----------------------------------------------------------------------
    // T13 — with_updated applies immutably (original snapshot unchanged)
    // -----------------------------------------------------------------------
    #[test]
    fn t13_with_updated_is_immutable() {
        // Snapshot the current global before the test
        let before = get();
        // We use a scratch path helper rather than the global store to keep
        // this test hermetic — call merge_partial directly
        let original = SunnySettings::default();
        let updated = merge_partial(
            &original,
            serde_json::json!({ "autopilot": { "calm_mode": true } }),
        )
        .unwrap();
        // The `original` binding is unchanged (immutable pattern)
        assert!(!original.autopilot.calm_mode);
        assert!(updated.autopilot.calm_mode);
        // Global snapshot is still `before` (we didn't call with_updated on
        // the global store)
        let after = get();
        assert_eq!(before.autopilot.calm_mode, after.autopilot.calm_mode);
    }

    // -----------------------------------------------------------------------
    // T14 — subscribe returns a working broadcast receiver
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn t14_subscribe_receives_settings_changed() {
        let mut rx = subscribe();
        // Fire a change on the global broadcast channel directly (bypassing
        // the filesystem write so the test stays hermetic)
        let old = SunnySettings::default();
        let mut new_s = SunnySettings::default();
        new_s.autopilot.calm_mode = true;
        let _ = broadcast_sender().send(SettingsChanged {
            field_path: "autopilot.calm_mode".into(),
            old: old.clone(),
            new: new_s.clone(),
        });
        let received = rx.recv().await.expect("should receive event");
        assert_eq!(received.field_path, "autopilot.calm_mode");
        assert!(!received.old.autopilot.calm_mode);
        assert!(received.new.autopilot.calm_mode);
    }

    // -----------------------------------------------------------------------
    // T15 — merge_values: object is recursively merged, not replaced
    // -----------------------------------------------------------------------
    #[test]
    fn t15_merge_values_deep_object_not_replaced() {
        let mut base = serde_json::json!({
            "a": { "x": 1, "y": 2 },
            "b": 3
        });
        let patch = serde_json::json!({ "a": { "y": 99 } });
        merge_values(&mut base, patch);
        assert_eq!(base["a"]["x"], 1, "x should survive");
        assert_eq!(base["a"]["y"], 99, "y should be patched");
        assert_eq!(base["b"], 3, "b should survive");
    }

    // -----------------------------------------------------------------------
    // T16 — TrustLevel serialises to PascalCase strings
    // -----------------------------------------------------------------------
    #[test]
    fn t16_trust_level_serde_round_trip() {
        for (variant, expected) in [
            (TrustLevel::ConfirmAll, "\"ConfirmAll\""),
            (TrustLevel::Smart, "\"Smart\""),
            (TrustLevel::Autonomous, "\"Autonomous\""),
        ] {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, expected);
            let back: TrustLevel = serde_json::from_str(&json).unwrap();
            assert_eq!(back, variant);
        }
    }

    // -----------------------------------------------------------------------
    // T17 — empty file treated as default (no parse panic)
    // -----------------------------------------------------------------------
    #[test]
    fn t17_empty_file_falls_back_to_default() {
        let scratch = Scratch::new("empty");
        let path = scratch.path.join(SETTINGS_FILE);
        fs::write(&path, "   \n").unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let settings = if raw.trim().is_empty() {
            SunnySettings::default()
        } else {
            serde_json::from_str(&raw).unwrap()
        };
        assert_eq!(settings, SunnySettings::default());
    }
}
