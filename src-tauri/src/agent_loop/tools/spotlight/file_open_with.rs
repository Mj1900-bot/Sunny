//! `file_open_with` — L2, opens a file with a specific application.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["finder.open"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path":     { "type": "string", "description": "Path to open." },
    "app_name": { "type": "string", "description": "Application name, e.g. \"Preview\", \"Xcode\"." }
  },
  "required": ["path", "app_name"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw = string_arg(&input, "path")?;
        let app_name = string_arg(&input, "app_name")?;

        // Reject app_name shell-metacharacter injection.
        if app_name.contains('/') || app_name.contains('\0') || app_name.contains('"') {
            return Err(format!(
                "app_name `{app_name}` contains disallowed characters (/, null, \")"
            ));
        }

        let resolved = super::path_guard::resolve(&raw)?;
        let path_str = resolved.to_string_lossy().to_string();

        let status = tokio::process::Command::new("open")
            .args(["-a", &app_name, &path_str])
            .status()
            .await
            .map_err(|e| format!("open -a failed: {e}"))?;

        if status.success() {
            Ok(format!("Opened `{path_str}` with `{app_name}`."))
        } else {
            Err(format!(
                "open -a `{app_name}` exited non-zero for `{path_str}`"
            ))
        }
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_open_with",
        description: "Open a file with a specific macOS application (`open -a <AppName> <path>`).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke,
    }
}
