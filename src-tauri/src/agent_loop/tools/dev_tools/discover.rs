//! Tool discovery — probe whether each dev tool is installed, what version
//! it is, and what capabilities it exposes.

use std::process::Command;

use serde::{Deserialize, Serialize};

/// The result of probing a dev tool.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityReport {
    /// Human-readable tool identifier (e.g. `"claude_code"`).
    pub tool: String,
    /// Whether the tool binary / application bundle was found.
    pub installed: bool,
    /// Version string if we could detect it (may be empty).
    pub version: String,
    /// Detected capabilities (e.g. `["cli", "pty"]` or `["gui", "url_scheme"]`).
    pub capabilities: Vec<String>,
    /// Human-readable note (e.g. path, or reason for absence).
    pub note: String,
}

impl CapabilityReport {
    fn absent(tool: &str, note: &str) -> Self {
        Self {
            tool: tool.to_string(),
            installed: false,
            version: String::new(),
            capabilities: vec![],
            note: note.to_string(),
        }
    }

    fn present(tool: &str, version: &str, caps: &[&str], note: &str) -> Self {
        Self {
            tool: tool.to_string(),
            installed: true,
            version: version.to_string(),
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            note: note.to_string(),
        }
    }
}

/// Probe if `binary` is on PATH; return its output for `--version` if found.
fn probe_binary(binary: &str) -> Option<String> {
    let which = Command::new("which")
        .arg(binary)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())?;

    if which.is_empty() {
        return None;
    }

    let ver_out = Command::new(binary)
        .arg("--version")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    Some(ver_out)
}

/// Probe if a macOS `.app` bundle exists at the given path.
fn probe_app_bundle(app_name: &str) -> Option<String> {
    let paths = [
        format!("/Applications/{app_name}.app"),
        format!("/Applications/{app_name}/{app_name}.app"),
        format!(
            "{}/Applications/{app_name}.app",
            dirs::home_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        ),
    ];
    for p in &paths {
        if std::path::Path::new(p).exists() {
            return Some(p.clone());
        }
    }
    None
}

/// Discover Claude Code CLI (`claude` binary).
pub fn discover_claude_code() -> Result<CapabilityReport, String> {
    match probe_binary("claude") {
        None => Ok(CapabilityReport::absent(
            "claude_code",
            "claude binary not found on PATH — install via `npm i -g @anthropic-ai/claude-code`",
        )),
        Some(ver) => Ok(CapabilityReport::present(
            "claude_code",
            &ver,
            &["cli", "pty", "non_interactive"],
            "claude binary on PATH",
        )),
    }
}

/// Discover Cursor IDE.
pub fn discover_cursor() -> Result<CapabilityReport, String> {
    match probe_app_bundle("Cursor") {
        None => Ok(CapabilityReport::absent(
            "cursor",
            "Cursor.app not found in /Applications or ~/Applications",
        )),
        Some(path) => Ok(CapabilityReport::present(
            "cursor",
            "",
            &["gui", "open_cmd", "project_dir"],
            &path,
        )),
    }
}

/// Discover Antigravity (URL-scheme based).
pub fn discover_antigravity() -> Result<CapabilityReport, String> {
    match probe_app_bundle("Antigravity") {
        None => Ok(CapabilityReport::absent(
            "antigravity",
            "Antigravity.app not found",
        )),
        Some(path) => Ok(CapabilityReport::present(
            "antigravity",
            "",
            &["gui", "url_scheme"],
            &path,
        )),
    }
}

/// Discover iTerm2.
pub fn discover_iterm() -> Result<CapabilityReport, String> {
    match probe_app_bundle("iTerm") {
        None => Ok(CapabilityReport::absent("iterm", "iTerm.app not found")),
        Some(path) => Ok(CapabilityReport::present(
            "iterm",
            "",
            &["gui", "applescript"],
            &path,
        )),
    }
}

/// Discover macOS Terminal.app (always present on macOS).
pub fn discover_terminal() -> Result<CapabilityReport, String> {
    let path = "/System/Applications/Utilities/Terminal.app";
    if std::path::Path::new(path).exists() {
        Ok(CapabilityReport::present(
            "terminal",
            "",
            &["gui", "applescript"],
            path,
        ))
    } else {
        Ok(CapabilityReport::absent(
            "terminal",
            "Terminal.app not found (unexpected on macOS)",
        ))
    }
}

/// Discover Zed editor.
pub fn discover_zed() -> Result<CapabilityReport, String> {
    match probe_binary("zed") {
        Some(ver) => Ok(CapabilityReport::present(
            "zed",
            &ver,
            &["cli", "gui", "open_cmd"],
            "zed CLI on PATH",
        )),
        None => match probe_app_bundle("Zed") {
            None => Ok(CapabilityReport::absent(
                "zed",
                "Zed.app not found and `zed` not on PATH",
            )),
            Some(path) => Ok(CapabilityReport::present(
                "zed",
                "",
                &["gui", "open_cmd"],
                &path,
            )),
        },
    }
}

/// Discover VS Code.
pub fn discover_vscode() -> Result<CapabilityReport, String> {
    match probe_binary("code") {
        Some(ver) => Ok(CapabilityReport::present(
            "vscode",
            &ver,
            &["cli", "gui", "open_cmd"],
            "code CLI on PATH",
        )),
        None => match probe_app_bundle("Visual Studio Code") {
            None => Ok(CapabilityReport::absent(
                "vscode",
                "VS Code not found — install from https://code.visualstudio.com",
            )),
            Some(path) => Ok(CapabilityReport::present(
                "vscode",
                "",
                &["gui", "open_cmd"],
                &path,
            )),
        },
    }
}

/// Discover all dev tools in one call.
pub fn discover_all() -> Vec<Result<CapabilityReport, String>> {
    vec![
        discover_claude_code(),
        discover_cursor(),
        discover_antigravity(),
        discover_iterm(),
        discover_terminal(),
        discover_zed(),
        discover_vscode(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_binary_returns_not_installed() {
        // `__definitely_not_a_real_binary__` won't be on any PATH.
        let result = probe_binary("__definitely_not_a_real_binary__");
        assert!(result.is_none(), "missing binary must return None");
    }

    #[test]
    fn absent_report_has_correct_fields() {
        let r = CapabilityReport::absent("test_tool", "not found");
        assert!(!r.installed);
        assert!(r.capabilities.is_empty());
        assert_eq!(r.tool, "test_tool");
        assert_eq!(r.note, "not found");
    }

    #[test]
    fn present_report_has_correct_fields() {
        let r = CapabilityReport::present("test_tool", "1.2.3", &["cli", "pty"], "/usr/bin/test");
        assert!(r.installed);
        assert_eq!(r.version, "1.2.3");
        assert_eq!(r.capabilities, vec!["cli", "pty"]);
    }

    #[test]
    fn terminal_app_discovered_on_macos() {
        // Terminal.app is always present on macOS; if we're running CI on
        // macOS this should pass. On Linux it gracefully returns absent.
        let r = discover_terminal().expect("discover_terminal must not return Err");
        // On macOS the path exists; on Linux it won't.
        if cfg!(target_os = "macos") {
            assert!(r.installed, "Terminal.app must be present on macOS");
        }
    }
}
