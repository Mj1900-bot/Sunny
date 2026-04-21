//! `notes_search` — search Apple Notes.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{string_arg, u32_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["macos.notes"];

const SCHEMA: &str = r#"{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let query = string_arg(&input, "query")?;
        let limit = u32_arg(&input, "limit");
        crate::tools_macos::notes_search(query, limit).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "notes_search",
        description: "USE THIS when Sunny says 'find my note about X', 'what did I write down about Y', 'do I have notes on Z', 'pull up my notes on X'. Returns matching Apple Notes (title, folder, snippet) from Sunny's Notes.app.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
