//! Filesystem-backed user settings, stored at ~/.sunny/settings.json.
//!
//! The React store owns the Settings schema. On the Rust side we treat the
//! payload as opaque JSON — we just atomically persist whatever the frontend
//! gives us and read it back on launch. That keeps schema changes contained
//! in TypeScript without requiring a Rust release for every new field.

use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const SETTINGS_DIR: &str = ".sunny";
const SETTINGS_FILE: &str = "settings.json";

fn settings_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home.join(SETTINGS_DIR))
}

pub fn load() -> Result<Value, String> {
    load_from(&settings_dir()?)
}

pub fn save(value: &Value) -> Result<(), String> {
    save_to(&settings_dir()?, value)
}

/// Read settings JSON from the given directory. Returns `Value::Null` if the
/// settings file is missing or empty.
fn load_from(dir: &Path) -> Result<Value, String> {
    let path = dir.join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(Value::Null);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("parse settings: {e}"))
}

/// Atomically writes the JSON blob into the given directory. Write to a unique
/// tmp file (per-pid + nanotime so concurrent saves don't clobber each other's
/// bytes), set owner-only permissions (settings may later hold API keys), then
/// rename. On any write error the tmp file is best-effort removed so we don't
/// leave turds behind.
fn save_to(dir: &Path, value: &Value) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create settings dir: {e}"))?;

    let final_path = dir.join(SETTINGS_FILE);
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Include a monotonically increasing counter so two concurrent saves in the
    // same process at the same nanosecond still pick distinct tmp paths.
    let counter = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = dir.join(format!("{SETTINGS_FILE}.tmp.{pid}.{nanos}.{counter}"));

    let serialized =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize settings: {e}"))?;

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
        format!("rename tmp: {e}")
    })?;
    Ok(())
}

static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Unique hermetic scratch dir under `std::env::temp_dir()`, removed on drop.
    struct Scratch {
        path: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "sunny-settings-test-{tag}-{pid}-{nanos}-{seq}",
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

    #[test]
    fn save_then_load_roundtrip_preserves_settings_shape() {
        let scratch = Scratch::new("roundtrip");
        let value = json!({
            "provider": "anthropic",
            "model": "claude-opus-4-7",
            "theme": "british-dark"
        });

        save_to(&scratch.path, &value).expect("save");
        let loaded = load_from(&scratch.path).expect("load");

        assert_eq!(loaded, value);
        assert_eq!(loaded["provider"], "anthropic");
        assert_eq!(loaded["model"], "claude-opus-4-7");
        assert_eq!(loaded["theme"], "british-dark");
    }

    #[test]
    fn load_returns_null_when_file_is_missing() {
        let scratch = Scratch::new("missing");
        // No save() first — settings.json should not exist.
        let loaded = load_from(&scratch.path).expect("load missing");
        assert_eq!(loaded, Value::Null);
    }

    #[test]
    fn load_returns_null_when_file_is_empty() {
        let scratch = Scratch::new("empty");
        let path = scratch.path.join(SETTINGS_FILE);
        fs::write(&path, "   \n").expect("write empty");
        let loaded = load_from(&scratch.path).expect("load empty");
        assert_eq!(loaded, Value::Null);
    }

    #[cfg(unix)]
    #[test]
    fn save_writes_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new("perms");
        save_to(&scratch.path, &json!({"apiKey": "s3cret"})).expect("save");
        let meta = fs::metadata(scratch.path.join(SETTINGS_FILE)).expect("stat");
        // Only the low 9 permission bits (rwxrwxrwx) — strip type/sticky etc.
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0o600, got {:o}", mode);
    }

    #[test]
    fn concurrent_saves_do_not_corrupt_file() {
        use std::sync::Arc;
        use std::thread;

        let scratch = Arc::new(Scratch::new("concurrent"));
        let a = json!({"who": "alice", "n": 1});
        let b = json!({"who": "bob", "n": 2});

        let mut handles = Vec::new();
        // Run each save many times from two threads to raise the chance of
        // interleaving. The atomic rename guarantees the final file matches
        // exactly one of the two payloads, byte-for-byte.
        for _ in 0..20 {
            let s1 = Arc::clone(&scratch);
            let a1 = a.clone();
            handles.push(thread::spawn(move || {
                save_to(&s1.path, &a1).expect("save alice");
            }));
            let s2 = Arc::clone(&scratch);
            let b1 = b.clone();
            handles.push(thread::spawn(move || {
                save_to(&s2.path, &b1).expect("save bob");
            }));
        }
        for h in handles {
            h.join().expect("join");
        }

        let loaded = load_from(&scratch.path).expect("final load");
        assert!(
            loaded == a || loaded == b,
            "final settings did not match either writer: {loaded:?}"
        );

        // No tmp files should linger in the dir after all saves complete.
        let leftover: Vec<_> = fs::read_dir(&scratch.path)
            .expect("read dir")
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(&format!("{SETTINGS_FILE}.tmp."))
            })
            .collect();
        assert!(leftover.is_empty(), "tmp files leaked: {leftover:?}");
    }
}
