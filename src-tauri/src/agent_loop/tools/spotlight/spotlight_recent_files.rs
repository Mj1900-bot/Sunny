//! `spotlight_recent_files` — L0 read.
//! Returns files modified within `hours` hours, optionally filtered by kind.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["spotlight.search"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "hours": { "type": "integer", "description": "Look-back window in hours (default 24)." },
    "kind":  { "type": "string",  "description": "Optional kind filter: pdf, image, app, folder." },
    "limit": { "type": "integer", "description": "Max results (default 20, max 200)." }
  }
}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let hours = input
            .get("hours")
            .and_then(|v| v.as_u64())
            .unwrap_or(24)
            .min(8760); // cap at 1 year
        let kind = optional_string_arg(&input, "kind");
        let limit = usize_arg(&input, "limit").unwrap_or(20).min(200);

        let predicate = super::mdfind::build_recency_query(hours, kind.as_deref());
        let entries = super::mdfind::run_mdfind(&predicate, limit).await?;
        serde_json::to_string(&entries)
            .map_err(|e| format!("spotlight_recent_files encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "spotlight_recent_files",
        description: "Return files modified within the last N hours (default 24). Optionally filter by kind: pdf, image, app, folder.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
