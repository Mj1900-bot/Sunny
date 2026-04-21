//! `web_extract_links` — fetch a URL and return its outbound links.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["web:fetch"];

const SCHEMA: &str = r#"{"type":"object","properties":{"url":{"type":"string"},"max_links":{"type":"integer"}},"required":["url"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let url = string_arg(&input, "url")?;
        let max_links = usize_arg(&input, "max_links");
        crate::tools_web::web_extract_links(url, max_links).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "web_extract_links",
        description: "Fetch a URL and return its outbound links.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
