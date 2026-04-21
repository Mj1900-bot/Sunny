//! `file_tag_list` — L0, reads Finder tags from a file.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["spotlight.search"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "File or folder path." }
  },
  "required": ["path"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let raw = string_arg(&input, "path")?;
        let resolved = super::path_guard::resolve(&raw)?;
        let path_str = resolved.to_string_lossy().to_string();

        let tags = super::tags::get_tags(&path_str).await?;
        serde_json::to_string(&tags)
            .map_err(|e| format!("file_tag_list encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_tag_list",
        description: "List the Finder colored tags on a file or folder. Returns a JSON array of tag name strings.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
