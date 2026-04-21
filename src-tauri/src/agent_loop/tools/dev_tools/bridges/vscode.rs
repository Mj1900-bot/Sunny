//! VS Code bridge — opens the project directory in VS Code.
//!
//! Launch mechanism: `code <project_path>` if the CLI is on PATH,
//! otherwise `open -a "Visual Studio Code" <project_path>`.

use tokio::process::Command;

use crate::agent_loop::tools::dev_tools::discover::{discover_vscode, CapabilityReport};
use crate::agent_loop::tools::dev_tools::launch::{bus_dir_for, write_bus_status};

pub async fn discover() -> Result<CapabilityReport, String> {
    discover_vscode()
}

pub fn build_launch_cmd(project_path: &str, use_cli: bool) -> Vec<String> {
    if use_cli {
        vec!["code".to_string(), project_path.to_string()]
    } else {
        vec![
            "open".to_string(),
            "-a".to_string(),
            "Visual Studio Code".to_string(),
            project_path.to_string(),
        ]
    }
}

fn code_cli_available() -> bool {
    std::process::Command::new("which")
        .arg("code")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub async fn launch(project_path: &str, session_id: &str) -> Result<(), String> {
    let use_cli = code_cli_available();
    let cmd = build_launch_cmd(project_path, use_cli);

    let status = Command::new(&cmd[0])
        .args(&cmd[1..])
        .status()
        .await
        .map_err(|e| format!("vscode launch failed: {e}"))?;

    if status.success() {
        write_bus_status(session_id, "running")?;
        Ok(())
    } else {
        let err = format!("vscode launch exited with {status}");
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
    fn cli_cmd_uses_code_binary() {
        let cmd = build_launch_cmd("/Users/sunny/Projects/myapp", true);
        assert_eq!(cmd[0], "code");
        assert_eq!(cmd[1], "/Users/sunny/Projects/myapp");
    }

    #[test]
    fn fallback_cmd_uses_open_a_vscode() {
        let cmd = build_launch_cmd("/Users/sunny/Projects/myapp", false);
        assert_eq!(cmd[0], "open");
        assert_eq!(cmd[1], "-a");
        assert_eq!(cmd[2], "Visual Studio Code");
        assert_eq!(cmd[3], "/Users/sunny/Projects/myapp");
    }
}
