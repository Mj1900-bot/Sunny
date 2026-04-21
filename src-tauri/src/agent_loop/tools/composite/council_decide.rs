//! Trait-registry adapter for `council_decide`.
//!
//! The composite implementation lives in
//! `agent_loop::council`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"question":{"type":"string","description":"The question for the council to decide."},"deadline_secs":{"type":"integer","minimum":30,"maximum":600,"description":"Overall wall-clock budget in seconds. Default 300 (5 min), max 600."}},"required":["question"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (question, deadline_secs) = crate::agent_loop::council::parse_input(&input)?;
        crate::agent_loop::council::council_decide(
            ctx.app,
            &question,
            deadline_secs,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "council_decide",
        description: "Convene a five-role council to answer a hard question and return a consensus. Spawns researcher + critic + skeptic concurrently (each ~60s), then a synthesizer that merges their outputs into a candidate (~60s), then an arbiter that picks the final answer (~45s). Total budget 5 min (configurable via deadline_secs, max 10 min). Emits `sunny://council.step` per phase. Use when Sunny asks for a reasoned verdict on a tricky call — architectural trade-offs, ambiguous factual questions, decisions with real counter-arguments — not for simple lookups that web_search handles. Returns the final answer with a trailing '— council consensus (confidence: X%)' line.",
        input_schema: SCHEMA,
        required_capabilities: &[],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
