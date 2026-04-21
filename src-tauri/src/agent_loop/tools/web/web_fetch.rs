//! `web_fetch` — fetch a URL and return readable text content.
//!
//! Migrated off `dispatch.rs`'s god-match in sprint-12. The underlying
//! implementation still lives in `crate::tools_web`; this file owns
//! the spec + arg parsing + the post-fetch ingress scrub that the
//! legacy dispatcher used to perform inline.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{string_arg, usize_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::security;

const CAPS: &[&str] = &["web:fetch"];

const SCHEMA: &str = r#"{"type":"object","properties":{"url":{"type":"string"},"max_chars":{"type":"integer"}},"required":["url"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let url = string_arg(&input, "url")?;
        let max_chars = usize_arg(&input, "max_chars");
        let result = crate::tools_web::web_fetch(url.clone(), max_chars).await;
        // Ingress scan on the fetched body BEFORE it enters the LLM
        // context. Only on success — failure paths carry no attacker
        // content.
        if let Ok(body) = &result {
            let host = security::url_host(&url);
            let source = format!("web_fetch:{host}");
            security::ingress::inspect(&source, body);
        }
        result.map(|body| security::ingress::scrub_for_context(&body))
    })
}

inventory::submit! {
    ToolSpec {
        name: "web_fetch",
        description: "Fetch a URL and return readable text content.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
