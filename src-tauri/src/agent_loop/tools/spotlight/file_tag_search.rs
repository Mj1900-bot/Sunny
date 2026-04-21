//! `file_tag_search` — L0, finds files/folders with a given Finder tag.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["spotlight.search"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "tag":   { "type": "string",  "description": "Finder tag name to search for." },
    "limit": { "type": "integer", "description": "Max results (default 20, max 200)." }
  },
  "required": ["tag"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let tag = string_arg(&input, "tag")?;
        let limit = usize_arg(&input, "limit").unwrap_or(20).min(200);

        let entries = super::mdfind::run_tag_search(&tag, limit).await?;
        serde_json::to_string(&entries)
            .map_err(|e| format!("file_tag_search encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "file_tag_search",
        description: "Find all files and folders that have a specific Finder tag. Uses `mdfind kMDItemUserTags`.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
