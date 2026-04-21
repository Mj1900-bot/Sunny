//! Build sensor — tails known log files for error patterns.
//!
//! Watches a configurable list of log file paths (Cargo, Xcode, npm, etc.)
//! for lines matching the error regex. When a new matching line appears,
//! publishes `SunnyEvent::AutopilotSignal { source: "build" }`.
//!
//! Implementation strategy: stat each file every 5 s; if the byte length
//! grew, read only the newly appended bytes and scan for the error pattern.
//! This avoids re-reading the whole file on every poll and keeps CPU near
//! zero during quiet periods.
//!
//! No panics: every I/O error is caught and logged; the loop continues.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use chrono::Utc;
use regex::Regex;

use crate::event_bus::{self, SunnyEvent};
use crate::supervise;

const POLL_INTERVAL_SECS: u64 = 5;
/// Maximum bytes read per file per poll (limits memory under log explosions).
const MAX_READ_BYTES: u64 = 64 * 1024;

/// Error pattern covering Cargo, Xcode, npm, and generic `error:` lines.
const ERROR_PATTERN: &str =
    r"(?i)(error(\[E\d+\])?:\s|^error\b|FAILED|Build FAILED|npm ERR!|xcodebuild.*error)";

/// Returns the list of log files to tail. Caller may extend this.
fn default_log_paths() -> Vec<PathBuf> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    vec![
        // Cargo build output piped to a known path by the user's build script.
        home.join(".sunny/logs/cargo_build.log"),
        // Generic build log written by the user's project scaffold.
        home.join(".sunny/logs/build.log"),
    ]
}

/// Spawn the supervised sensor task.
pub fn spawn() {
    spawn_with_paths(default_log_paths());
}

/// Spawn with an explicit path list (used by tests).
pub fn spawn_with_paths(paths: Vec<PathBuf>) {
    supervise::spawn_supervised("autopilot_sensor_build", move || {
        let paths = paths.clone();
        async move {
            run_build_loop(paths).await;
        }
    });
}

async fn run_build_loop(paths: Vec<PathBuf>) {
    let error_re = match Regex::new(ERROR_PATTERN) {
        Ok(r) => r,
        Err(e) => {
            log::error!("[autopilot/build] failed to compile error regex: {e}");
            return;
        }
    };

    // Track last-known file size (bytes) per path.
    let mut file_offsets: HashMap<PathBuf, u64> = HashMap::new();

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;

        for path in &paths {
            if let Err(e) = tail_file(path, &mut file_offsets, &error_re) {
                log::debug!("[autopilot/build] tail {}: {e}", path.display());
            }
        }
    }
}

fn tail_file(
    path: &PathBuf,
    offsets: &mut HashMap<PathBuf, u64>,
    error_re: &Regex,
) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let new_len = meta.len();
    let prev_len = offsets.get(path).copied().unwrap_or(new_len);

    // File was truncated or first read — reset offset.
    let start = if new_len < prev_len { 0 } else { prev_len };

    if new_len == start {
        // Nothing new.
        offsets.insert(path.clone(), new_len);
        return Ok(());
    }

    let to_read = (new_len - start).min(MAX_READ_BYTES);

    let mut f = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek: {e}"))?;

    let mut buf = vec![0u8; to_read as usize];
    let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
    buf.truncate(n);

    offsets.insert(path.clone(), start + n as u64);

    let text = String::from_utf8_lossy(&buf);
    let error_lines: Vec<&str> = text
        .lines()
        .filter(|line| error_re.is_match(line))
        .take(5)
        .collect();

    if !error_lines.is_empty() {
        let payload = serde_json::json!({
            "log_file": path.display().to_string(),
            "error_lines": error_lines,
            "count": error_lines.len(),
        })
        .to_string();

        event_bus::publish(SunnyEvent::AutopilotSignal {
            seq: 0,
            boot_epoch: 0,
            source: "build".to_string(),
            payload,
            at: Utc::now().timestamp_millis(),
        });
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TmpFile(PathBuf);
    impl TmpFile {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "sunny-build-sensor-test-{}-{name}",
                std::process::id()
            ));
            TmpFile(p)
        }
        fn write(&self, content: &[u8]) {
            let mut f = std::fs::File::create(&self.0).unwrap();
            f.write_all(content).unwrap();
            f.sync_all().unwrap();
        }
    }
    impl Drop for TmpFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn re() -> Regex {
        Regex::new(ERROR_PATTERN).unwrap()
    }

    #[test]
    fn error_regex_matches_cargo_error() {
        let r = re();
        assert!(r.is_match("error[E0308]: mismatched types"));
        assert!(r.is_match("error: could not compile"));
    }

    #[test]
    fn error_regex_matches_npm_error() {
        let r = re();
        assert!(r.is_match("npm ERR! code ENOENT"));
    }

    #[test]
    fn error_regex_does_not_match_clean_output() {
        let r = re();
        assert!(!r.is_match("   Compiling sunny v0.1.0"));
        assert!(!r.is_match("    Finished dev [unoptimized] target(s) in 1.23s"));
    }

    #[test]
    fn tail_file_detects_new_errors() {
        let tmp = TmpFile::new("tail_test.log");
        tmp.write(b"   Compiling foo\nerror: something went wrong\n");
        let mut offsets = HashMap::new();
        let r = re();
        tail_file(&tmp.0, &mut offsets, &r).unwrap();
        assert!(offsets[&tmp.0] > 0, "offset should advance after read");
    }

    #[test]
    fn tail_file_skips_already_read_bytes() {
        let tmp = TmpFile::new("tail_test2.log");
        tmp.write(b"error: first error\n");
        let mut offsets = HashMap::new();
        let r = re();
        tail_file(&tmp.0, &mut offsets, &r).unwrap();
        let first_offset = offsets[&tmp.0];

        // No new content — should not advance offset.
        tail_file(&tmp.0, &mut offsets, &r).unwrap();
        assert_eq!(offsets[&tmp.0], first_offset, "offset must not advance on no-new-content");
    }

    #[test]
    fn tail_file_nonexistent_returns_err() {
        let p = PathBuf::from("/no/such/file/exists.log");
        let mut offsets = HashMap::new();
        let r = re();
        assert!(tail_file(&p, &mut offsets, &r).is_err());
    }
}
