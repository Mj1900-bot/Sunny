//! `persona_update_heartbeat` — rewrite the autogen block of
//! ~/.sunny/HEARTBEAT.md. DANGEROUS.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["persona.write"];

const SCHEMA: &str = r#"{"type":"object","properties":{"body":{"type":"string","description":"Three paragraphs — TONE, FOCUS, NOTES — in markdown. No fences; will be inserted verbatim between the autogen markers."}},"required":["body"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let body = string_arg(&input, "body")?;
        crate::agent_loop::persona::update_heartbeat(&body).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "persona_update_heartbeat",
        description: "DANGEROUS — rewrites the autogen block of ~/.sunny/HEARTBEAT.md with a fresh TONE / FOCUS / NOTES triplet. Intended for the nightly `heartbeat-refresh` scheduler job; reserved for that context. Replaces the text between `<!-- heartbeat:autogen:begin -->` and `<!-- heartbeat:autogen:end -->` markers only; the static architecture sections above remain untouched. Always confirms before writing.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
