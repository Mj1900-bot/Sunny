//! Trait-registry adapter for `plan_execute`.
//!
//! The composite implementation lives in
//! `agent_loop::plan_execute`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"goal":{"type":"string","description":"The compound task to decompose and execute. Plain English."},"max_steps":{"type":"integer","description":"Max steps the planner may emit (default 8, hard cap 15)."}},"required":["goal"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (goal, max_steps) = crate::agent_loop::plan_execute::parse_input(&input)?;
        crate::agent_loop::plan_execute::plan_execute(
            ctx.app,
            &goal,
            max_steps,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "plan_execute",
        description: "Decompose a multi-step goal into numbered steps (via a planner sub-agent), then execute each step sequentially with checkpoints between them. Use when Sunny gives a compound task that reasonably breaks into ordered sub-tasks, each using ONE tool: \"set up a new coding project: create folder, init git, write a starter README, add .gitignore\", \"draft three notes and schedule a follow-up reminder\", \"research X then write a summary note\". Distinct from deep_research (parallel web research fan-out) and spawn_subagent (single delegation). The composite emits `sunny://plan-execute.step` events per step. If any step fails, a recovery planner decides CONTINUE or ABORT. Each step's tools are individually gated by ConfirmGate as usual — nothing here bypasses confirmation. Returns a markdown report of every step's outcome.",
        input_schema: SCHEMA,
        required_capabilities: &[],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
