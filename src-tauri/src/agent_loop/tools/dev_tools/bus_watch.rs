//! Bus directory poller — reads `~/.sunny/bus/<session_id>/` for tool results.
//!
//! Protocol:
//!   status.json   — `{"status": "launching"|"running"|"done"|"error", "session_id": "…"}`
//!   result.json   — tool-specific result payload (written by the tool itself)
//!   error.txt     — plain-text error message (written by launch.rs on failure)
//!   output.txt    — accumulated stdout/stderr (optional, written by CLI bridges)

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::launch::bus_dir_for;

/// Status of a dev-tool session as seen from the bus directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionStatus {
    pub session_id: String,
    pub status: SessionState,
    /// Tool result JSON, if the tool wrote `result.json`.
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    /// Error text, if status is `Error`.
    #[serde(default)]
    pub error: Option<String>,
    /// Last N bytes of `output.txt` (CLI tools only).
    #[serde(default)]
    pub output_tail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Launching,
    Running,
    Done,
    Error,
    Unknown,
}

impl std::fmt::Display for SessionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Launching => "launching",
            Self::Running   => "running",
            Self::Done      => "done",
            Self::Error     => "error",
            Self::Unknown   => "unknown",
        };
        write!(f, "{s}")
    }
}

/// Poll the bus directory for the given session and return the current status.
pub fn poll(session_id: &str) -> Result<SessionStatus, String> {
    let dir = bus_dir_for(session_id);

    if !dir.exists() {
        return Err(format!("no bus directory for session `{session_id}`"));
    }

    let state = read_status(&dir)?;
    let result = read_result_json(&dir);
    let error = read_error_txt(&dir);
    let output_tail = read_output_tail(&dir, 4096);

    Ok(SessionStatus {
        session_id: session_id.to_string(),
        status: state,
        result,
        error,
        output_tail,
    })
}

/// Remove the bus directory — called by `stop()`.
pub fn cleanup(session_id: &str) -> Result<(), String> {
    let dir = bus_dir_for(session_id);
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("cleanup bus dir for `{session_id}`: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal readers
// ---------------------------------------------------------------------------

fn read_status(dir: &Path) -> Result<SessionState, String> {
    let path = dir.join("status.json");
    if !path.exists() {
        return Ok(SessionState::Unknown);
    }
    let bytes = fs::read(&path).map_err(|e| format!("read status.json: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse status.json: {e}"))?;
    let state_str = v
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("unknown");
    Ok(match state_str {
        "launching" => SessionState::Launching,
        "running"   => SessionState::Running,
        "done"      => SessionState::Done,
        "error"     => SessionState::Error,
        _           => SessionState::Unknown,
    })
}

fn read_result_json(dir: &Path) -> Option<serde_json::Value> {
    let path = dir.join("result.json");
    let bytes = fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn read_error_txt(dir: &Path) -> Option<String> {
    let path = dir.join("error.txt");
    fs::read_to_string(&path).ok().filter(|s| !s.is_empty())
}

fn read_output_tail(dir: &Path, max_bytes: usize) -> Option<String> {
    let path = dir.join("output.txt");
    let content = fs::read(&path).ok()?;
    if content.is_empty() {
        return None;
    }
    let start = content.len().saturating_sub(max_bytes);
    Some(String::from_utf8_lossy(&content[start..]).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn make_bus_dir(session_id: &str) -> PathBuf {
        let dir = bus_dir_for(session_id);
        fs::create_dir_all(&dir).expect("create bus dir");
        dir
    }

    #[test]
    fn poll_missing_dir_returns_err() {
        let id = "nonexistent-session-xyz-abc";
        let result = poll(id);
        assert!(result.is_err(), "missing bus dir must return Err");
        let msg = result.unwrap_err();
        assert!(msg.contains("no bus directory"), "error msg: {msg}");
    }

    #[test]
    fn poll_reads_status_done_and_result() {
        let id = format!("test-poll-{}", uuid::Uuid::new_v4());
        let dir = make_bus_dir(&id);

        // Write status.json
        let status = serde_json::json!({"status": "done", "session_id": &id});
        fs::write(dir.join("status.json"), status.to_string()).unwrap();

        // Write result.json
        let result = serde_json::json!({"summary": "fixed the bug"});
        fs::write(dir.join("result.json"), result.to_string()).unwrap();

        let ss = poll(&id).expect("poll must succeed");
        assert_eq!(ss.status, SessionState::Done);
        assert!(ss.result.is_some());
        assert_eq!(ss.result.unwrap()["summary"], "fixed the bug");

        // Cleanup
        cleanup(&id).unwrap();
    }

    #[test]
    fn poll_reads_error_txt_on_error_status() {
        let id = format!("test-error-{}", uuid::Uuid::new_v4());
        let dir = make_bus_dir(&id);

        fs::write(
            dir.join("status.json"),
            r#"{"status":"error","session_id":"x"}"#,
        ).unwrap();
        fs::write(dir.join("error.txt"), "launch failed: binary not found").unwrap();

        let ss = poll(&id).expect("poll must succeed");
        assert_eq!(ss.status, SessionState::Error);
        assert_eq!(ss.error.as_deref(), Some("launch failed: binary not found"));

        cleanup(&id).unwrap();
    }

    #[test]
    fn cleanup_removes_bus_dir() {
        let id = format!("test-cleanup-{}", uuid::Uuid::new_v4());
        make_bus_dir(&id);
        assert!(bus_dir_for(&id).exists());
        cleanup(&id).expect("cleanup must succeed");
        assert!(!bus_dir_for(&id).exists(), "dir must be gone after cleanup");
    }

    #[test]
    fn output_tail_trims_to_max_bytes() {
        let id = format!("test-tail-{}", uuid::Uuid::new_v4());
        let dir = make_bus_dir(&id);

        let content = "A".repeat(8192);
        fs::write(dir.join("output.txt"), &content).unwrap();

        let tail = read_output_tail(&dir, 4096).expect("tail must be Some");
        assert_eq!(tail.len(), 4096, "tail must be exactly max_bytes");
        assert!(tail.chars().all(|c| c == 'A'), "tail must be the tail of the content");

        cleanup(&id).unwrap();
    }
}
