//! `photos_search` — keyword search in Photos.app.
//! L1 (reads private photos library).

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.photos"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "query": {"type": "string", "description": "Keyword or text to search for in Photos."}
  },
  "required": ["query"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query = string_arg(&input, "query")?;
        super::core::photos_search(&query).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "photos_search",
        description: "Search Photos.app by keyword or text. Returns matching photo ids, dates, and dimensions.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
