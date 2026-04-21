//! `spotlight_search` — L0 read, wraps `mdfind`.
//! Supports `kind:pdf`, `kind:image`, `kind:app`, `kind:email`,
//! `kind:folder`, `date:today`, `date:yesterday`, `date:thisweek`.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["spotlight.search"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "query":  { "type": "string", "description": "Text to search for." },
    "kind":   { "type": "string", "description": "Optional filter: pdf, image, app, email, folder, today, yesterday, thisweek." },
    "limit":  { "type": "integer", "description": "Max results (default 20, max 200)." }
  },
  "required": ["query"]
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query = string_arg(&input, "query")?;
        let kind = optional_string_arg(&input, "kind");
        let limit = usize_arg(&input, "limit").unwrap_or(20).min(200);

        let predicate =
            super::mdfind::build_mdfind_query(&query, kind.as_deref());
        let entries = super::mdfind::run_mdfind(&predicate, limit).await?;
        serde_json::to_string(&entries)
            .map_err(|e| format!("spotlight_search encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "spotlight_search",
        description: "Search the whole Mac using Spotlight (mdfind). Returns paths, kind, and last-modified. Supports kind filters: pdf, image, app, email, folder, today, yesterday, thisweek.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
