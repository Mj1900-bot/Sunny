//! Claude Code bridge — launches `claude` CLI non-interactively.
//!
//! Launch mechanism (claude v2.1.114+):
//!
//!   claude \
//!     --print <intent> \
//!     --output-format json \
//!     --append-system-prompt <handoff_json_content>
//!
//! CWD is set to `project_path` via `Command::current_dir`.
//! `--context` does not exist in claude v2.1.114 and must not be used.
//!
//! Output is captured into `~/.sunny/bus/<session_id>/output.txt`.
//! On success, stdout (or a JSON-wrapped form) is written to `result.json`
//! and `status.json` flips to "done".

use tokio::process::Command;

use crate::agent_loop::tools::dev_tools::discover::{discover_claude_code, CapabilityReport};
use crate::agent_loop::tools::dev_tools::handoff::read_handoff;
use crate::agent_loop::tools::dev_tools::launch::{bus_dir_for, write_bus_status};

pub async fn discover() -> Result<CapabilityReport, String> {
    discover_claude_code()
}

/// Spawn `claude` non-interactively.
///
/// Reads `{project_path}/.sunny/handoff.json` (written by the launch
/// orchestrator just before this call) to obtain the `intent` and full
/// context blob, then builds the command with the correct flags for
/// claude v2.1.114.
pub async fn launch(project_path: &str, session_id: &str) -> Result<(), String> {
    // Read the handoff written by launch.rs — it must already exist.
    let payload = read_handoff(project_path)
        .map_err(|e| format!("read handoff before spawning claude: {e}"))?;

    // Serialize the full payload as the system-prompt context string.
    let handoff_content = serde_json::to_string(&payload)
        .map_err(|e| format!("re-serialize handoff for --append-system-prompt: {e}"))?;

    let cmd = build_launch_cmd(&payload.intent, &handoff_content);
    let bus_dir = bus_dir_for(session_id);
    let output_file = bus_dir.join("output.txt");
    let result_file = bus_dir.join("result.json");
    let session_id_owned = session_id.to_string();
    let project_path_owned = project_path.to_string();

    tokio::spawn(async move {
        // Hold a spawn permit for the lifetime of the Claude CLI launch.
        // Without this, a runaway caller firing `claude_code_run` in a
        // loop saturates the user's process table — this was one of the
        // fork-bomb shapes from the prior incidents because each call
        // launches a full claude CLI invocation. If the budget is spent,
        // the acquire times out and we record the failure into the bus
        // file like any other spawn error.
        let _guard = match crate::process_budget::SpawnGuard::acquire().await {
            Ok(g) => g,
            Err(e) => {
                let _ = std::fs::write(
                    bus_dir.join("error.txt"),
                    format!("spawn budget: {e}"),
                );
                let _ = write_bus_status(&session_id_owned, "error");
                return;
            }
        };
        let out = Command::new(&cmd[0])
            .args(&cmd[1..])
            .current_dir(&project_path_owned)
            .output()
            .await;

        match out {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let combined = format!("{stdout}\n{stderr}");
                let _ = std::fs::write(&output_file, &combined);

                if output.status.success() {
                    let result_val: serde_json::Value =
                        serde_json::from_str(&stdout).unwrap_or_else(|_| {
                            serde_json::json!({"output": stdout.trim()})
                        });
                    let _ = std::fs::write(
                        &result_file,
                        serde_json::to_string_pretty(&result_val).unwrap_or_default(),
                    );
                    let _ = write_bus_status(&session_id_owned, "done");
                } else {
                    let _ = std::fs::write(
                        bus_dir.join("error.txt"),
                        format!("claude exited with {}: {stderr}", output.status),
                    );
                    let _ = write_bus_status(&session_id_owned, "error");
                }
            }
            Err(e) => {
                let _ = write_bus_status(&session_id_owned, "error");
                let _ = std::fs::write(
                    bus_dir.join("error.txt"),
                    format!("spawn failed: {e}"),
                );
            }
        }
    });

    Ok(())
}

/// Build the argv vector for the Claude Code non-interactive launch.
///
/// Produces:
///   `claude --print <intent> --output-format json --append-system-prompt <handoff_content>`
///
/// - `intent`          : forwarded as the positional `--print` prompt.
/// - `handoff_content` : JSON-serialised `HandoffPayload`; injected via
///                       `--append-system-prompt` so claude receives full
///                       context without touching the filesystem at runtime.
///
/// CWD must be set by the caller via `Command::current_dir(project_path)`.
/// The project path is NOT passed as a positional argument.
///
/// Isolated so unit tests can assert the exact command without spawning.
pub fn build_launch_cmd(intent: &str, handoff_content: &str) -> Vec<String> {
    vec![
        "claude".to_string(),
        "--print".to_string(),
        intent.to_string(),
        "--output-format".to_string(),
        "json".to_string(),
        "--append-system-prompt".to_string(),
        handoff_content.to_string(),
    ]
}

pub async fn stop(session_id: &str) -> Result<(), String> {
    write_bus_status(session_id, "error")?;
    std::fs::write(
        bus_dir_for(session_id).join("error.txt"),
        "session stopped by user",
    )
    .map_err(|e| format!("write stop error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    fn sample_cmd() -> Vec<String> {
        build_launch_cmd(
            "fix the login bug in src/auth.rs",
            r#"{"intent":"fix the login bug","session_id":"test-123"}"#,
        )
    }

    // ---------------------------------------------------------------------------
    // Existing test — updated for new signature
    // ---------------------------------------------------------------------------

    #[test]
    fn launch_cmd_contains_expected_flags() {
        let cmd = sample_cmd();
        assert_eq!(cmd[0], "claude", "first token must be 'claude'");
        assert!(cmd.contains(&"--print".to_string()), "must have --print");
        assert!(
            cmd.contains(&"--output-format".to_string()),
            "must have --output-format"
        );
        assert!(cmd.contains(&"json".to_string()), "output format must be json");
        assert!(
            cmd.contains(&"--append-system-prompt".to_string()),
            "must have --append-system-prompt"
        );
    }

    // ---------------------------------------------------------------------------
    // New tests (3+) asserting correct flag layout
    // ---------------------------------------------------------------------------

    /// `--context` must never appear — it does not exist in claude v2.1.114.
    #[test]
    fn no_context_flag() {
        let cmd = sample_cmd();
        assert!(
            !cmd.contains(&"--context".to_string()),
            "--context is not a valid flag in claude v2.1.114 and must not appear"
        );
    }

    /// Intent is the token immediately after `--print`.
    #[test]
    fn intent_follows_print_flag() {
        let intent = "fix the login bug in src/auth.rs";
        let cmd = build_launch_cmd(intent, "{}");
        let print_idx = cmd
            .iter()
            .position(|s| s == "--print")
            .expect("--print must be present");
        assert_eq!(
            cmd.get(print_idx + 1).map(|s| s.as_str()),
            Some(intent),
            "intent must be the token immediately after --print"
        );
    }

    /// Handoff content is the token immediately after `--append-system-prompt`.
    #[test]
    fn handoff_content_follows_append_system_prompt() {
        let content = r#"{"intent":"do stuff","session_id":"abc"}"#;
        let cmd = build_launch_cmd("do stuff", content);
        let asp_idx = cmd
            .iter()
            .position(|s| s == "--append-system-prompt")
            .expect("--append-system-prompt must be present");
        assert_eq!(
            cmd.get(asp_idx + 1).map(|s| s.as_str()),
            Some(content),
            "handoff JSON must be the token immediately after --append-system-prompt"
        );
    }

    /// Project path must NOT appear as a positional arg — CWD is used instead.
    #[test]
    fn project_path_not_in_argv() {
        let project = "/Users/sunny/Projects/myapp";
        let cmd = build_launch_cmd("some intent", "{}");
        assert!(
            !cmd.contains(&project.to_string()),
            "project path must not be a positional arg; set it via current_dir() instead"
        );
    }

    /// Output format value is "json" and comes right after `--output-format`.
    #[test]
    fn output_format_is_json() {
        let cmd = sample_cmd();
        let of_idx = cmd
            .iter()
            .position(|s| s == "--output-format")
            .expect("--output-format must be present");
        assert_eq!(
            cmd.get(of_idx + 1).map(|s| s.as_str()),
            Some("json"),
            "output format value must be 'json'"
        );
    }
}
