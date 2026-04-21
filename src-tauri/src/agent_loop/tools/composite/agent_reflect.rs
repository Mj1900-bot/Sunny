//! Trait-registry adapter for `agent_reflect`.
//!
//! The composite implementation lives in
//! `agent_loop::reflect`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"window_size":{"type":"integer","minimum":1,"maximum":100,"description":"Number of most-recent agent_step + tool_usage rows to review. Default 20, hard cap 100."}}}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let window_size = crate::agent_loop::reflect::parse_input(&input)?;
        crate::agent_loop::reflect::agent_reflect(
            ctx.app,
            window_size,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "agent_reflect",
        description: "Run a self-reflection pass on SUNNY's recent behaviour. Pulls the last N agent_step episodic rows and tool_usage rows, hands them to a critic sub-agent, and writes 3-5 durable lessons to semantic memory tagged ['self-reflection','lesson',<severity>]. Not dangerous — only writes to memory. Intended to run on the weekly `agent-self-reflect` scheduler template, but safe to call on demand when Sunny asks SUNNY to 'reflect on how you've been doing' or 'review your recent mistakes'. Default window is 20 (max 100).",
        input_schema: SCHEMA,
        required_capabilities: &["memory.read", "memory.write"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
