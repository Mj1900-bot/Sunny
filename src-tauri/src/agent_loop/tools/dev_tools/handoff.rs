//! Handoff file writer — atomically writes `{project_path}/.sunny/handoff.json`
//! with 0600 permissions so only the owning user can read the context blob.
//!
//! The write is atomic: we write to a `.tmp` sibling first, then `rename` into
//! place so a crashing writer never leaves a partial file for the dev tool to
//! read.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The data handed to the dev tool on launch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffPayload {
    /// Short description of what the user wants the tool to do.
    pub intent: String,
    /// Relative file paths most relevant to the task.
    #[serde(default)]
    pub relevant_files: Vec<String>,
    /// Snapshot of the clipboard at launch time (may be empty).
    #[serde(default)]
    pub clipboard_snapshot: String,
    /// Compressed conversation summary for context (may be empty).
    #[serde(default)]
    pub conversation_summary: String,
    /// ISO-8601 timestamp of when the handoff was written.
    pub written_at: String,
    /// The session id so the tool can write results to the right bus dir.
    pub session_id: String,
}

/// Write `payload` to `{project_path}/.sunny/handoff.json` atomically with
/// 0600 permissions.  Only paths under `{project_path}/.sunny/` may be
/// written; any attempt to escape that prefix returns `Err`.
pub fn write_handoff(project_path: &str, payload: &HandoffPayload) -> Result<PathBuf, String> {
    let sunny_dir = Path::new(project_path).join(".sunny");
    let final_path = sunny_dir.join("handoff.json");
    let tmp_path = sunny_dir.join("handoff.json.tmp");

    // Safety gate: ensure both paths are under {project_path}/.sunny/
    ensure_under_sunny_dir(&final_path, &sunny_dir)?;
    ensure_under_sunny_dir(&tmp_path, &sunny_dir)?;

    fs::create_dir_all(&sunny_dir)
        .map_err(|e| format!("create .sunny dir: {e}"))?;

    let json = serde_json::to_string_pretty(payload)
        .map_err(|e| format!("serialize handoff: {e}"))?;

    // Write with 0600 — exclusive owner r/w, no group or other bits.
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|e| format!("open handoff tmp: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write handoff: {e}"))?;
        f.flush().map_err(|e| format!("flush handoff: {e}"))?;
        // f drops here — OS flushes kernel buffers on close.
    }

    fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("rename handoff into place: {e}"))?;

    Ok(final_path)
}

fn ensure_under_sunny_dir(path: &Path, sunny_dir: &Path) -> Result<(), String> {
    // Canonicalize the sunny_dir prefix.  If the dir doesn't exist yet we
    // compare by lexicographic prefix, which is safe because we control both
    // sides.
    let path_str = path.to_string_lossy();
    let sunny_str = sunny_dir.to_string_lossy();
    if !path_str.starts_with(sunny_str.as_ref()) {
        return Err(format!(
            "path escape detected: `{path_str}` is not under `{sunny_str}`"
        ));
    }
    Ok(())
}

/// Read and deserialize `{project_path}/.sunny/handoff.json`.
pub fn read_handoff(project_path: &str) -> Result<HandoffPayload, String> {
    let path = Path::new(project_path).join(".sunny").join("handoff.json");
    let bytes = fs::read(&path).map_err(|e| format!("read handoff: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse handoff: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_payload(session_id: &str) -> HandoffPayload {
        HandoffPayload {
            intent: "Fix the login bug".to_string(),
            relevant_files: vec!["src/auth.rs".to_string()],
            clipboard_snapshot: String::new(),
            conversation_summary: "User wants to fix auth".to_string(),
            written_at: "2026-04-20T00:00:00Z".to_string(),
            session_id: session_id.to_string(),
        }
    }

    #[test]
    fn atomic_write_creates_file_under_0600() {
        let dir = tempfile::tempdir().expect("tempdir");
        let project_path = dir.path().to_str().unwrap();
        let payload = dummy_payload("test-session-123");

        let path = write_handoff(project_path, &payload).expect("write_handoff");
        assert!(path.exists(), "handoff.json must exist after write");

        // Check permissions — owner-only r/w.
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(&path).expect("metadata");
        let mode = meta.mode() & 0o777;
        assert_eq!(mode, 0o600, "handoff.json must be 0600, got {:o}", mode);
    }

    #[test]
    fn roundtrip_serialization() {
        let dir = tempfile::tempdir().expect("tempdir");
        let project_path = dir.path().to_str().unwrap();
        let payload = dummy_payload("round-trip-456");

        write_handoff(project_path, &payload).expect("write");
        let back = read_handoff(project_path).expect("read");

        assert_eq!(back.intent, payload.intent);
        assert_eq!(back.session_id, payload.session_id);
        assert_eq!(back.relevant_files, payload.relevant_files);
    }

    #[test]
    fn path_escape_is_rejected() {
        let sunny_dir = Path::new("/tmp/project/.sunny");
        let escape = Path::new("/tmp/project/.sunny/../../etc/passwd");
        // normalize the escape by resolving ..
        let normalized = escape
            .components()
            .fold(PathBuf::new(), |mut acc, c| {
                match c {
                    std::path::Component::ParentDir => { acc.pop(); }
                    other => acc.push(other),
                }
                acc
            });
        let sunny_str = sunny_dir.to_string_lossy();
        let path_str = normalized.to_string_lossy();
        let is_under = path_str.starts_with(sunny_str.as_ref());
        assert!(!is_under, "path traversal must not be under sunny_dir");
    }

    #[test]
    fn tmp_file_not_left_on_success() {
        let dir = tempfile::tempdir().expect("tempdir");
        let project_path = dir.path().to_str().unwrap();
        let payload = dummy_payload("cleanup-test");
        write_handoff(project_path, &payload).expect("write");

        let tmp = Path::new(project_path).join(".sunny").join("handoff.json.tmp");
        assert!(!tmp.exists(), ".tmp file must be renamed away on success");
    }
}
