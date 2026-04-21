//! Launch orchestrator — receives a `LaunchRequest`, validates safety gates,
//! writes the handoff file, and delegates to the appropriate bridge.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::bridges::{DevTool, BridgeDispatch};
use super::grants::check_project_path;
use super::handoff::{write_handoff, HandoffPayload};

/// Uniquely identifies a running dev-tool session.
pub type SessionId = String;

/// Input from the LLM / user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchRequest {
    /// Which dev tool to launch.
    pub tool: DevTool,
    /// Absolute path to the project the tool should open.
    pub project_path: String,
    /// Short description of what the tool should accomplish.
    pub intent: String,
    /// Optional list of relative file paths to highlight.
    #[serde(default)]
    pub relevant_files: Vec<String>,
    /// Optional clipboard content to include in the handoff.
    #[serde(default)]
    pub clipboard_snapshot: String,
    /// Optional conversation summary for context.
    #[serde(default)]
    pub conversation_summary: String,
}

/// Launch a dev tool, writing the handoff and delegating to the bridge.
/// Returns the new session id.
pub async fn launch(req: LaunchRequest) -> Result<SessionId, String> {
    // --- Safety gate 1: project path must be in grants ---
    check_project_path(&req.project_path)?;

    // --- Safety gate 2: project path must exist ---
    if !Path::new(&req.project_path).is_dir() {
        return Err(format!(
            "project path `{}` does not exist or is not a directory",
            req.project_path
        ));
    }

    // --- Generate a unique session id ---
    let session_id = format!("{}-{}", req.tool.id(), Uuid::new_v4());

    // --- Write handoff.json ---
    let now_iso = {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        // Minimal ISO-8601 without chrono pulling in more deps.
        let s = secs % 60;
        let m = (secs / 60) % 60;
        let h = (secs / 3600) % 24;
        let d = secs / 86400;
        // Epoch days → year/month/day is non-trivial; use a simplified form.
        // For a production system, use chrono::Utc::now().to_rfc3339().
        format!("epoch+{}d {:02}:{:02}:{:02}Z", d, h, m, s)
    };

    let payload = HandoffPayload {
        intent: req.intent.clone(),
        relevant_files: req.relevant_files.clone(),
        clipboard_snapshot: req.clipboard_snapshot.clone(),
        conversation_summary: req.conversation_summary.clone(),
        written_at: now_iso,
        session_id: session_id.clone(),
    };

    write_handoff(&req.project_path, &payload)?;

    // --- Create bus directory ---
    let bus_dir = bus_dir_for(&session_id);
    std::fs::create_dir_all(&bus_dir)
        .map_err(|e| format!("create bus dir: {e}"))?;

    // Write initial status.
    write_bus_status(&session_id, "launching")?;

    // --- Dispatch to bridge ---
    let result = BridgeDispatch::launch(&req.tool, &req.project_path, &session_id).await;

    match result {
        Ok(()) => {
            write_bus_status(&session_id, "running")?;
            Ok(session_id)
        }
        Err(e) => {
            write_bus_error(&session_id, &e)?;
            Err(e)
        }
    }
}

/// Returns the bus directory for a session: `~/.sunny/bus/<session_id>/`.
pub fn bus_dir_for(session_id: &str) -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".sunny")
        .join("bus")
        .join(session_id)
}

/// Write `~/.sunny/bus/<id>/status.json`.
pub fn write_bus_status(session_id: &str, status: &str) -> Result<(), String> {
    let dir = bus_dir_for(session_id);
    let path = dir.join("status.json");
    let json = serde_json::json!({ "status": status, "session_id": session_id });
    std::fs::write(&path, json.to_string())
        .map_err(|e| format!("write bus status: {e}"))
}

/// Write `~/.sunny/bus/<id>/error.txt`.
pub fn write_bus_error(session_id: &str, error: &str) -> Result<(), String> {
    let dir = bus_dir_for(session_id);
    let path = dir.join("error.txt");
    std::fs::write(&path, error)
        .map_err(|e| format!("write bus error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bus_dir_is_under_home_sunny() {
        let id = "test-session";
        let dir = bus_dir_for(id);
        let dir_str = dir.to_string_lossy();
        assert!(
            dir_str.contains(".sunny/bus/test-session"),
            "bus dir must be under ~/.sunny/bus/"
        );
    }

    #[test]
    fn session_id_uniqueness() {
        // Two sequential launches must produce different session ids.
        let id1 = format!("claude_code-{}", Uuid::new_v4());
        let id2 = format!("claude_code-{}", Uuid::new_v4());
        assert_ne!(id1, id2, "session ids must be unique");
    }
}
