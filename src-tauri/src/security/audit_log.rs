//! Append-only, SHA-256 hash-chained audit log.
//!
//! Every autonomous-mode action is written as a JSONL row to
//! `~/.sunny/security/audit.jsonl`. Each row contains a `prev_hash`
//! field that is the SHA-256 of the previous row's complete JSON text,
//! forming a tamper-evident chain. The chain head (latest hash) is
//! persisted to `~/.sunny/security/chain_head` (mode 0400) after every
//! append so callers can resume incremental verification cheaply.
//!
//! # Concurrency
//!
//! The file is protected by an advisory lock (`flock(2)` via
//! `libc::flock`) held only during the critical write section so
//! concurrent processes (e.g. a diagnostics CLI and the main app) do
//! not interleave partial lines.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::security::redact::RedactionSet;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Risk classification for a single tool invocation.
/// L0 = read-only / informational, L5 = irreversible destructive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RiskLevel {
    L0,
    L1,
    L2,
    L3,
    L4,
    L5,
}

impl RiskLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            RiskLevel::L0 => "L0",
            RiskLevel::L1 => "L1",
            RiskLevel::L2 => "L2",
            RiskLevel::L3 => "L3",
            RiskLevel::L4 => "L4",
            RiskLevel::L5 => "L5",
        }
    }
}

/// Which verdict was recorded for the action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// Passed through automatically (no human gate).
    Auto,
    /// Human clicked "approve" in the attended modal.
    Approved,
    /// Human clicked "deny" or the auto-policy rejected it.
    Denied,
    /// Action queued for next attended session (unattended + L2).
    Deferred,
}

/// Who triggered the tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Initiator {
    Daemon,
    User,
}

/// One audit log row. Serialised as a single JSON line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    /// Unix epoch milliseconds.
    pub ts_ms: i64,
    /// Tool name, e.g. `"fs_write"`.
    pub tool: String,
    pub initiator: Initiator,
    /// SHA-256 of the JSON-serialised arguments (before redaction).
    pub input_hash: String,
    /// Redacted, truncated preview of the arguments.
    pub input_preview: String,
    /// First 512 chars of LLM rationale (may be empty if not available).
    pub reasoning: String,
    pub risk_level: RiskLevel,
    /// `true` when a human is considered present (idle < 600 s).
    pub attended: bool,
    pub verdict: Verdict,
    /// SHA-256 of the previous row's full JSON text. Genesis row uses
    /// `"0000000000000000000000000000000000000000000000000000000000000000"`.
    pub prev_hash: String,
}

// ---------------------------------------------------------------------------
// VerifyReport
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct VerifyReport {
    pub rows_checked: usize,
    /// If the chain is intact `break_at` is `None`.  Otherwise it holds
    /// the 0-based row index of the first broken link.
    pub break_at: Option<usize>,
}

impl VerifyReport {
    pub fn is_ok(&self) -> bool {
        self.break_at.is_none()
    }
}

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

pub struct AuditLog {
    path: PathBuf,
    chain_head_path: PathBuf,
    /// Serialise appends; the mutex is per-process only — cross-process
    /// safety is handled by the file lock inside `append`.
    append_lock: Mutex<()>,
}

const GENESIS_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

impl AuditLog {
    /// Open (or create) the audit log at `path`.  The companion
    /// `chain_head` file lives in the same directory.
    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref().to_path_buf();

        // Ensure the parent directory exists.
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| anyhow::anyhow!("audit_log: create dir {:?}: {e}", parent))?;
        }

        let chain_head_path = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("chain_head");

        Ok(Self {
            path,
            chain_head_path,
            append_lock: Mutex::new(()),
        })
    }

    // ------------------------------------------------------------------
    // append
    // ------------------------------------------------------------------

    /// Append one entry.  The `prev_hash` field on `entry` is ignored and
    /// replaced by the actual chain head read from disk, so callers do not
    /// need to track it.  Returns the new chain head hash.
    pub fn append(&self, mut entry: Entry) -> anyhow::Result<String> {
        let _guard = self
            .append_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("audit_log: append mutex poisoned"))?;

        // Read the current chain head from the sidecar file.
        let prev_hash = self.read_chain_head();

        entry.prev_hash = prev_hash;

        let line = serde_json::to_string(&entry)
            .map_err(|e| anyhow::anyhow!("audit_log: serialise entry: {e}"))?;

        let new_hash = sha256_of(&line);

        // Open with create + append so the file is created on first use
        // and subsequent opens never truncate.
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| anyhow::anyhow!("audit_log: open {:?}: {e}", self.path))?;

        // Advisory lock for the duration of the write + flush.
        advisory_lock(&file)?;

        {
            let mut writer = BufWriter::new(&file);
            writer
                .write_all(line.as_bytes())
                .map_err(|e| anyhow::anyhow!("audit_log: write line: {e}"))?;
            writer
                .write_all(b"\n")
                .map_err(|e| anyhow::anyhow!("audit_log: write newline: {e}"))?;
            writer
                .flush()
                .map_err(|e| anyhow::anyhow!("audit_log: flush: {e}"))?;
        }

        advisory_unlock(&file)?;

        // Persist the new chain head (mode 0400 on Unix).
        self.write_chain_head(&new_hash)?;

        Ok(new_hash)
    }

    // ------------------------------------------------------------------
    // verify_chain
    // ------------------------------------------------------------------

    /// Walk every row in the file and verify the hash chain.
    /// Returns a [`VerifyReport`] with the position of the first broken
    /// link, or `break_at: None` when the chain is intact.
    pub fn verify_chain(&self) -> anyhow::Result<VerifyReport> {
        let file = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(VerifyReport { rows_checked: 0, break_at: None });
            }
            Err(e) => return Err(anyhow::anyhow!("audit_log: open for verify: {e}")),
        };

        let reader = BufReader::new(file);
        let mut expected_prev = GENESIS_HASH.to_string();
        let mut row_idx = 0usize;

        for raw_line in reader.lines() {
            let line = raw_line
                .map_err(|e| anyhow::anyhow!("audit_log: read line {row_idx}: {e}"))?;

            if line.trim().is_empty() {
                continue;
            }

            let entry: Entry = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => {
                    // A row that cannot be parsed is itself evidence of
                    // tampering — treat it as a chain break.
                    return Ok(VerifyReport {
                        rows_checked: row_idx,
                        break_at: Some(row_idx),
                    });
                }
            };

            if entry.prev_hash != expected_prev {
                return Ok(VerifyReport {
                    rows_checked: row_idx,
                    break_at: Some(row_idx),
                });
            }

            // The hash of this row becomes the expected prev_hash for the
            // next row.
            expected_prev = sha256_of(&line);
            row_idx += 1;
        }

        Ok(VerifyReport {
            rows_checked: row_idx,
            break_at: None,
        })
    }

    // ------------------------------------------------------------------
    // tail
    // ------------------------------------------------------------------

    /// Return the last `n` entries (newest last, as they appear on disk).
    pub fn tail(&self, n: usize) -> Vec<Entry> {
        if n == 0 {
            return vec![];
        }
        self.read_all_entries()
            .into_iter()
            .rev()
            .take(n)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    // ------------------------------------------------------------------
    // entries_for_day
    // ------------------------------------------------------------------

    /// Return all entries whose `ts_ms` falls on the given UTC date.
    pub fn entries_for_day(&self, date: NaiveDate) -> Vec<Entry> {
        let day_start_ms = date
            .and_hms_opt(0, 0, 0)
            .and_then(|ndt| Utc.from_utc_datetime(&ndt).timestamp_millis().into())
            .unwrap_or(0i64);
        let day_end_ms = day_start_ms + 86_400_000;

        self.read_all_entries()
            .into_iter()
            .filter(|e| e.ts_ms >= day_start_ms && e.ts_ms < day_end_ms)
            .collect()
    }

    // ------------------------------------------------------------------
    // L3_plus_denied_for
    // ------------------------------------------------------------------

    /// Return denied entries at L3 or above for the given UTC date.
    /// Intended for the morning review queue.
    #[allow(non_snake_case)]
    pub fn L3_plus_denied_for(&self, date: NaiveDate) -> Vec<Entry> {
        self.entries_for_day(date)
            .into_iter()
            .filter(|e| e.risk_level >= RiskLevel::L3 && e.verdict == Verdict::Denied)
            .collect()
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    fn read_chain_head(&self) -> String {
        std::fs::read_to_string(&self.chain_head_path)
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| GENESIS_HASH.to_string())
    }

    fn write_chain_head(&self, hash: &str) -> anyhow::Result<()> {
        // Remove the previous file so we can create a fresh one even if
        // the previous write set permissions to 0400 (owner-read-only).
        // Ignoring removal errors is intentional — the file may not exist
        // on the first append and that is fine.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // If the file exists, widen permissions before overwriting.
            if self.chain_head_path.exists() {
                let _ = std::fs::set_permissions(
                    &self.chain_head_path,
                    std::fs::Permissions::from_mode(0o600),
                );
            }
        }

        std::fs::write(&self.chain_head_path, hash)
            .map_err(|e| anyhow::anyhow!("audit_log: write chain_head: {e}"))?;

        // Lock down to owner-read-only so the chain head cannot be silently
        // tampered with by another process running as the same user.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o400);
            let _ = std::fs::set_permissions(&self.chain_head_path, perms);
        }

        Ok(())
    }

    fn read_all_entries(&self) -> Vec<Entry> {
        let file = match File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return vec![],
        };
        BufReader::new(file)
            .lines()
            .filter_map(|l| l.ok())
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<Entry>(&l).ok())
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Entry builder helpers
// ---------------------------------------------------------------------------

/// Compute `input_hash` from the raw args JSON string, and `input_preview`
/// by running the redactor over a truncated copy.
pub fn make_input_fields(args_json: &str) -> (String, String) {
    let hash = format!("sha256-{}", sha256_of(args_json));
    let preview = {
        let redacted = RedactionSet::get().scrub(args_json);
        if redacted.chars().count() <= 256 {
            redacted
        } else {
            let mut s: String = redacted.chars().take(255).collect();
            s.push('…');
            s
        }
    };
    (hash, preview)
}

/// Truncate `reasoning` to the first 512 characters.
pub fn truncate_reasoning(s: &str) -> String {
    if s.chars().count() <= 512 {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(511).collect();
        out.push('…');
        out
    }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

fn sha256_of(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(unix)]
fn advisory_lock(file: &File) -> anyhow::Result<()> {
    use std::os::unix::io::AsRawFd;
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if ret != 0 {
        Err(anyhow::anyhow!(
            "audit_log: flock LOCK_EX failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn advisory_unlock(file: &File) -> anyhow::Result<()> {
    use std::os::unix::io::AsRawFd;
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if ret != 0 {
        Err(anyhow::anyhow!(
            "audit_log: flock LOCK_UN failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn advisory_lock(_file: &File) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn advisory_unlock(_file: &File) -> anyhow::Result<()> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use std::sync::Arc;

    fn tmp_log() -> (AuditLog, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tmp dir");
        let path = dir.path().join("audit.jsonl");
        let log = AuditLog::open(&path).expect("open");
        (log, dir)
    }

    fn make_entry(tool: &str, risk: RiskLevel, verdict: Verdict, ts_ms: i64) -> Entry {
        Entry {
            ts_ms,
            tool: tool.to_string(),
            initiator: Initiator::Daemon,
            input_hash: "sha256-abc".to_string(),
            input_preview: "{}".to_string(),
            reasoning: "test reasoning".to_string(),
            risk_level: risk,
            attended: false,
            verdict,
            prev_hash: GENESIS_HASH.to_string(), // overwritten by append
        }
    }

    // ------------------------------------------------------------------
    // 1. genesis row has prev_hash of all zeros
    // ------------------------------------------------------------------
    #[test]
    fn genesis_prev_hash_is_zeros() {
        let (log, _dir) = tmp_log();
        let entry = make_entry("fs_read", RiskLevel::L0, Verdict::Auto, 1_000_000);
        log.append(entry).expect("append");

        let entries = log.tail(1);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].prev_hash, GENESIS_HASH);
    }

    // ------------------------------------------------------------------
    // 2. second row's prev_hash equals sha256 of first row's JSON line
    // ------------------------------------------------------------------
    #[test]
    fn chain_links_correctly() {
        let (log, _dir) = tmp_log();
        log.append(make_entry("fs_read", RiskLevel::L0, Verdict::Auto, 1_000))
            .expect("row 1");
        log.append(make_entry("fs_write", RiskLevel::L2, Verdict::Approved, 2_000))
            .expect("row 2");

        let report = log.verify_chain().expect("verify");
        assert!(report.is_ok(), "chain should be intact: {:?}", report);
        assert_eq!(report.rows_checked, 2);
    }

    // ------------------------------------------------------------------
    // 3. verify_chain returns break position when a byte is mutated
    // ------------------------------------------------------------------
    #[test]
    fn tamper_detected() {
        let (log, dir) = tmp_log();
        for i in 0..3u64 {
            log.append(make_entry("tool", RiskLevel::L1, Verdict::Auto, i as i64 * 1000))
                .expect("append");
        }

        // Mutate a byte deep inside row 1 (the middle row).
        let path = dir.path().join("audit.jsonl");
        let content = std::fs::read_to_string(&path).expect("read");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);

        // Flip one character in the *body* of row 1 (not the hash field
        // itself, to avoid accidentally fixing the chain).
        let mut mutated = lines[1].to_string();
        // Find 'L' in risk_level value and change it to 'X'.
        // We target a spot well away from prev_hash.
        let pos = mutated.find("\"tool\"").expect("find tool field");
        let byte_pos = pos + 1; // inside quotes
        let mut bytes = mutated.into_bytes();
        bytes[byte_pos] ^= 0x01; // flip a bit
        mutated = String::from_utf8_lossy(&bytes).into_owned();

        let new_content = format!("{}\n{}\n{}\n", lines[0], mutated, lines[2]);
        std::fs::write(&path, new_content).expect("write tampered");

        let report = log.verify_chain().expect("verify");
        assert!(!report.is_ok(), "tamper should be detected");
        // Row 1 (0-indexed) has the mutation; the break is detected when
        // row 2's prev_hash no longer matches the hash of the tampered row 1.
        assert!(
            report.break_at.is_some(),
            "break_at should be Some: {:?}",
            report
        );
    }

    // ------------------------------------------------------------------
    // 4. tail ordering — newest entries returned in chronological order
    // ------------------------------------------------------------------
    #[test]
    fn tail_ordering() {
        let (log, _dir) = tmp_log();
        for i in 0..5i64 {
            log.append(make_entry("tool", RiskLevel::L0, Verdict::Auto, i * 1000))
                .expect("append");
        }

        let tail = log.tail(3);
        assert_eq!(tail.len(), 3);
        // tail(3) of [0,1,2,3,4] should be [2,3,4] in order
        assert_eq!(tail[0].ts_ms, 2_000);
        assert_eq!(tail[1].ts_ms, 3_000);
        assert_eq!(tail[2].ts_ms, 4_000);
    }

    // ------------------------------------------------------------------
    // 5. tail(n) when n > total rows returns all rows
    // ------------------------------------------------------------------
    #[test]
    fn tail_clamped_to_available_rows() {
        let (log, _dir) = tmp_log();
        log.append(make_entry("t", RiskLevel::L0, Verdict::Auto, 1)).expect("a");
        log.append(make_entry("t", RiskLevel::L0, Verdict::Auto, 2)).expect("b");

        let tail = log.tail(100);
        assert_eq!(tail.len(), 2);
    }

    // ------------------------------------------------------------------
    // 6. entries_for_day filters by UTC date correctly
    // ------------------------------------------------------------------
    #[test]
    fn entries_for_day_filters_correctly() {
        let (log, _dir) = tmp_log();
        // 2026-04-20 00:00:00 UTC
        let day_start_ms: i64 = 1_776_643_200_000; // 2026-04-20 00:00:00 UTC
        log.append(make_entry("t", RiskLevel::L1, Verdict::Auto, day_start_ms + 1_000))
            .expect("in-day");
        log.append(make_entry("t", RiskLevel::L1, Verdict::Auto, day_start_ms - 1_000))
            .expect("before-day");
        log.append(make_entry("t", RiskLevel::L1, Verdict::Auto, day_start_ms + 86_400_001))
            .expect("after-day");

        let date = NaiveDate::from_ymd_opt(2026, 4, 20).unwrap();
        let entries = log.entries_for_day(date);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].ts_ms, day_start_ms + 1_000);
    }

    // ------------------------------------------------------------------
    // 7. L3_plus_denied_for returns only L3+ denied for the given day
    // ------------------------------------------------------------------
    #[test]
    fn l3_plus_denied_for_filters_correctly() {
        let (log, _dir) = tmp_log();
        let base_ms: i64 = 1_776_643_200_000; // 2026-04-20 00:00:00 UTC

        // L2 denied — should NOT appear
        log.append(make_entry("t", RiskLevel::L2, Verdict::Denied, base_ms + 1_000))
            .expect("l2");
        // L3 denied — should appear
        log.append(make_entry("t", RiskLevel::L3, Verdict::Denied, base_ms + 2_000))
            .expect("l3");
        // L4 approved — should NOT appear
        log.append(make_entry("t", RiskLevel::L4, Verdict::Approved, base_ms + 3_000))
            .expect("l4 approved");
        // L5 denied — should appear
        log.append(make_entry("t", RiskLevel::L5, Verdict::Denied, base_ms + 4_000))
            .expect("l5");

        let date = NaiveDate::from_ymd_opt(2026, 4, 20).unwrap();
        let results = log.L3_plus_denied_for(date);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].risk_level, RiskLevel::L3);
        assert_eq!(results[1].risk_level, RiskLevel::L5);
    }

    // ------------------------------------------------------------------
    // 8. verify_chain on empty file reports 0 rows, no break
    // ------------------------------------------------------------------
    #[test]
    fn verify_empty_file() {
        let (log, _dir) = tmp_log();
        let report = log.verify_chain().expect("verify");
        assert_eq!(report.rows_checked, 0);
        assert!(report.is_ok());
    }

    // ------------------------------------------------------------------
    // 9. make_input_fields redacts secrets in preview
    // ------------------------------------------------------------------
    #[test]
    fn input_fields_redact_secrets() {
        let args = r#"{"key":"sk-ant-abcd1234efgh5678ijkl9012mnop3456","path":"/tmp/file"}"#;
        let (hash, preview) = make_input_fields(args);
        assert!(hash.starts_with("sha256-"), "hash prefix");
        assert!(!preview.contains("sk-ant-"), "key must be redacted");
        assert!(preview.contains("***"), "redaction marker present");
    }

    // ------------------------------------------------------------------
    // 10. input_preview truncated at 256 chars with ellipsis
    // ------------------------------------------------------------------
    #[test]
    fn input_preview_truncated() {
        let long_args = format!(r#"{{"data":"{}"}}"#, "x".repeat(500));
        let (_hash, preview) = make_input_fields(&long_args);
        assert!(preview.chars().count() <= 256);
        assert!(preview.ends_with('…'));
    }

    // ------------------------------------------------------------------
    // 11. truncate_reasoning caps at 512 chars
    // ------------------------------------------------------------------
    #[test]
    fn reasoning_truncated_at_512() {
        let long = "r".repeat(600);
        let out = truncate_reasoning(&long);
        assert!(out.chars().count() <= 512);
        assert!(out.ends_with('…'));

        let short = "hello";
        assert_eq!(truncate_reasoning(short), short);
    }

    // ------------------------------------------------------------------
    // 12. concurrent appends serialise correctly (no interleaved lines)
    // ------------------------------------------------------------------
    #[test]
    fn concurrent_appends_serialize() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let path = dir.path().join("audit.jsonl");
        let log = Arc::new(AuditLog::open(&path).expect("open"));

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let log = Arc::clone(&log);
                std::thread::spawn(move || {
                    log.append(make_entry(
                        "concurrent_tool",
                        RiskLevel::L1,
                        Verdict::Auto,
                        i * 100,
                    ))
                    .expect("concurrent append");
                })
            })
            .collect();

        for h in handles {
            h.join().expect("thread panicked");
        }

        // All 8 rows must be present and parse cleanly.
        let content = std::fs::read_to_string(&path).expect("read");
        let line_count = content.lines().count();
        assert_eq!(line_count, 8, "expected 8 rows, got {line_count}");

        // Every line must be valid JSON.
        for line in content.lines() {
            serde_json::from_str::<Entry>(line).expect("valid JSON line");
        }

        // Chain must be intact (the mutex serialises writes in-process).
        let report = log.verify_chain().expect("verify");
        assert!(report.is_ok(), "chain broken after concurrent appends: {:?}", report);
    }
}
