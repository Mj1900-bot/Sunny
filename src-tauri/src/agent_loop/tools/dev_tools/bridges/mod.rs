//! Bridge implementations — one per dev tool.
//!
//! Each bridge exposes three async fns matching the dev-tool contract:
//!
//!   * `discover() -> Result<CapabilityReport>` — probes whether the tool
//!     is installed.
//!   * `launch(project_path, session_id) -> Result<()>` — spawns the tool.
//!   * `stop(session_id) -> Result<()>` — stops the tool / cleans up.
//!
//! The `DevTool` enum is the discriminant used by `BridgeDispatch` to route
//! to the correct bridge without a big dispatch.rs match.

pub mod antigravity;
pub mod claude_code;
pub mod cursor;
pub mod iterm;
pub mod terminal;
pub mod vscode;
pub mod zed;

use serde::{Deserialize, Serialize};

use crate::agent_loop::tools::dev_tools::discover::CapabilityReport;

/// All supported dev tools.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevTool {
    ClaudeCode,
    Cursor,
    Antigravity,
    Iterm,
    Terminal,
    Zed,
    Vscode,
}

impl DevTool {
    /// Short identifier used as the prefix in session ids.
    pub fn id(&self) -> &'static str {
        match self {
            Self::ClaudeCode  => "claude_code",
            Self::Cursor      => "cursor",
            Self::Antigravity => "antigravity",
            Self::Iterm       => "iterm",
            Self::Terminal    => "terminal",
            Self::Zed         => "zed",
            Self::Vscode      => "vscode",
        }
    }
}

/// Zero-size dispatcher — routes to the correct bridge at compile time.
pub struct BridgeDispatch;

impl BridgeDispatch {
    /// Probe the tool.
    pub async fn discover(tool: &DevTool) -> Result<CapabilityReport, String> {
        match tool {
            DevTool::ClaudeCode  => claude_code::discover().await,
            DevTool::Cursor      => cursor::discover().await,
            DevTool::Antigravity => antigravity::discover().await,
            DevTool::Iterm       => iterm::discover().await,
            DevTool::Terminal    => terminal::discover().await,
            DevTool::Zed         => zed::discover().await,
            DevTool::Vscode      => vscode::discover().await,
        }
    }

    /// Spawn the tool pointing at `project_path`.
    pub async fn launch(
        tool: &DevTool,
        project_path: &str,
        session_id: &str,
    ) -> Result<(), String> {
        match tool {
            DevTool::ClaudeCode  => claude_code::launch(project_path, session_id).await,
            DevTool::Cursor      => cursor::launch(project_path, session_id).await,
            DevTool::Antigravity => antigravity::launch(project_path, session_id).await,
            DevTool::Iterm       => iterm::launch(project_path, session_id).await,
            DevTool::Terminal    => terminal::launch(project_path, session_id).await,
            DevTool::Zed         => zed::launch(project_path, session_id).await,
            DevTool::Vscode      => vscode::launch(project_path, session_id).await,
        }
    }

    /// Stop / clean up a session.
    pub async fn stop(tool: &DevTool, session_id: &str) -> Result<(), String> {
        match tool {
            DevTool::ClaudeCode  => claude_code::stop(session_id).await,
            DevTool::Cursor      => cursor::stop(session_id).await,
            DevTool::Antigravity => antigravity::stop(session_id).await,
            DevTool::Iterm       => iterm::stop(session_id).await,
            DevTool::Terminal    => terminal::stop(session_id).await,
            DevTool::Zed         => zed::stop(session_id).await,
            DevTool::Vscode      => vscode::stop(session_id).await,
        }
    }
}
