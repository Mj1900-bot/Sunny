//! iTerm2 bridge — opens a new iTerm window at the project directory via
//! AppleScript.
//!
//! Launch mechanism: AppleScript via `osascript` (reuses the pattern from
//! `tools_macos.rs`). Opens a new window, cds to project_path, then runs
//! `cat .sunny/handoff.json` so the developer can see the context immediately.

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::agent_loop::tools::dev_tools::discover::{discover_iterm, CapabilityReport};
use crate::agent_loop::tools::dev_tools::launch::{bus_dir_for, write_bus_status};

const OSA_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn discover() -> Result<CapabilityReport, String> {
    discover_iterm()
}

pub fn build_applescript(project_path: &str) -> String {
    // Escape single quotes in the path for AppleScript string safety.
    let safe_path = project_path.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
        write text "cd \"{safe_path}\" && cat .sunny/handoff.json"
    end tell
end tell"#
    )
}

pub async fn launch(project_path: &str, session_id: &str) -> Result<(), String> {
    let script = build_applescript(project_path);

    let result = timeout(OSA_TIMEOUT, async {
        let mut child = Command::new("osascript")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn osascript: {e}"))?;

        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(script.as_bytes())
                .await
                .map_err(|e| format!("write osascript: {e}"))?;
        }

        child.wait_with_output().await.map_err(|e| format!("osascript wait: {e}"))
    })
    .await
    .map_err(|_| "iTerm2 AppleScript timed out".to_string())??;

    if result.status.success() {
        write_bus_status(session_id, "running")?;
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr).to_string();
        let err = format!("iTerm2 AppleScript failed: {stderr}");
        std::fs::write(bus_dir_for(session_id).join("error.txt"), &err)
            .map_err(|e| format!("write error: {e}"))?;
        write_bus_status(session_id, "error")?;
        Err(err)
    }
}

pub async fn stop(session_id: &str) -> Result<(), String> {
    write_bus_status(session_id, "done")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_contains_project_path() {
        let script = build_applescript("/Users/sunny/Projects/myapp");
        assert!(
            script.contains("/Users/sunny/Projects/myapp"),
            "script must embed project path"
        );
        assert!(script.contains("iTerm2"), "script must target iTerm2");
        assert!(
            script.contains("handoff.json"),
            "script must cat handoff.json for context"
        );
    }

    #[test]
    fn applescript_escapes_double_quotes() {
        let script = build_applescript("/Users/sunny/My \"Project\"/app");
        // The path must not produce unescaped quotes that break AppleScript.
        assert!(
            !script.contains("\"My \"Project\""),
            "raw unescaped quotes must not appear"
        );
    }
}
