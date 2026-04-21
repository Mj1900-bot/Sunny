//! `file_open_default` — L2, opens a file with its default application.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.open"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path to open with its default handler." }
  },
  "required": ["path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw = string_arg(&input, "path")?;
        let resolved = super::path_guard::resolve(&raw)?;
        let path_str = resolved.to_string_lossy().to_string();

        let status = tokio::process::Command::new("open")
            .arg(&path_str)
            .status()
            .await
            .map_err(|e| format!("open failed: {e}"))?;

        if status.success() {
            Ok(format!("Opened `{path_str}` with default application."))
        } else {
            Err(format!("open exited non-zero for `{path_str}`"))
        }
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_open_default",
        description: "Open a file or folder with its default macOS application (`open <path>`).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
