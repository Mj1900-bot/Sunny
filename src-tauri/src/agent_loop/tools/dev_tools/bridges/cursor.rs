//! Cursor bridge — opens a project directory in Cursor IDE.
//!
//! Launch mechanism: `open -a Cursor <project_path>`
//! (Cursor also ships a `cursor` CLI on PATH when the shell integration is
//! enabled, but the `open -a` path is more reliable for a GUI launch.)

use tokio::process::Command;

use crate::agent_loop::tools::dev_tools::discover::{discover_cursor, CapabilityReport};
use crate::agent_loop::tools::dev_tools::launch::{bus_dir_for, write_bus_status};

pub async fn discover() -> Result<CapabilityReport, String> {
    discover_cursor()
}

pub fn build_launch_cmd(project_path: &str) -> Vec<String> {
    vec![
        "open".to_string(),
        "-a".to_string(),
        "Cursor".to_string(),
        project_path.to_string(),
    ]
}

pub async fn launch(project_path: &str, session_id: &str) -> Result<(), String> {
    let cmd = build_launch_cmd(project_path);

    let status = Command::new(&cmd[0])
        .args(&cmd[1..])
        .status()
        .await
        .map_err(|e| format!("cursor launch failed: {e}"))?;

    if status.success() {
        write_bus_status(session_id, "running")?;
        // GUI tool — results must be written by the tool itself or via an
        // external watcher.  We leave status as "running" indefinitely until
        // the tool writes result.json or the user calls stop().
        Ok(())
    } else {
        let err = format!("open -a Cursor exited with {status}");
        std::fs::write(bus_dir_for(session_id).join("error.txt"), &err)
            .map_err(|e| format!("write error: {e}"))?;
        write_bus_status(session_id, "error")?;
        Err(err)
    }
}

pub async fn stop(session_id: &str) -> Result<(), String> {
    // GUI tool — we can't programmatically quit the session; just mark done.
    write_bus_status(session_id, "done")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_cmd_opens_cursor_with_project_path() {
        let cmd = build_launch_cmd("/Users/sunny/Projects/myapp");
        assert_eq!(cmd[0], "open");
        assert_eq!(cmd[1], "-a");
        assert_eq!(cmd[2], "Cursor");
        assert_eq!(cmd[3], "/Users/sunny/Projects/myapp");
    }
}
