//! `dev_session_launch` and `dev_session_result` — the two dispatchable tools
//! that the agent loop can call to launch dev tools and poll their results.
//!
//! Both carry `dangerous: true` so they route through `confirm.rs` before
//! any subprocess is spawned.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::bridges::DevTool;
use super::bus_watch::poll;
use super::launch::{launch, LaunchRequest};

// ---------------------------------------------------------------------------
// dev_session_launch
// ---------------------------------------------------------------------------

const LAUNCH_CAPS: &[&str] = &["app:launch"];

const LAUNCH_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tool": {
      "type": "string",
      "enum": ["claude_code","cursor","antigravity","iterm","terminal","zed","vscode"],
      "description": "Which dev tool to launch."
    },
    "project_path": {
      "type": "string",
      "description": "Absolute path to the project directory. Must be in ~/.sunny/grants.json dev_tool_paths."
    },
    "intent": {
      "type": "string",
      "description": "Short description of what the tool should accomplish."
    },
    "relevant_files": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Optional list of relative file paths to highlight."
    },
    "clipboard_snapshot": {
      "type": "string",
      "description": "Optional clipboard text to include in context."
    },
    "conversation_summary": {
      "type": "string",
      "description": "Optional compressed conversation summary."
    }
  },
  "required": ["tool", "project_path", "intent"]
}"#;

fn parse_tool(s: &str) -> Result<DevTool, String> {
    match s {
        "claude_code"  => Ok(DevTool::ClaudeCode),
        "cursor"       => Ok(DevTool::Cursor),
        "antigravity"  => Ok(DevTool::Antigravity),
        "iterm"        => Ok(DevTool::Iterm),
        "terminal"     => Ok(DevTool::Terminal),
        "zed"          => Ok(DevTool::Zed),
        "vscode"       => Ok(DevTool::Vscode),
        other => Err(format!("unknown dev tool `{other}`; valid: claude_code, cursor, antigravity, iterm, terminal, zed, vscode")),
    }
}

fn parse_string_array(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn invoke_launch<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tool_str = string_arg(&input, "tool")?;
        let tool = parse_tool(&tool_str)?;
        let project_path = string_arg(&input, "project_path")?;
        let intent = string_arg(&input, "intent")?;
        let relevant_files = parse_string_array(&input, "relevant_files");
        let clipboard_snapshot =
            optional_string_arg(&input, "clipboard_snapshot").unwrap_or_default();
        let conversation_summary =
            optional_string_arg(&input, "conversation_summary").unwrap_or_default();

        let req = LaunchRequest {
            tool,
            project_path,
            intent,
            relevant_files,
            clipboard_snapshot,
            conversation_summary,
        };

        let session_id = launch(req).await?;
        Ok(format!("{{\"session_id\":\"{session_id}\"}}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "dev_session_launch",
        description: "Launch a dev tool (Claude Code, Cursor, Antigravity, iTerm, Terminal, Zed, VS Code) with project context. Writes a handoff.json into {project_path}/.sunny/ and returns a session_id for polling. project_path must be in ~/.sunny/grants.json dev_tool_paths.",
        input_schema: LAUNCH_SCHEMA,
        required_capabilities: LAUNCH_CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke: invoke_launch,
    }
}

// ---------------------------------------------------------------------------
// dev_session_result
// ---------------------------------------------------------------------------

const RESULT_CAPS: &[&str] = &["app:launch"];

const RESULT_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Session id returned by dev_session_launch."
    }
  },
  "required": ["session_id"]
}"#;

fn invoke_result<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let session_id = string_arg(&input, "session_id")?;
        let status = poll(&session_id)?;
        serde_json::to_string(&status).map_err(|e| format!("serialize status: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "dev_session_result",
        description: "Poll the status of a dev tool session launched by dev_session_launch. Returns status (launching/running/done/error), result JSON (if done), error text (if error), and the last 4 KB of output.",
        input_schema: RESULT_SCHEMA,
        required_capabilities: RESULT_CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: true,
        invoke: invoke_result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tool_roundtrips_all_variants() {
        let variants = [
            ("claude_code", DevTool::ClaudeCode),
            ("cursor", DevTool::Cursor),
            ("antigravity", DevTool::Antigravity),
            ("iterm", DevTool::Iterm),
            ("terminal", DevTool::Terminal),
            ("zed", DevTool::Zed),
            ("vscode", DevTool::Vscode),
        ];
        for (s, expected) in &variants {
            let got = parse_tool(s).expect(s);
            assert_eq!(got, *expected, "parse_tool(\"{s}\") mismatch");
        }
    }

    #[test]
    fn parse_tool_unknown_returns_err() {
        let result = parse_tool("notepad");
        assert!(result.is_err(), "unknown tool must return Err");
        let msg = result.unwrap_err();
        assert!(msg.contains("notepad"), "error must name the bad value");
    }

    #[test]
    fn parse_string_array_empty_when_missing() {
        let v = serde_json::json!({"tool": "vscode"});
        let files = parse_string_array(&v, "relevant_files");
        assert!(files.is_empty(), "missing key must produce empty vec");
    }

    #[test]
    fn parse_string_array_extracts_values() {
        let v = serde_json::json!({"relevant_files": ["a.rs", "b.rs"]});
        let files = parse_string_array(&v, "relevant_files");
        assert_eq!(files, vec!["a.rs", "b.rs"]);
    }
}
