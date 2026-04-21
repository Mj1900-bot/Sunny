//! `file_reveal_in_finder` — L2, runs `open -R <path>` to reveal in Finder.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.reveal"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Absolute or ~-relative path to reveal." }
  },
  "required": ["path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw = string_arg(&input, "path")?;
        let resolved = super::path_guard::resolve(&raw)?;
        let path_str = resolved.to_string_lossy().to_string();

        let status = tokio::process::Command::new("open")
            .args(["-R", &path_str])
            .status()
            .await
            .map_err(|e| format!("open -R failed: {e}"))?;

        if status.success() {
            Ok(format!("Revealed `{path_str}` in Finder."))
        } else {
            Err(format!("open -R exited non-zero for `{path_str}`"))
        }
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_reveal_in_finder",
        description: "Reveal a file or folder in Finder (open -R). The item is selected in its parent Finder window.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
