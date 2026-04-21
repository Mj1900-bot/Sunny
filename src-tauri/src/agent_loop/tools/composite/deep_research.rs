//! Trait-registry adapter for `deep_research`.
//!
//! The composite implementation lives in
//! `agent_loop::deep_research`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"question":{"type":"string","description":"The research question to investigate."},"max_workers":{"type":"integer","description":"Max parallel researcher sub-agents (default 5, hard cap 8)."},"depth_budget":{"type":"integer","description":"Per-worker ReAct iteration budget (default 8, max 12)."}},"required":["question"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (question, max_workers, depth_budget) =
            crate::agent_loop::deep_research::parse_input(&input)?;
        crate::agent_loop::deep_research::deep_research(
            ctx.app,
            &question,
            max_workers,
            depth_budget,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "deep_research",
        description: "Plan and run a deep, multi-source web research task. Internally spawns a planner sub-agent to break the question into 3-8 sub-questions, runs one researcher sub-agent per sub-question in parallel (each with its own web_search / web_fetch ReAct loop), then aggregates the worker outputs into a prose report with inline [src-N] citations and a trailing ## Sources table. Use this when Sunny asks to \"research X\", \"compare the top N <thing>\", \"find pricing and features for <product category>\", \"deep dive on <topic>\", or any question that clearly requires multiple live web lookups stitched together rather than a single web_search. When to use deep_research vs web_search: if the user asks to COMPARE multiple options, CITE sources, or RESEARCH a topic with depth — use deep_research. If they just want a single fact or latest headline — use web_search. Wall-clock budget: 15 min total, 5 min per worker, max 8 workers. Returns a plain-text report suitable to speak or save to a note.",
        input_schema: SCHEMA,
        required_capabilities: &["web:search", "web:fetch"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
