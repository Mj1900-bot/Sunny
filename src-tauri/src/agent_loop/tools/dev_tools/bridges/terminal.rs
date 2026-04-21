//! macOS Terminal.app bridge — opens a new Terminal window at the project
//! directory via AppleScript.
//!
//! Launch mechanism: AppleScript via `osascript`. Opens a new window and
//! immediately cds to `project_path` and cats `handoff.json`.

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::agent_loop::tools::dev_tools::discover::{discover_terminal, CapabilityReport};
use crate::agent_loop::tools::dev_tools::launch::{bus_dir_for, write_bus_status};

const OSA_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn discover() -> Result<CapabilityReport, String> {
    discover_terminal()
}

pub fn build_applescript(project_path: &str) -> String {
    let safe_path = project_path.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"tell application "Terminal"
    activate
    do script "cd \"{safe_path}\" && cat .sunny/handoff.json"
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
    .map_err(|_| "Terminal AppleScript timed out".to_string())??;

    if result.status.success() {
        write_bus_status(session_id, "running")?;
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr).to_string();
        let err = format!("Terminal AppleScript failed: {stderr}");
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
    fn applescript_targets_terminal() {
        let script = build_applescript("/Users/sunny/Projects/myapp");
        assert!(script.contains("Terminal"), "must target Terminal.app");
        assert!(
            script.contains("do script"),
            "must use 'do script' to open a new window"
        );
        assert!(script.contains("handoff.json"));
    }
}
