//! Trait-registry adapter for `reflexion_answer`.
//!
//! The composite implementation lives in
//! `agent_loop::reflexion`. This module wires it into the
//! `inventory::submit!` registry so `dispatch.rs` no longer needs a
//! match arm for it.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const SCHEMA: &str = r#"{"type":"object","properties":{"question":{"type":"string","description":"The question to answer via iterative self-critique."},"max_iterations":{"type":"integer","minimum":1,"maximum":5,"description":"Hard cap on critique→refine rounds. Default 3, max 5."},"consensus_threshold":{"type":"number","minimum":0.0,"maximum":1.0,"description":"Critic score at which to accept the draft and return early. Default 0.8."}},"required":["question"]}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (question, max_iter, threshold) =
            crate::agent_loop::reflexion::parse_input(&input)?;
        crate::agent_loop::reflexion::reflexion_answer(
            ctx.app,
            &question,
            max_iter,
            threshold,
            ctx.session_id,
            ctx.depth,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "reflexion_answer",
        description: "Answer a question using the Reflexion pattern (Shinn et al. 2023): a generator sub-agent (creative style) drafts an answer, a critic sub-agent (conservative style) scores it 0-1 and returns structured JSON issues + suggestions, and a refiner sub-agent (pragmatic style) rewrites the draft. Loop until the critic's score >= consensus_threshold OR max_iterations elapses. Distinct from spawn_subagent (single delegation) and from council-style voting (this is convergence via iterative critique, not a majority vote). Use when Sunny asks for a well-reasoned answer to a single question and is willing to trade latency for quality — \"think harder about X\", \"reflect on Y and give me your best answer\", \"iterate on this question until you're confident\". Emits `sunny://reflexion.step` per phase. 180 s total budget, 60 s per iteration.",
        input_schema: SCHEMA,
        required_capabilities: &[],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
